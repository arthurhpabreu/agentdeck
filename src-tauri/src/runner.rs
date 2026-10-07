use std::{
    io::{BufRead, BufReader},
    process::Stdio,
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
) -> Result<(), String> {
    let expanded_dir = expand_path(&workdir);
    let _launch_guard = crate::cli_updates::launch_guard()?;
    let bin = find_cli_path(&runner_type, &cli_path);
    let cli_args_vec = cli_args
        .split_whitespace()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let (bin, rewritten_args) = resolve_windows_pty_command(&bin, &cli_args_vec);

    let _ = app.emit(
        "runner-output",
        serde_json::json!({
            "session_id": session_id,
            "line": crate::i18n::native_text("native.launch", &format!("🚀 {runner_type} ({bin})"))
        }),
    );

    let mut cmd = background_command(&bin);
    cmd.current_dir(&expanded_dir)
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
        _ => unreachable!("unsupported runner type: {runner_type}"),
    }

    let mut child = cmd.spawn().map_err(|e| {
        let msg = crate::i18n::native_text("native.launchFailed", &format!("{e} : {bin}"));
        let _ = app.emit(
            "runner-done",
            serde_json::json!({"session_id": session_id, "error": msg}),
        );
        msg
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or(crate::i18n::native_text("native.stream", "stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or(crate::i18n::native_text("native.stream", "stderr"))?;

    {
        let map = process_map(&app);
        let mut map = map.lock().unwrap();
        map.insert(session_id.clone(), child);
    }

    // Read stdout asynchronously.
    let app_out = app.clone();
    let sid_out = session_id.clone();
    let rtype_out = runner_type.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            let display = if rtype_out == "claude-code" {
                parse_claude_line(&line)
            } else {
                line
            };
            let _ = app_out.emit(
                "runner-output",
                serde_json::json!({"session_id": sid_out, "line": display}),
            );
        }
        let map = process_map(&app_out);
        let child = map
            .lock()
            .ok()
            .and_then(|mut processes| processes.remove(&sid_out));
        if let Some(mut child) = child {
            let _ = child.wait();
        }
        let _ = app_out.emit("runner-done", serde_json::json!({"session_id": sid_out}));
    });

    // Read stderr asynchronously.
    let app_err = app.clone();
    let sid_err = session_id.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            let _ = app_err.emit(
                "runner-output",
                serde_json::json!({"session_id": sid_err, "line": format!("[stderr] {line}")}),
            );
        }
    });

    // Refresh the diff shortly after startup.
    let app_diff = app.clone();
    let sid_diff = session_id.clone();
    let dir_diff = expanded_dir.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        if let Ok(diff) = get_git_diff_raw(&dir_diff) {
            let _ = app_diff.emit(
                "diff-update",
                serde_json::json!({"session_id": sid_diff, "files": diff}),
            );
        }
    });

    Ok(())
}

/// Stop the runner's child process.
#[tauri::command]
pub fn stop_runner(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let map = process_map(&app);
    let mut map = map.lock().unwrap();
    if let Some(mut child) = map.remove(&session_id) {
        let _ = child.kill();
        let _ = app.emit("runner-done", serde_json::json!({"session_id": session_id}));
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
    )
    .await
}

#[tauri::command]
pub fn stop_claude_session(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    stop_runner(app, session_id)
}
