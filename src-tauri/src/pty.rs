use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
static NEXT_PTY_RUN: AtomicU64 = AtomicU64::new(1);
const PTY_BATCH_BYTES: usize = 64 * 1024;
const PTY_IN_FLIGHT_BYTES: u64 = 256 * 1024;
static PTY_OUTPUTS: OnceLock<Mutex<HashMap<String, Arc<PtyOutput>>>> = OnceLock::new();

struct PtyOutputState {
    written: u64,
    emitted: u64,
    acknowledged: u64,
    closed: bool,
    cancelled: bool,
    archive_only: bool,
}
struct PtyOutput {
    run_id: u64,
    path: PathBuf,
    state: Mutex<PtyOutputState>,
    file: Mutex<std::fs::File>,
    consumed: Condvar,
}
impl PtyOutput {
    fn new(run_id: u64) -> std::io::Result<Self> {
        let directory = crate::util::agentdeck_tmp_dir().join("pty-output");
        Self::new_in(run_id, &directory)
    }
    fn new_in(run_id: u64, directory: &std::path::Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(&directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
        }
        let path = directory.join(format!("{}-{run_id}.bin", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path)?;
        Ok(Self {
            run_id,
            path,
            file: Mutex::new(file),
            state: Mutex::new(PtyOutputState {
                written: 0,
                emitted: 0,
                acknowledged: 0,
                closed: false,
                cancelled: false,
                archive_only: false,
            }),
            consumed: Condvar::new(),
        })
    }
    fn append(&self, bytes: &[u8]) -> std::io::Result<u64> {
        let mut file = self.file.lock().unwrap();
        file.write_all(bytes)?;
        let mut state = self.state.lock().unwrap();
        let offset = state.written;
        state.written += bytes.len() as u64;
        Ok(offset)
    }
    fn reserve(&self, end: u64) -> Option<bool> {
        let mut state = self.state.lock().unwrap();
        while !state.cancelled
            && !state.archive_only
            && end.saturating_sub(state.acknowledged) > PTY_IN_FLIGHT_BYTES
        {
            state = self.consumed.wait(state).unwrap();
        }
        if state.cancelled {
            return None;
        }
        state.emitted = end;
        Some(!state.archive_only)
    }
    fn acknowledge(&self, end: u64) {
        let mut state = self.state.lock().unwrap();
        state.acknowledged = state.acknowledged.max(end.min(state.emitted));
        self.consumed.notify_all();
    }
    fn finish(&self, cancelled: bool) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        state.cancelled |= cancelled;
        self.consumed.notify_all();
    }
    fn drain_to_archive(&self) {
        let mut state = self.state.lock().unwrap();
        state.archive_only = true;
        self.consumed.notify_all();
    }
}
fn outputs() -> &'static Mutex<HashMap<String, Arc<PtyOutput>>> {
    PTY_OUTPUTS.get_or_init(Default::default)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutputPage {
    run_id: u64,
    data: String,
    next_offset: u64,
    end_offset: u64,
    closed: bool,
}
/// ACKs are tied to a process generation, so a late renderer cannot unblock a replacement run.
#[tauri::command]
pub fn ack_pty_output(session_id: String, run_id: u64, end_offset: u64) {
    if let Some(output) = outputs().lock().unwrap().get(&session_id).cloned() {
        if output.run_id == run_id {
            output.acknowledge(end_offset);
        }
    }
}
/// Replay consumes bounded chunks from the lossless archive rather than retaining hidden WebViews.
#[tauri::command]
pub async fn read_pty_output(
    session_id: String,
    offset: u64,
    max_bytes: Option<usize>,
) -> Result<Option<PtyOutputPage>, String> {
    let output = outputs().lock().unwrap().get(&session_id).cloned();
    let Some(output) = output else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let state = output.state.lock().unwrap();
        let end_offset = state.written;
        let closed = state.closed;
        drop(state);
        let offset = offset.min(end_offset);
        let count = (end_offset - offset).min(
            max_bytes
                .unwrap_or(PTY_BATCH_BYTES)
                .clamp(1, PTY_BATCH_BYTES) as u64,
        ) as usize;
        let mut file = std::fs::File::open(&output.path).map_err(|error| error.to_string())?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| error.to_string())?;
        let mut bytes = vec![0; count];
        file.read_exact(&mut bytes)
            .map_err(|error| error.to_string())?;
        Ok(Some(PtyOutputPage {
            run_id: output.run_id,
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
            next_offset: offset + count as u64,
            end_offset,
            closed,
        }))
    })
    .await
    .map_err(|error| error.to_string())?
}

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
        .env(
            "PATH",
            crate::platform::process_path(std::path::Path::new(&bin)),
        )
        .stdin(std::process::Stdio::null())
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).contains("--no-daemon"))
        .unwrap_or(false);
    cache.lock().unwrap().insert(command.to_string(), supported);
    supported
}

fn gemini_supports_session_id(command: &str) -> bool {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, bool>>> =
        std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(known) = cache
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(command)
        .copied()
    {
        return known;
    }
    let supported = crate::cli_updates::run_bounded(
        command,
        &["--help".into()],
        std::time::Duration::from_secs(8),
    )
    .is_ok_and(|help| help.contains("--session-id"));
    cache
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(command.into(), supported);
    supported
}

/// Bind only explicit native IDs. A cwd or `--resume latest` is not an identity.
fn gemini_session_id(args: &mut Vec<String>, supports_creation: bool) -> Option<String> {
    let valid = |value: &str| {
        !value.is_empty()
            && value.len() <= 180
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    let boundary = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    let options = &args[..boundary];
    for (index, arg) in options.iter().enumerate() {
        if arg == "--session-id" || arg.starts_with("--session-id=") {
            return arg
                .strip_prefix("--session-id=")
                .or_else(|| options.get(index + 1).map(String::as_str))
                .filter(|value| valid(value))
                .map(str::to_string);
        }
        if arg == "--resume"
            || arg == "-r"
            || arg.starts_with("--resume=")
            || (arg.starts_with("-r") && !arg.starts_with("--"))
        {
            let value = arg
                .strip_prefix("--resume=")
                .or_else(|| {
                    if arg.len() > 2 && arg.starts_with("-r") && !arg.starts_with("--") {
                        Some(arg[2..].trim_start_matches('='))
                    } else {
                        None
                    }
                })
                .or_else(|| options.get(index + 1).map(String::as_str))?;
            return (valid(value)
                && value != "latest"
                && !value.bytes().all(|b| b.is_ascii_digit()))
            .then(|| value.into());
        }
        if arg == "--session-file" || arg.starts_with("--session-file=") {
            return None;
        }
    }
    if !supports_creation {
        return None;
    }
    let id = uuid::Uuid::new_v4().to_string();
    args.splice(boundary..boundary, ["--session-id".into(), id.clone()]);
    Some(id)
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
    let gemini_native_id = if runner_type == "gemini" {
        let resolved = resolve_command_path(&command);
        let supported =
            tauri::async_runtime::spawn_blocking(move || gemini_supports_session_id(&resolved))
                .await
                .unwrap_or(false);
        gemini_session_id(&mut args, supported)
    } else {
        None
    };
    let (selected_model, selected_effort) = crate::multi_agent::selection(&runner_type, &args);
    let multi_agent = crate::multi_agent::prepare(
        &app,
        &runner_type,
        &resolve_command_path(&command),
        &expanded,
        selected_model.as_deref(),
        selected_effort.as_deref(),
    )
    .await?;
    let multi_agent_env = if let Some(profile) = &multi_agent {
        crate::multi_agent::configure(profile, &runner_type, &expanded, &mut args)?
    } else {
        Vec::new()
    };
    let mut multi_agent_guidance = multi_agent
        .as_ref()
        .map(|profile| crate::multi_agent::guidance(profile, &runner_type))
        .unwrap_or_else(|| {
            if matches!(runner_type.as_str(), "codex" | "claude-code")
                && env.as_ref().is_some_and(|pairs| {
                    pairs.iter().any(|(key, value)| {
                        key == "AGENTDECK_PROVIDER_SESSION_ID" && !value.trim().is_empty()
                    })
                })
            {
                crate::multi_agent_guidance::disabled_guidance().to_owned()
            } else {
                String::new()
            }
        });
    let multi_agent_guidance_delivered = !multi_agent_guidance.is_empty()
        && initial_prompt.as_ref().is_some_and(|prompt| {
            !prompt.trim().is_empty() && !prompt.trim_start().starts_with('/')
        });
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
        &expanded,
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
    match crate::multi_agent_terminal::configure(
        &runner_type,
        &resolve_command_path(&command),
        &expanded,
        &mut args,
        &multi_agent_guidance,
    )
    .await
    {
        // The process suffix survives native /clear and /compact, including
        // input typed directly into the terminal. Do not repeat it in prompts.
        Ok(true) => multi_agent_guidance.clear(),
        Err(error) if multi_agent.is_some() => return Err(error),
        // Disabling must not break older CLIs or custom native profiles. Keep
        // app-managed revocation pending if an additive suffix cannot be proven.
        _ => {}
    }
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
        crate::token_economy::append_guidance(&mut prompt, &multi_agent_guidance);
        if runner_type == "gemini" {
            args.push("--prompt-interactive".to_string());
        }
        args.push(format!("{prompt}{context}"));
    }

    // Stop any existing PTY for this session first.
    {
        let old = pty_killer_map(&app).lock().unwrap().remove(&session_id);
        if let Some(mut old) = old {
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
        let enriched_path = crate::platform::process_path(std::path::Path::new(&launch_command));
        let rtk_path = economy
            .env
            .iter()
            .find(|(key, _)| key == "AGENTDECK_RTK_PATH")
            .map(|(_, value)| value.as_str());
        cmd.env(
            "PATH",
            crate::token_economy::enrich_path(&enriched_path.to_string_lossy(), rtk_path),
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
    for (key, value) in multi_agent_env {
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

    let run_id = NEXT_PTY_RUN.fetch_add(1, Ordering::Relaxed);
    let output = Arc::new(PtyOutput::new(run_id).map_err(|error| {
        crate::i18n::interface_text(&app, "native.ptyWrite", &error.to_string())
    })?);
    if let Some(memory) = &turn_memory {
        crate::memory_runtime::validate_turn(&app, memory)?;
    }
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| crate::i18n::interface_text(&app, "native.ptyStart", &e.to_string()))?;

    let pid = child.process_id();
    if let Some(provider_session_id) = gemini_native_id {
        let _ = app.emit("provider-session-bound", serde_json::json!({
            "session_id": session_id, "runner_type": "gemini", "provider_session_id": provider_session_id,
        }));
    }
    if delivered_guidance {
        crate::token_economy::mark_guidance_delivered(&runner_type, &session_id);
    }
    if let Some(memory) = &turn_memory {
        crate::memory_runtime::mark_delivered(&app, memory);
    }
    if let Some(previous) = outputs()
        .lock()
        .unwrap()
        .insert(session_id.clone(), output.clone())
    {
        previous.finish(true);
    }

    // Save the writer, child, and master handles.
    {
        let wm = pty_writer_map(&app);
        let mut wm = wm.lock().unwrap();
        wm.insert(session_id.clone(), Arc::new(Mutex::new(master_writer)));
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
                multi_agent_guidance,
                multi_agent_guidance_delivered,
            },
        );
    }

    crate::notification::completion::reset_terminal(&session_id, notification_prompt.as_deref());
    // Reader thread: forward PTY output and detect state transitions.
    let _ = app.emit("pty-started", serde_json::json!({ "session_id": session_id, "run_id": run_id, "pid": pid, "command": resolved_command, "workdir": expanded }));
    let app_r = app.clone();
    let sid_r = session_id.clone();
    let killer_map_r = pty_killer_map(&app);
    let (output_finished, output_drained) = std::sync::mpsc::channel();
    // A small bounded channel and a credit window keep a noisy PTY from growing IPC queues.
    let (batches, incoming) = std::sync::mpsc::sync_channel::<(u64, Vec<u8>)>(4);
    let app_emit = app.clone();
    let sid_emit = session_id.clone();
    let output_emit = output.clone();
    std::thread::spawn(move || {
        use base64::Engine;
        let mut deferred: Option<(u64, Vec<u8>)> = None;
        while let Some((offset, mut bytes)) = deferred.take().or_else(|| incoming.recv().ok()) {
            let deadline = Instant::now() + Duration::from_millis(8);
            while bytes.len() < PTY_BATCH_BYTES {
                let Some(wait) = deadline.checked_duration_since(Instant::now()) else {
                    break;
                };
                match incoming.recv_timeout(wait) {
                    Ok(piece) if bytes.len() + piece.1.len() <= PTY_BATCH_BYTES => {
                        bytes.extend(piece.1)
                    }
                    Ok(piece) => {
                        deferred = Some(piece);
                        break;
                    }
                    Err(_) => break,
                }
            }
            let end_offset = offset + bytes.len() as u64;
            match output_emit.reserve(end_offset) {
                None => break,
                Some(false) => continue,
                Some(true) => {}
            }
            if app_emit.emit("pty-data", serde_json::json!({ "session_id": sid_emit, "run_id": run_id, "offset": offset, "end_offset": end_offset, "data": base64::engine::general_purpose::STANDARD.encode(bytes) })).is_err() {
                // The archive remains authoritative even when a window has closed.
                output_emit.acknowledge(end_offset);
            }
        }
    });
    let output_read = output.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 32768];
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
                    // Save raw bytes before dispatch. Hidden renderers can ACK without losing output.
                    let offset = match output_read.append(&buf[..n]) {
                        Ok(offset) => offset,
                        Err(error) => {
                            let _ = app_r.emit("pty-error", serde_json::json!({ "session_id": sid_r, "error": format!("Terminal output archive: {error}") }));
                            break;
                        }
                    };
                    if batches.send((offset, buf[..n].to_vec())).is_err() {
                        break;
                    }

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
                        let _ = app_r.emit(event, serde_json::json!({ "session_id": sid_r, "run_id": run_id, "source": "screen-heuristic" }));
                    }
                }
            }
        }

        output_read.finish(false);
        let _ = output_finished.send(());
    });

    // Wait independently of the output pipe: Windows ConPTY keeps that pipe open until its master closes.
    let app_wait = app.clone();
    let output_wait = output.clone();
    std::thread::spawn(move || {
        let exit_code = child.wait().ok().map(|status| status.exit_code());
        // A exited process must drain even when its renderer has gone away, before ConPTY closes.
        output_wait.drain_to_archive();
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
pub async fn write_pty(
    app: tauri::AppHandle,
    session_id: String,
    data: String,
) -> Result<(), String> {
    use base64::Engine;
    let writer = pty_writer_map(&app)
        .lock()
        .unwrap()
        .get(&session_id)
        .cloned();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| crate::i18n::interface_text(&app, "native.ptyDecode", &e.to_string()))?;
    let Some(writer) = writer else {
        return Err(crate::i18n::interface_text(&app, "native.ptyMissing", ""));
    };
    tauri::async_runtime::spawn_blocking(move || {
        writer
            .lock()
            .unwrap()
            .write_all(&bytes)
            .map_err(|e| crate::i18n::interface_text(&app, "native.ptyWrite", &e.to_string()))
    })
    .await
    .map_err(|error| error.to_string())?
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
    let resets_guidance = matches!(query.split_whitespace().next(), Some("/compact" | "/clear"));
    if resets_guidance {
        if let Ok(mut entries) = pty_session_meta_map(&app).lock() {
            if let Some(current) = entries.get_mut(&session_id) {
                current.multi_agent_guidance_delivered = false;
            }
        }
    }
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
    let deliver_multi_agent = !metadata.multi_agent_guidance_delivered
        && !metadata.multi_agent_guidance.is_empty()
        && !query.trim_start().starts_with('/');
    if deliver_multi_agent {
        crate::token_economy::append_guidance(&mut query, &metadata.multi_agent_guidance);
    }
    let writer = pty_writer_map(&app)
        .lock()
        .unwrap()
        .get(&session_id)
        .cloned();
    if let Some(writer) = writer {
        // Bracketed paste preserves multiline prompts without executing each line.
        let text = format!("{query}{context}");
        let mut data = if text.contains('\n') {
            format!("\x1b[200~{text}\x1b[201~").into_bytes()
        } else {
            text.into_bytes()
        };
        data.push(if cfg!(windows) { b'\r' } else { b'\n' });
        let writer_app = app.clone();
        let writer_memory = memory.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut writer = writer.lock().unwrap();
            if let Some(memory) = &writer_memory {
                crate::memory_runtime::validate_turn(&writer_app, memory)?;
            }
            writer
                .write_all(&data)
                .and_then(|_| writer.flush())
                .map_err(|e| {
                    crate::i18n::interface_text(&writer_app, "native.ptyWrite", &e.to_string())
                })
        })
        .await
        .map_err(|error| error.to_string())??;
        crate::notification::completion::begin_terminal(&session_id, Some(&notification_prompt));
        if deliver_multi_agent {
            if let Ok(mut entries) = pty_session_meta_map(&app).lock() {
                if let Some(current) = entries.get_mut(&session_id) {
                    current.multi_agent_guidance_delivered = true;
                }
            }
        }
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
pub async fn stop_pty_session(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_pty_session_inner(app, session_id))
        .await
        .map_err(|error| error.to_string())?
}
pub(crate) fn stop_pty_session_inner(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<(), String> {
    crate::notification::completion::stop_terminal(&session_id);
    if let Some(output) = outputs().lock().unwrap().get(&session_id).cloned() {
        output.finish(true);
    }
    let mut had_session = false;
    {
        let child = pty_killer_map(&app).lock().unwrap().remove(&session_id);
        if let Some(mut child) = child {
            had_session = true;
            terminate_child(&mut child);
        }
    }
    {
        let writer = pty_writer_map(&app).lock().unwrap().remove(&session_id);
        if writer.is_some() {
            had_session = true;
        }
        drop(writer);
    }
    {
        let master = pty_master_map(&app).lock().unwrap().remove(&session_id);
        if master.is_some() {
            had_session = true;
        }
        drop(master);
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
    #[cfg(unix)]
    if let Some(pid) = child.pid {
        // portable-pty starts a new session. Stop its process group, including
        // package scripts and agent tools, before closing the terminal.
        let _ = crate::util::background_command("/bin/kill")
            .args(["-TERM", "--", &format!("-{pid}")])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    let _ = child.killer.kill();
}

#[cfg(test)]
mod flow_tests {
    use super::*;
    #[test]
    fn output_archive_keeps_split_utf8_ansi_bytes_and_bounds_credit() {
        let directory =
            std::env::temp_dir().join(format!("agentdeck-pty-flow-{}", uuid::Uuid::new_v4()));
        let output = Arc::new(PtyOutput::new_in(77, &directory).unwrap());
        let text = "\x1b[32mcafé 👩‍💻\x1b[0m\r\n".repeat(600_000);
        let bytes = text.as_bytes();
        for (i, chunk) in bytes.chunks(4093).enumerate() {
            assert_eq!(output.append(chunk).unwrap(), (i * 4093) as u64);
        }
        assert_eq!(std::fs::read(&output.path).unwrap(), bytes);
        assert_eq!(output.reserve(PTY_IN_FLIGHT_BYTES), Some(true));
        let (done, finished) = std::sync::mpsc::channel();
        let worker = output.clone();
        let thread = std::thread::spawn(move || {
            done.send(worker.reserve(PTY_IN_FLIGHT_BYTES + PTY_BATCH_BYTES as u64))
                .unwrap()
        });
        assert!(finished.recv_timeout(Duration::from_millis(30)).is_err());
        output.acknowledge(PTY_BATCH_BYTES as u64);
        assert_eq!(
            finished.recv_timeout(Duration::from_secs(1)).unwrap(),
            Some(true)
        );
        thread.join().unwrap();
        output.finish(true);
        assert_eq!(output.reserve(999_999), None);
        drop(output);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn process_exit_wakes_backpressure_and_drains_without_more_ipc() {
        let directory =
            std::env::temp_dir().join(format!("agentdeck-pty-drain-{}", uuid::Uuid::new_v4()));
        let output = Arc::new(PtyOutput::new_in(88, &directory).unwrap());
        let (done, finished) = std::sync::mpsc::channel();
        let worker = output.clone();
        let thread =
            std::thread::spawn(move || done.send(worker.reserve(PTY_IN_FLIGHT_BYTES + 1)).unwrap());
        assert!(finished.recv_timeout(Duration::from_millis(30)).is_err());
        output.drain_to_archive();
        assert_eq!(
            finished.recv_timeout(Duration::from_secs(1)).unwrap(),
            Some(false)
        );
        thread.join().unwrap();
        drop(output);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[cfg(all(test, unix))]
mod unix_tests {
    use std::io::Read;
    #[test]
    fn unix_pty_preserves_utf8_exit_code_and_paths_with_spaces() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let workdir =
            std::env::temp_dir().join(format!("Agentdeck PTY café {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workdir).unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "printf 'AGENTDECK_PTY_OK café\\n'; exit 7"]);
        command.cwd(&workdir);
        let mut child = pair.slave.spawn_command(command).unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        drop(pair.slave);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = reader.read_to_end(&mut bytes);
            let _ = tx.send(bytes);
        });
        assert_eq!(child.wait().unwrap().exit_code(), 7);
        drop(pair.master);
        let output =
            String::from_utf8(rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap())
                .unwrap();
        assert!(output.contains("AGENTDECK_PTY_OK café"), "{output:?}");
        std::fs::remove_dir(workdir).unwrap();
    }
}

#[cfg(test)]
mod gemini_binding_tests {
    use super::gemini_session_id;

    #[test]
    fn literal_prompt_after_the_options_boundary_is_preserved_and_never_bound_as_an_id() {
        let mut args: Vec<String> = [
            "--model",
            "gemini-test",
            "--",
            "--resume",
            "literal-id",
            "--session-id=literal-prompt",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        let original = args.clone();
        assert!(gemini_session_id(&mut args, false).is_none());
        assert_eq!(args, original);
        let id = gemini_session_id(&mut args, true).unwrap();
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        assert_eq!(&args[..4], &["--model", "gemini-test", "--session-id", &id]);
        assert_eq!(&args[4..], &original[2..]);
        let mut missing: Vec<String> = ["--resume", "--", "prompt"]
            .into_iter()
            .map(str::to_string)
            .collect();
        let original = missing.clone();
        assert!(gemini_session_id(&mut missing, true).is_none());
        assert_eq!(missing, original);
    }

    #[test]
    fn fresh_sessions_get_distinct_native_ids_only_if_the_installed_cli_supports_them() {
        let mut args = vec!["--model".into(), "gemini-test".into()];
        assert!(gemini_session_id(&mut args, false).is_none());
        assert_eq!(args.len(), 2);
        let id = gemini_session_id(&mut args, true).unwrap();
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        assert_eq!(
            gemini_session_id(&mut args, true).as_deref(),
            Some(id.as_str())
        );
        assert_ne!(gemini_session_id(&mut Vec::new(), true).unwrap(), id);
    }

    #[test]
    fn native_resume_ids_are_preserved_and_latest_indices_or_files_are_never_guessed() {
        for args in [
            vec!["--resume", "latest"],
            vec!["-r", "5"],
            vec!["--session-file", "saved.json"],
        ] {
            let mut args: Vec<String> = args.into_iter().map(str::to_string).collect();
            let original = args.clone();
            assert!(gemini_session_id(&mut args, true).is_none());
            assert_eq!(args, original);
        }
        let mut explicit = vec!["--resume=known-native-id".into()];
        assert_eq!(
            gemini_session_id(&mut explicit, false).as_deref(),
            Some("known-native-id")
        );
        assert_eq!(explicit.len(), 1);
    }
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
