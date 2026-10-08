use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT_PTY_RUN: AtomicU64 = AtomicU64::new(1);

use tauri::{Emitter, Manager};

use crate::{
    cli_detect::resolve_command_path,
    state::{
        PtyChildHandle, PtyKillerMap, PtyMasterMap, PtySessionMeta, PtySessionMetaMap, PtyWriterMap,
    },
    util::{expand_path, home_dir, resolve_windows_pty_command},
};

// ── Helper: access PTY state through AppHandle ────────────────────

fn pty_writer_map(app: &tauri::AppHandle) -> PtyWriterMap {
    app.state::<PtyWriterMap>().inner().clone()
}

fn pty_killer_map(app: &tauri::AppHandle) -> PtyKillerMap {
    app.state::<PtyKillerMap>().inner().clone()
}

fn pty_master_map(app: &tauri::AppHandle) -> PtyMasterMap {
    app.state::<PtyMasterMap>().inner().clone()
}

fn pty_session_meta_map(app: &tauri::AppHandle) -> PtySessionMetaMap {
    app.state::<PtySessionMetaMap>().inner().clone()
}

// ── PTY output state machine ─────────────────────────────────────

/// Visible PTY text state used to detect whether the CLI is waiting or running.
struct AnsiStripper {
    state: u8, // 0=normal, 1=ESC, 2=CSI
    window: Vec<u8>,
}

impl AnsiStripper {
    fn new() -> Self {
        Self {
            state: 0,
            window: Vec::with_capacity(256),
        }
    }

    fn feed(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            match self.state {
                0 => {
                    if byte == 0x1b {
                        self.state = 1;
                    } else if byte >= 0x20 || byte == b'\r' || byte == b'\n' {
                        self.window.push(byte);
                        if self.window.len() > 256 {
                            self.window.drain(..128);
                        }
                    }
                }
                1 => {
                    self.state = if byte == b'[' { 2 } else { 0 };
                }
                2 => {
                    if byte >= 0x40 && byte <= 0x7e {
                        self.state = 0;
                    }
                }
                _ => {
                    self.state = 0;
                }
            }
        }
    }

    fn visible(&self) -> &[u8] {
        &self.window
    }

    fn clear(&mut self) {
        self.window.clear();
    }
}

/// Whether this Codex binary accepts `--no-daemon` (cached per resolved path).
fn codex_supports_no_daemon(command: &str) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(&known) = cache.lock().unwrap().get(command) {
        return known;
    }
    let (bin, args) = resolve_windows_pty_command(command, &["--help".to_string()]);
    let supported = crate::util::background_command(&bin)
        .args(&args)
        .stdin(std::process::Stdio::null())
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).contains("--no-daemon"))
        .unwrap_or(false);
    cache.lock().unwrap().insert(command.to_string(), supported);
    supported
}

// ── Tauri Commands ────────────────────────────────────────────────

/// Start a PTY session.
#[tauri::command]
pub async fn start_pty_session(
    app: tauri::AppHandle,
    session_id: String,
    workdir: String,
    command: String,
    args: Vec<String>,
    initial_prompt: Option<String>,
    cols: u16,
    rows: u16,
    env: Option<Vec<(String, String)>>,
) -> Result<(), String> {
    use base64::Engine;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    let _launch_guard = crate::cli_updates::launch_guard()?;
    let notification_prompt = initial_prompt.clone();

    let expanded = expand_path(&workdir);
    let project_path = env
        .as_ref()
        .and_then(|pairs| {
            pairs
                .iter()
                .find(|(key, _)| key == "AGENTDECK_PROJECT_ROOT")
                .map(|(_, value)| value.clone())
        })
        .unwrap_or_else(|| expanded.clone());
    let runner_type = env
        .as_ref()
        .and_then(|pairs| {
            pairs
                .iter()
                .find(|(k, _)| k == "AGENTDECK_RUNNER_TYPE")
                .map(|(_, v)| v.clone())
        })
        .unwrap_or_else(|| {
            std::path::Path::new(&command)
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| match name {
                    "claude" => "claude-code",
                    "codex" => "codex",
                    other => other,
                })
                .unwrap_or_default()
                .to_string()
        });

    let mut args = args;
    if matches!(runner_type.as_str(), "claude-code" | "codex" | "gemini")
        && !env.as_ref().is_some_and(|pairs| {
            pairs.iter().any(|(key, value)| {
                key == "AGENTDECK_PROVIDER_SESSION_ID" && !value.trim().is_empty()
            })
        })
    {
        crate::memory_runtime::reset(&app, &project_path, &session_id, &runner_type);
    }
    if runner_type == "claude-code" {
        crate::provider_usage::apply_claude_statusline(&command, &expanded, &mut args);
    }
    // Codex ≥0.15x routes the TUI through a shared app-server daemon. AgentDeck owns the
    // process lifecycle itself, and a broken daemon install makes every chat fail, so run
    // Codex in-process whenever the installed version understands the flag.
    if runner_type == "codex"
        && !args.iter().any(|a| a == "--no-daemon")
        && codex_supports_no_daemon(&resolve_command_path(&command))
    {
        args.push("--no-daemon".to_string());
    }
    let economy = crate::token_economy::prepare_launch(
        &app,
        &runner_type,
        &expanded,
        &command,
        &session_id,
        &mut args,
    );
    let memory_launch = crate::memory_runtime::configure_launch(
        &app,
        &project_path,
        &session_id,
        &runner_type,
        &mut args,
    )
    .unwrap_or_else(|error| {
        let _ = app.emit(
            "shared-memory-error",
            serde_json::json!({"sessionId":session_id,"error":error}),
        );
        Default::default()
    });
    let mut turn_memory = None;
    let mut delivered_guidance = false;
    if let Some(mut prompt) = initial_prompt.filter(|p| !p.trim().is_empty()) {
        let handle = app.clone();
        let search = prompt.clone();
        let (memory_project, memory_session, memory_provider) = (
            project_path.clone(),
            session_id.clone(),
            runner_type.clone(),
        );
        turn_memory = tauri::async_runtime::spawn_blocking(move || {
            crate::memory_runtime::prepare_or_report(
                &handle,
                &memory_project,
                &memory_session,
                &memory_provider,
                &search,
            )
        })
        .await
        .ok()
        .flatten();
        let context = turn_memory
            .as_ref()
            .map(|memory| memory.text.as_str())
            .unwrap_or("");
        delivered_guidance = !economy.guidance.is_empty() && !prompt.trim_start().starts_with('/');
        crate::token_economy::append_guidance(&mut prompt, &economy.guidance);
        if runner_type == "gemini" {
            args.push("--prompt-interactive".to_string());
        }
        args.push(format!("{prompt}{context}"));
    }

    // Stop any existing PTY for this session first.
    {
        let km = pty_killer_map(&app);
        let mut km = km.lock().unwrap();
        if let Some(mut old) = km.remove(&session_id) {
            terminate_child(&mut old);
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| crate::i18n::interface_text(&app, "native.ptyOpen", &e.to_string()))?;

    let resolved_command = resolve_command_path(&command);
    let (launch_command, launch_args) = resolve_windows_pty_command(&resolved_command, &args);

    let mut cmd = if cfg!(windows)
        && std::path::Path::new(&launch_command)
            .extension()
            .and_then(|s| s.to_str())
            .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "cmd" | "bat"))
            .unwrap_or(false)
    {
        let mut builder = CommandBuilder::new("cmd.exe");
        builder.arg("/d");
        builder.arg("/c");
        builder.arg(&launch_command);
        for arg in &launch_args {
            builder.arg(arg);
        }
        builder
    } else {
        let mut builder = CommandBuilder::new(&launch_command);
        for arg in &launch_args {
            builder.arg(arg);
        }
        builder
    };
    for key in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GEMINI_BASE_URL",
    ] {
        cmd.env_remove(key);
    }
    cmd.cwd(&expanded);

    // Inherit the base environment variables.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let agentdeck_tmp = crate::util::agentdeck_tmp_dir()
        .to_string_lossy()
        .to_string();
    cmd.env("TMPDIR", &agentdeck_tmp);
    cmd.env("TEMP", &agentdeck_tmp);
    cmd.env("TMP", &agentdeck_tmp);
    if let Some(home) = home_dir() {
        cmd.env("HOME", home.to_string_lossy().to_string());
        #[cfg(windows)]
        cmd.env("USERPROFILE", home.to_string_lossy().to_string());
    }

    // Extend the child process PATH with Node's directory for Claude, Codex, and other Node.js scripts.
    {
        let base_path = std::env::var("PATH").unwrap_or_default();
        let node_path = resolve_command_path("node");
        let node_dir = if std::path::Path::new(&node_path).parent().is_some() {
            std::path::Path::new(&node_path)
                .parent()
                .map(|d| d.to_string_lossy().to_string())
        } else {
            None
        };
        let sep = if cfg!(windows) { ';' } else { ':' };
        let enriched_path = match node_dir {
            Some(dir) if !base_path.split(sep).any(|s| s == dir) => {
                format!("{dir}{sep}{base_path}")
            }
            _ => base_path,
        };
        let rtk_path = economy
            .env
            .iter()
            .find(|(key, _)| key == "AGENTDECK_RTK_PATH")
            .map(|(_, value)| value.as_str());
        cmd.env(
            "PATH",
            crate::token_economy::enrich_path(&enriched_path, rtk_path),
        );
    }

    // Add the caller's extra environment variables.
    if let Some(extra_env) = env {
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
    }
    for (key, value) in economy.env {
        cmd.env(key, value);
    }
    for (key, value) in memory_launch.env {
        cmd.env(key, value);
    }

    let mut master_reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| crate::i18n::interface_text(&app, "native.ptyRead", &e.to_string()))?;

    let master_writer = pair
        .master
        .take_writer()
        .map_err(|e| crate::i18n::interface_text(&app, "native.ptyWrite", &e.to_string()))?;

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| crate::i18n::interface_text(&app, "native.ptyStart", &e.to_string()))?;

    let pid = child.process_id();
    if delivered_guidance {
        crate::token_economy::mark_guidance_delivered(&runner_type, &session_id);
    }
    if let Some(memory) = &turn_memory {
        crate::memory_runtime::mark_delivered(&app, memory);
    }
    let run_id = NEXT_PTY_RUN.fetch_add(1, Ordering::Relaxed);

    // Save the writer, child, and master handles.
    {
        let wm = pty_writer_map(&app);
        let mut wm = wm.lock().unwrap();
        wm.insert(session_id.clone(), master_writer);
    }
    {
        let km = pty_killer_map(&app);
        let mut km = km.lock().unwrap();
        km.insert(
            session_id.clone(),
            PtyChildHandle {
                killer: child.clone_killer(),
                pid,
                run_id,
            },
        );
    }
    {
        let mm = pty_master_map(&app);
        let mut mm = mm.lock().unwrap();
        mm.insert(session_id.clone(), pair.master);
    }
    {
        let meta_map = pty_session_meta_map(&app);
        let mut meta_map = meta_map.lock().unwrap();
        meta_map.insert(
            session_id.clone(),
            PtySessionMeta {
                runner_type,
                workdir: expanded.clone(),
                project_path,
            },
        );
    }

    crate::notification::completion::reset_terminal(&session_id, notification_prompt.as_deref());
    // Reader thread: forward PTY output and detect state transitions.
    let _ = app.emit("pty-started", serde_json::json!({ "session_id": session_id, "pid": pid, "command": resolved_command, "workdir": expanded }));
    let app_r = app.clone();
    let sid_r = session_id.clone();
    let killer_map_r = pty_killer_map(&app);
    let (output_finished, output_drained) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut stripper = AnsiStripper::new();
        // 0 = unknown, 1 = running, 2 = waiting
        let mut last_status: u8 = 0;

        loop {
            match master_reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if killer_map_r
                        .lock()
                        .unwrap()
                        .get(&sid_r)
                        .is_some_and(|entry| entry.run_id != run_id)
                    {
                        continue;
                    }
                    // Forward the raw data encoded as base64.
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app_r.emit(
                        "pty-data",
                        serde_json::json!({ "session_id": sid_r, "data": b64 }),
                    );

                    // Detect CLI state transitions.
                    stripper.feed(&buf[..n]);
                    let win_str = String::from_utf8_lossy(stripper.visible());
                    let new_status = if win_str.contains("? for shortcuts") {
                        2u8 // waiting
                    } else if win_str.contains("esc to interrupt") {
                        1u8 // running
                    } else {
                        0u8
                    };

                    if new_status != 0 && new_status != last_status {
                        last_status = new_status;
                        stripper.clear();
                        let event = if new_status == 2 {
                            "pty-waiting"
                        } else {
                            "pty-running"
                        };
                        let _ = app_r.emit(event, serde_json::json!({ "session_id": sid_r }));
                    }
                }
            }
        }

        let _ = output_finished.send(());
    });

    // Wait independently of the output pipe: Windows ConPTY keeps that pipe open until its master closes.
    let app_wait = app.clone();
    std::thread::spawn(move || {
        let exit_code = child.wait().ok().map(|status| status.exit_code());
        let killers = pty_killer_map(&app_wait);
        let mut killers = killers.lock().unwrap();
        if !killers
            .get(&session_id)
            .is_some_and(|entry| entry.run_id == run_id)
        {
            return;
        }
        killers.remove(&session_id);
        crate::notification::completion::forget_terminal(&session_id);
        let writer = pty_writer_map(&app_wait)
            .lock()
            .unwrap()
            .remove(&session_id);
        pty_session_meta_map(&app_wait)
            .lock()
            .unwrap()
            .remove(&session_id);
        let master = pty_master_map(&app_wait)
            .lock()
            .unwrap()
            .remove(&session_id);
        drop(killers);
        // Closing ConPTY can wait for its reader; never hold the process lock here.
        drop(writer);
        drop(master);
        let _ = output_drained.recv_timeout(std::time::Duration::from_secs(1));
        let killers = pty_killer_map(&app_wait);
        let killers = killers.lock().unwrap();
        if killers.contains_key(&session_id) {
            return;
        }
        let _ = app_wait.emit("pty-exit", serde_json::json!({ "session_id": session_id, "exit_code": exit_code, "stopped": false }));
    });

    Ok(())
}

/// Write keyboard input to the PTY from base64-encoded data.
#[tauri::command]
pub fn write_pty(app: tauri::AppHandle, session_id: String, data: String) -> Result<(), String> {
    use base64::Engine;
    let wm = pty_writer_map(&app);
    let mut wm = wm.lock().unwrap();
    if let Some(writer) = wm.get_mut(&session_id) {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&data)
            .map_err(|e| crate::i18n::interface_text(&app, "native.ptyDecode", &e.to_string()))?;
        writer
            .write_all(&bytes)
            .map_err(|e| crate::i18n::interface_text(&app, "native.ptyWrite", &e.to_string()))?;
    } else {
        return Err(crate::i18n::interface_text(&app, "native.ptyMissing", ""));
    }
    Ok(())
}

/// Write a text line to the PTY, appending a newline to execute it.
#[tauri::command]
pub async fn send_pty_query(
    app: tauri::AppHandle,
    session_id: String,
    query: String,
) -> Result<(), String> {
    let notification_prompt = query.clone();
    let metadata = pty_session_meta_map(&app)
        .lock()
        .ok()
        .and_then(|metadata| metadata.get(&session_id).cloned())
        .unwrap_or_default();
    let provider = metadata.runner_type;
    let app_for_search = app.clone();
    let (query_for_search, memory_session, memory_provider) =
        (query.clone(), session_id.clone(), provider.clone());
    let memory = tauri::async_runtime::spawn_blocking(move || {
        crate::memory_runtime::prepare_or_report(
            &app_for_search,
            &metadata.project_path,
            &memory_session,
            &memory_provider,
            &query_for_search,
        )
    })
    .await
    .ok()
    .flatten();
    let context = memory
        .as_ref()
        .map(|memory| memory.text.as_str())
        .unwrap_or("");
    let mut query = query;
    crate::token_economy::reset_after_compaction(&provider, &session_id, &query);
    let guidance = crate::token_economy::followup_guidance(&app, &provider, &session_id);
    let delivered_guidance = !guidance.is_empty() && !query.trim_start().starts_with('/');
    crate::token_economy::append_guidance(&mut query, &guidance);
    let wm = pty_writer_map(&app);
    let mut wm = wm.lock().unwrap();
    if let Some(writer) = wm.get_mut(&session_id) {
        // Bracketed paste preserves multiline prompts without executing each line.
        let text = format!("{query}{context}");
        let mut data = if text.contains('\n') {
            format!("\x1b[200~{text}\x1b[201~").into_bytes()
        } else {
            text.into_bytes()
        };
        data.push(if cfg!(windows) { b'\r' } else { b'\n' });
        writer
            .write_all(&data)
            .map_err(|e| crate::i18n::interface_text(&app, "native.ptyWrite", &e.to_string()))?;
        writer
            .flush()
            .map_err(|e| crate::i18n::interface_text(&app, "native.ptyWrite", &e.to_string()))?;
        crate::notification::completion::begin_terminal(&session_id, Some(&notification_prompt));
        if delivered_guidance {
            crate::token_economy::mark_guidance_delivered(&provider, &session_id);
        }
        if let Some(memory) = &memory {
            crate::memory_runtime::mark_delivered(&app, memory);
        }
        Ok(())
    } else {
        Err(crate::i18n::interface_text(&app, "native.ptyMissing", ""))
    }
}

/// Resize the PTY, enforcing at least 20 columns and 5 rows to prevent SIGWINCH issues.
#[tauri::command]
pub fn resize_pty(
    app: tauri::AppHandle,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    use portable_pty::PtySize;
    let cols = cols.max(20);
    let rows = rows.max(5);
    let mm = pty_master_map(&app);
    let mm = mm.lock().unwrap();
    if let Some(master) = mm.get(&session_id) {
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| crate::i18n::interface_text(&app, "native.ptyResize", &e.to_string()))?;
    }
    Ok(())
}

/// Stop a PTY session.
#[tauri::command]
pub fn stop_pty_session(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    crate::notification::completion::stop_terminal(&session_id);
    let mut had_session = false;
    {
        let km = pty_killer_map(&app);
        let mut km = km.lock().unwrap();
        if let Some(mut child) = km.remove(&session_id) {
            had_session = true;
            terminate_child(&mut child);
        }
    }
    {
        let wm = pty_writer_map(&app);
        let mut wm = wm.lock().unwrap();
        if wm.remove(&session_id).is_some() {
            had_session = true;
        }
    }
    {
        let mm = pty_master_map(&app);
        let mut mm = mm.lock().unwrap();
        if mm.remove(&session_id).is_some() {
            had_session = true;
        }
    }
    {
        let meta_map = pty_session_meta_map(&app);
        let mut meta_map = meta_map.lock().unwrap();
        if meta_map.remove(&session_id).is_some() {
            had_session = true;
        }
    }
    if had_session {
        let _ = app.emit(
            "pty-exit",
            serde_json::json!({ "session_id": session_id, "stopped": true }),
        );
    }
    crate::notification::completion::forget_terminal(&session_id);
    Ok(())
}

fn terminate_child(child: &mut PtyChildHandle) {
    #[cfg(windows)]
    if let Some(pid) = child.pid {
        let _ = crate::util::background_command("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
    let _ = child.killer.kill();
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn windows_pty_preserves_output_exit_code_and_paths_with_spaces() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let workdir =
            std::env::temp_dir().join(format!("Agentdeck PTY test {}", std::process::id()));
        std::fs::create_dir_all(&workdir).unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("cmd.exe");
        command.args(["/d", "/c", "echo AGENTDECK_PTY_OK & exit /b 7"]);
        command.cwd(&workdir);
        let mut child = pair.slave.spawn_command(command).unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        drop(pair.slave);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut output = String::new();
            let _ = reader.read_to_string(&mut output);
            let _ = tx.send(output);
        });
        assert_eq!(child.wait().unwrap().exit_code(), 7);
        drop(pair.master);
        let output = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        assert!(output.contains("AGENTDECK_PTY_OK"), "{output:?}");
        std::fs::remove_dir(workdir).unwrap();
    }
}
