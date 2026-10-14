use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

use tauri::{Emitter, Manager};

use crate::{
    git::diff::get_git_diff_raw,
    state::ProcessMap,
    util::{
        background_command, expand_path, find_cli_path, resolve_provider_file_path,
        resolve_windows_pty_command,
    },
};

// ── Helper: access ProcessMap through AppHandle ──────────────────

fn process_map(app: &tauri::AppHandle) -> ProcessMap {
    app.state::<ProcessMap>().inner().clone()
}

struct RunInfo {
    id: String,
    pid: u32,
    finished: AtomicBool,
}
fn runs() -> &'static Mutex<HashMap<String, Arc<RunInfo>>> {
    static RUNS: OnceLock<Mutex<HashMap<String, Arc<RunInfo>>>> = OnceLock::new();
    RUNS.get_or_init(Mutex::default)
}
fn session_gate(session: &str) -> Result<Arc<Mutex<()>>, String> {
    static GATES: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut gates = GATES
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "Runner launch registry unavailable.")?;
    if gates.len() > 256 {
        gates.retain(|_, gate| Arc::strong_count(gate) > 1);
    }
    Ok(gates.entry(session.into()).or_default().clone())
}
fn current_run(session: &str, run: &RunInfo) -> bool {
    runs()
        .lock()
        .ok()
        .and_then(|current| {
            current
                .get(session)
                .map(|item| item.id == run.id && item.pid == run.pid)
        })
        .unwrap_or(false)
}

fn resolve_project(workdir: &str, project_path: Option<&str>) -> Result<(PathBuf, String), String> {
    let directory = std::fs::canonicalize(expand_path(workdir))
        .map_err(|_| "The project folder no longer exists.")?;
    if !directory.is_dir() {
        return Err("The project path is not a folder.".into());
    }
    let project = project_path
        .map(expand_path)
        .unwrap_or_else(|| directory.to_string_lossy().into_owned());
    if crate::shared_memory::project_key(&directory)?
        != crate::shared_memory::project_key(Path::new(&project))?
    {
        return Err("The runner project does not match its working directory.".into());
    }
    Ok((directory, project))
}

/// A reused session ID never permits an old worker to consume the new child.
fn take_owned_child(map: &ProcessMap, session: &str, pid: u32) -> Option<Child> {
    let mut children = map.lock().ok()?;
    if children.get(session).is_some_and(|child| child.id() == pid) {
        children.remove(session)
    } else {
        None
    }
}
fn poll_owned_child(
    map: &ProcessMap,
    session: &str,
    pid: u32,
) -> Result<Option<ExitStatus>, String> {
    let mut children = map
        .lock()
        .map_err(|_| "Runner process registry unavailable.")?;
    let child = children
        .get_mut(session)
        .filter(|child| child.id() == pid)
        .ok_or("Runner instance no longer owns this session.")?;
    child.try_wait().map_err(|error| error.to_string())
}
pub(crate) fn terminate_child(child: &mut Child) -> Result<(), String> {
    #[cfg(not(unix))]
    if child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let _ = background_command("taskkill.exe")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        // Keep the leader unreaped until both signals were sent: its PID then
        // cannot be recycled into somebody else's process group. Descendants
        // ignoring TERM still belong to this explicitly owned launch group.
        unsafe extern "C" {
            fn kill(pid: std::ffi::c_int, signal: std::ffi::c_int) -> std::ffi::c_int;
        }
        let group = -(child.id() as std::ffi::c_int);
        unsafe {
            kill(group, 15);
        }
        std::thread::sleep(Duration::from_millis(50));
        unsafe {
            kill(group, 9);
        }
    }
    if child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_none()
    {
        child.kill().map_err(|error| error.to_string())?;
    }
    child.wait().map_err(|error| error.to_string())?;
    Ok(())
}
fn done_payload(
    session: &str,
    run_id: &str,
    status: &str,
    exit: Option<ExitStatus>,
    error: Option<String>,
) -> serde_json::Value {
    let confirmed = exit.as_ref().is_some_and(ExitStatus::success);
    let status = if status == "completed" && !confirmed {
        "error"
    } else {
        status
    };
    serde_json::json!({"session_id":session,"run_id":run_id,"status":status,"source":"legacy-runner","exit_code":exit.and_then(|status| status.code()),"error":error})
}
fn emit_done(
    app: &tauri::AppHandle,
    session: &str,
    run: &RunInfo,
    status: &str,
    exit: Option<ExitStatus>,
    error: Option<String>,
) {
    if !run.finished.swap(true, Ordering::SeqCst) {
        let _ = app.emit(
            "runner-done",
            done_payload(session, &run.id, status, exit, error),
        );
    }
}

// ── Claude Code output parsing ───────────────────────────────────

/// Parse Claude Code stream-json lines into readable text.
pub fn parse_claude_line(line: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
        if let Some(content) = v.get("content").and_then(|c| c.as_str()) {
            return content.to_string();
        }
        if let Some(msg) = v.get("message").and_then(|m| m.as_str()) {
            return msg.to_string();
        }
    }
    line.to_string()
}

// ── Tauri Commands ────────────────────────────────────────────────

/// Start a runner (claude-code / codex).
#[tauri::command]
pub async fn start_runner(
    app: tauri::AppHandle,
    session_id: String,
    workdir: String,
    task: String,
    runner_type: String,
    cli_path: String,
    cli_args: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let run_id = uuid::Uuid::new_v4().to_string();
    let event_app = app.clone();
    let event_session = session_id.clone();
    let event_run = run_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        start_runner_inner(
            app,
            session_id,
            workdir,
            task,
            runner_type,
            cli_path,
            cli_args,
            project_path,
            run_id,
        )
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);
    if let Err(error) = &result {
        let _ = event_app.emit(
            "runner-done",
            done_payload(
                &event_session,
                &event_run,
                "error",
                None,
                Some(error.clone()),
            ),
        );
    }
    result
}

fn start_runner_inner(
    app: tauri::AppHandle,
    session_id: String,
    workdir: String,
    task: String,
    runner_type: String,
    cli_path: String,
    cli_args: String,
    project_path: Option<String>,
    run_id: String,
) -> Result<(), String> {
    if !matches!(runner_type.as_str(), "claude-code" | "codex" | "gemini") {
        return Err("Unsupported runner type.".into());
    }
    if session_id.trim().is_empty()
        || session_id.len() > 256
        || session_id.chars().any(char::is_control)
    {
        return Err("Invalid runner session identifier.".into());
    }
    let gate = session_gate(&session_id)?;
    let _session_guard = gate.lock().map_err(|_| "Runner session unavailable.")?;
    let _ = app.emit(
        "runner-starting",
        serde_json::json!({"session_id":session_id,"run_id":run_id}),
    );
    let (expanded_dir, project_path) = resolve_project(&workdir, project_path.as_deref())?;
    let _launch_guard = crate::cli_updates::launch_guard()?;
    let bin = find_cli_path(&runner_type, &cli_path);
    let mut cli_args_vec = cli_args
        .split_whitespace()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    // Every legacy launch is a new native process, so prepare its selected sources afresh.
    crate::memory_runtime::reset(&app, &project_path, &session_id, &runner_type);
    let memory = if task.trim().is_empty() {
        None
    } else {
        Some(crate::memory_runtime::prepare_turn(
            &app,
            &project_path,
            &session_id,
            &runner_type,
            &task,
        )?)
    };
    let launch = crate::memory_runtime::configure_launch(
        &app,
        &project_path,
        &session_id,
        &runner_type,
        &mut cli_args_vec,
    )?;
    // The empty legacy bootstrap must stay empty instead of becoming a paid
    // context-only prompt. Its scoped MCP configuration is still installed.
    let mut task = task;
    if let Some(memory) = &memory {
        task.push_str(&memory.text);
    }
    let (bin, rewritten_args) = resolve_windows_pty_command(&bin, &cli_args_vec);

    let _ = app.emit(
        "runner-output",
        serde_json::json!({
            "session_id": session_id,
            "run_id": run_id,
            "line": crate::i18n::native_text("native.launch", &format!("🚀 {runner_type} ({bin})"))
        }),
    );

    let mut cmd = background_command(&bin);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.current_dir(&expanded_dir)
        .env(
            "PATH",
            crate::platform::process_path(std::path::Path::new(&bin)),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let agentdeck_tmp = crate::util::agentdeck_tmp_dir()
        .to_string_lossy()
        .to_string();
    cmd.env("TMPDIR", &agentdeck_tmp);
    cmd.env("TEMP", &agentdeck_tmp);
    cmd.env("TMP", &agentdeck_tmp);
    for name in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GEMINI_BASE_URL",
    ] {
        cmd.env_remove(name);
    }

    match runner_type.as_str() {
        "claude-code" => {
            for arg in &rewritten_args {
                cmd.arg(arg);
            }

            // Respect the user's official Claude Code settings, including OAuth and model choice.
            if let Some(settings_path) =
                resolve_provider_file_path("claude-code", &bin, "settings.json")
            {
                if let Ok(content) = std::fs::read_to_string(&settings_path) {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                        if let Some(env_obj) = json.get("env").and_then(|v| v.as_object()) {
                            for (k, v) in env_obj {
                                if let Some(val) = v.as_str().filter(|_| {
                                    !k.ends_with("_API_KEY")
                                        && k != "ANTHROPIC_AUTH_TOKEN"
                                        && !k.ends_with("_BASE_URL")
                                }) {
                                    cmd.env(k, val);
                                }
                            }
                        }
                    }
                }
            }

            cmd.arg("--print")
                .arg("--output-format")
                .arg("stream-json")
                .arg(&task);
        }
        "codex" => {
            for arg in &rewritten_args {
                cmd.arg(arg);
            }
            cmd.arg("exec").arg("--color").arg("never").arg(&task);
        }
        "gemini" => {
            for arg in &rewritten_args {
                cmd.arg(arg);
            }
            cmd.arg("--prompt")
                .arg(&task)
                .arg("--output-format")
                .arg("stream-json");
        }
        _ => return Err("Unsupported runner type.".into()),
    }

    for (key, value) in launch.env {
        cmd.env(key, value);
    }
    if let Some(memory) = &memory {
        crate::memory_runtime::validate_turn(&app, memory)?;
    }
    let map = process_map(&app);
    let old = map
        .lock()
        .map_err(|_| "Runner process registry unavailable.")?
        .remove(&session_id);
    if let Some(mut child) = old {
        let previous = runs().lock().ok().and_then(|current| {
            current
                .get(&session_id)
                .filter(|run| run.pid == child.id())
                .cloned()
        });
        if let Err(error) = terminate_child(&mut child) {
            map.lock()
                .map_err(|_| "Runner process registry unavailable.")?
                .insert(session_id.clone(), child);
            return Err(error);
        }
        if let Some(previous) = previous {
            emit_done(&app, &session_id, &previous, "stopped", None, None);
        }
    }

    if let Some(memory) = &memory {
        crate::memory_runtime::validate_turn(&app, memory)?;
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| crate::i18n::native_text("native.launchFailed", &format!("{e} : {bin}")))?;
    let run = Arc::new(RunInfo {
        id: run_id,
        pid: child.id(),
        finished: AtomicBool::new(false),
    });

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (Some(stdout), Some(stderr)) = (stdout, stderr) else {
        let _ = terminate_child(&mut child);
        let error = crate::i18n::native_text("native.stream", "stdout/stderr");
        return Err(error);
    };

    {
        let mut current = match runs().lock() {
            Ok(current) => current,
            Err(_) => {
                let _ = terminate_child(&mut child);
                return Err("Runner identity registry unavailable.".into());
            }
        };
        let mut processes = match map.lock() {
            Ok(processes) => processes,
            Err(_) => {
                drop(current);
                let _ = terminate_child(&mut child);
                return Err("Runner process registry unavailable.".into());
            }
        };
        if current.len() > 256 {
            current.retain(|_, run| {
                !run.finished.load(Ordering::SeqCst) || Arc::strong_count(run) > 1
            });
        }
        current.insert(session_id.clone(), run.clone());
        processes.insert(session_id.clone(), child);
    }
    if let Some(memory) = &memory {
        crate::memory_runtime::mark_delivered(&app, memory);
    }
    let _ = app.emit(
        "runner-started",
        serde_json::json!({"session_id":session_id,"run_id":run.id,"pid":run.pid}),
    );

    // Read stdout asynchronously.
    let app_out = app.clone();
    let sid_out = session_id.clone();
    let rtype_out = runner_type.clone();
    let run_out = run.clone();
    let output_gate = gate.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            let Ok(_emit_guard) = output_gate.lock() else {
                break;
            };
            if !current_run(&sid_out, &run_out) {
                break;
            }
            let display = if rtype_out == "claude-code" {
                parse_claude_line(&line)
            } else {
                line
            };
            let _ = app_out.emit(
                "runner-output",
                serde_json::json!({"session_id": sid_out,"run_id":run_out.id,"line": display}),
            );
        }
        // EOF is only a pipe state; it is never proof that the task completed.
    });

    // Read stderr asynchronously.
    let app_err = app.clone();
    let sid_err = session_id.clone();
    let run_err = run.clone();
    let error_gate = gate.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            let Ok(_emit_guard) = error_gate.lock() else {
                break;
            };
            if !current_run(&sid_err, &run_err) {
                break;
            }
            let _ = app_err.emit(
                "runner-output",
                serde_json::json!({"session_id": sid_err,"run_id":run_err.id,"line": format!("[stderr] {line}")}),
            );
        }
    });

    let app_wait = app.clone();
    let sid_wait = session_id.clone();
    let run_wait = run.clone();
    let wait_gate = gate.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(30));
        let Ok(_guard) = wait_gate.lock() else {
            return;
        };
        if !current_run(&sid_wait, &run_wait) || run_wait.finished.load(Ordering::SeqCst) {
            return;
        }
        match poll_owned_child(&process_map(&app_wait), &sid_wait, run_wait.pid) {
            Ok(Some(exit)) => {
                if take_owned_child(&process_map(&app_wait), &sid_wait, run_wait.pid).is_some() {
                    let status = if exit.success() { "completed" } else { "error" };
                    let error = (!exit.success()).then(|| format!("Runner exited with {exit}."));
                    emit_done(&app_wait, &sid_wait, &run_wait, status, Some(exit), error);
                }
                return;
            }
            Ok(None) => {}
            Err(_) => return,
        }
    });

    // Refresh the diff shortly after startup.
    let app_diff = app.clone();
    let sid_diff = session_id.clone();
    let dir_diff = expanded_dir.clone();
    let run_diff = run;
    let diff_gate = gate.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        if !current_run(&sid_diff, &run_diff) {
            return;
        }
        if let Ok(diff) = get_git_diff_raw(dir_diff.to_string_lossy().as_ref()) {
            let Ok(_emit_guard) = diff_gate.lock() else {
                return;
            };
            if !current_run(&sid_diff, &run_diff) {
                return;
            }
            let _ = app_diff.emit(
                "diff-update",
                serde_json::json!({"session_id": sid_diff,"run_id":run_diff.id,"files": diff}),
            );
        }
    });

    Ok(())
}

/// Stop the runner's child process.
#[tauri::command]
pub async fn stop_runner(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_runner_inner(app, session_id))
        .await
        .map_err(|error| error.to_string())?
}
fn stop_runner_inner(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let gate = session_gate(&session_id)?;
    let _guard = gate.lock().map_err(|_| "Runner session unavailable.")?;
    let map = process_map(&app);
    let child = map
        .lock()
        .map_err(|_| "Runner process registry unavailable.")?
        .remove(&session_id);
    if let Some(mut child) = child {
        let run = runs().lock().ok().and_then(|current| {
            current
                .get(&session_id)
                .filter(|run| run.pid == child.id())
                .cloned()
        });
        if let Err(error) = terminate_child(&mut child) {
            map.lock()
                .map_err(|_| "Runner process registry unavailable.")?
                .insert(session_id.clone(), child);
            return Err(error);
        }
        if let Some(run) = run {
            emit_done(&app, &session_id, &run, "stopped", None, None);
        }
    }
    Ok(())
}

// ── Legacy interface compatibility ───────────────────────────────

#[tauri::command]
pub async fn start_claude_session(
    app: tauri::AppHandle,
    session_id: String,
    workdir: String,
) -> Result<(), String> {
    start_runner(
        app,
        session_id,
        workdir,
        String::new(),
        "claude-code".to_string(),
        String::new(),
        String::new(),
        None,
    )
    .await
}

#[tauri::command]
pub async fn stop_claude_session(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    stop_runner(app, session_id).await
}

#[cfg(test)]
#[path = "runner_tests.rs"]
mod tests;
