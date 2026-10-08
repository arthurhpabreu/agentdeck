//! Readable, resumable chat transport for the official Claude Code and Codex CLIs.
//! Prompts travel through stdin; no prompt or attachment is interpolated into a shell.
#[path = "chat_live.rs"]
mod live;
#[path = "chat_protocol.rs"]
mod protocol;

use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::util::{background_command, expand_path, find_cli_path, resolve_windows_pty_command};
use protocol::{bounded_text, ChatEvent, ChatParser};

const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES: u64 = 40 * 1024 * 1024;
const MAX_ATTACHMENTS: usize = 12;
const MAX_PROTOCOL_LINE: usize = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES: usize = 256 * 1024;
const MAX_KNOWLEDGE_CONTEXT_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachment {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub mime_type: String,
    #[serde(default)]
    pub size: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurnRequest {
    pub session_id: String,
    pub turn_id: String,
    pub runner_type: String,
    pub workdir: String,
    #[serde(default)]
    pub project_path: Option<String>,
    pub prompt: String,
    #[serde(default)]
    pub compact_before_turn: bool,
    #[serde(default)]
    pub cli_path: String,
    pub provider_session_id: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub fast_mode: bool,
    #[serde(default)]
    pub ultra_mode: bool,
    #[serde(default)]
    pub full_access: bool,
    #[serde(default)]
    pub attachments: Vec<ChatAttachment>,
    // Resolve from the provider catalogue on the server; never trust supplied paths.
    #[serde(skip_deserializing, default)]
    pub skills: Vec<crate::agent_catalog::SkillReference>,
}

struct ChatProcess {
    turn_id: String,
    provider: String,
    project_path: String,
    input: Mutex<live::LiveInput>,
    child: Mutex<Child>,
    cancelled: AtomicBool,
}

#[derive(Default)]
pub struct ChatProcessState(Mutex<HashMap<String, Arc<ChatProcess>>>);

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_attachment_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.len() <= 180
        && name != "."
        && name != ".."
        && !name.ends_with(['.', ' '])
        && !name
            .chars()
            .any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
}

fn attachment_dir(app: &tauri::AppHandle, session_id: &str) -> Result<PathBuf, String> {
    if !valid_identifier(session_id) {
        return Err("Invalid chat session identifier.".into());
    }
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let root = base.join("chat-attachments");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let directory = root.join(session_id);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let directory = fs::canonicalize(directory).map_err(|error| error.to_string())?;
    if !directory.starts_with(&root) {
        return Err("Attachment directory is outside the application storage.".into());
    }
    Ok(directory)
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[tauri::command]
pub async fn save_chat_attachment(
    app: tauri::AppHandle,
    session_id: String,
    name: String,
    mime_type: String,
    data_base64: String,
) -> Result<ChatAttachment, String> {
    if !valid_attachment_name(&name) {
        return Err("Invalid attachment filename.".into());
    }
    if data_base64.len() > (MAX_ATTACHMENT_BYTES as usize).div_ceil(3) * 4 {
        return Err("Each attachment can be at most 20 MiB.".into());
    }
    let data = STANDARD
        .decode(&data_base64)
        .map_err(|_| "Invalid attachment data.")?;
    if data.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err("Each attachment can be at most 20 MiB.".into());
    }
    let directory = attachment_dir(&app, &session_id)?;
    // A UUID prefix prevents name collisions, overwrites and reserved Windows device names.
    let path = directory.join(format!("{}-{name}", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    file.write_all(&data).map_err(|error| error.to_string())?;
    let detected_mime = image_mime(&data).map(ToOwned::to_owned).unwrap_or_else(|| {
        if mime_type.starts_with("image/") || mime_type.len() > 128 {
            "application/octet-stream".into()
        } else {
            mime_type
        }
    });
    Ok(ChatAttachment {
        name,
        path: path.to_string_lossy().into_owned(),
        mime_type: detected_mime,
        size: data.len() as u64,
    })
}

fn validate_request(request: &ChatTurnRequest) -> Result<(), String> {
    if request.runner_type == "codex" && request.prompt.trim_start().starts_with('/') {
        return Err(
            "Codex slash commands require the native terminal. Invoke skills with $name.".into(),
        );
    }
    if !valid_identifier(&request.session_id) || !valid_identifier(&request.turn_id) {
        return Err("Invalid chat session or turn identifier.".into());
    }
    if !matches!(request.runner_type.as_str(), "codex" | "claude-code") {
        return Err("Readable chat is available for Codex and Claude Code.".into());
    }
    if request.prompt.len() > MAX_PROMPT_BYTES {
        return Err("The message is too large. Attach a file instead.".into());
    }
    if request.prompt.trim().is_empty() && request.attachments.is_empty() {
        return Err("Write a message or attach a file.".into());
    }
    if request.attachments.len() > MAX_ATTACHMENTS {
        return Err("A message can contain at most 12 attachments.".into());
    }
    if !matches!(request.mode.as_deref(), None | Some("code" | "plan")) {
        return Err("Invalid chat mode.".into());
    }
    if !matches!(
        request.effort.as_deref(),
        None | Some("low" | "medium" | "high" | "xhigh" | "max")
    ) && !(request.runner_type == "codex"
        && matches!(request.effort.as_deref(), Some("none" | "minimal")))
    {
        return Err("Invalid reasoning effort.".into());
    }
    if let Some(id) = &request.provider_session_id {
        if !valid_identifier(id) {
            return Err("Invalid provider session identifier.".into());
        }
    }
    if let Some(model) = &request.model {
        if model.len() > 200 || model.chars().any(char::is_control) || model.starts_with('-') {
            return Err("Invalid model name.".into());
        }
    }
    // cli_detect uses a shell fallback for command names. Only fixed names or real files reach it.
    if !request.cli_path.trim().is_empty() && !Path::new(&request.cli_path).is_file() {
        return Err("The configured CLI path does not point to an executable file.".into());
    }
    Ok(())
}

fn validate_attachments(
    request: &mut ChatTurnRequest,
    allowed_directory: &Path,
) -> Result<(), String> {
    let mut total_size = 0_u64;
    for attachment in &mut request.attachments {
        if !valid_attachment_name(&attachment.name) {
            return Err("Invalid attachment filename.".into());
        }
        let path = fs::canonicalize(&attachment.path)
            .map_err(|_| format!("Attachment is no longer available: {}", attachment.name))?;
        if !path.starts_with(allowed_directory) || !path.is_file() {
            return Err("Attachments must be files uploaded to this conversation.".into());
        }
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        total_size = total_size.saturating_add(metadata.len());
        if metadata.len() > MAX_ATTACHMENT_BYTES || total_size > MAX_TOTAL_ATTACHMENT_BYTES {
            return Err("Attachments exceed 20 MiB per file or 40 MiB per message.".into());
        }
        let mut header = [0_u8; 12];
        let count = fs::File::open(&path)
            .and_then(|mut file| file.read(&mut header))
            .map_err(|error| error.to_string())?;
        attachment.mime_type = image_mime(&header[..count])
            .unwrap_or("application/octet-stream")
            .to_owned();
        attachment.path = path.to_string_lossy().into_owned();
        attachment.size = metadata.len();
    }
    Ok(())
}

fn build_arguments(request: &ChatTurnRequest) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if request.runner_type == "codex" {
        args.extend([
            "-c".into(),
            format!(
                "model_reasoning_effort=\"{}\"",
                if request.ultra_mode {
                    "ultra"
                } else {
                    request.effort.as_deref().unwrap_or("medium")
                }
            ),
        ]);
        args.extend([
            "-c".into(),
            format!(
                "service_tier=\"{}\"",
                if request.fast_mode { "fast" } else { "default" }
            ),
        ]);
        args.extend([
            "-c".into(),
            format!("features.fast_mode={}", request.fast_mode),
        ]);
        // Passing this on exec also applies it to exec resume, whose CLI has no --sandbox flag.
        if request.mode.as_deref() == Some("plan") {
            args.extend(["-c".into(), "sandbox_mode=\"read-only\"".into()]);
        }
        if request.full_access && request.mode.as_deref() != Some("plan") {
            args.extend([
                "-c".into(),
                "sandbox_mode=\"danger-full-access\"".into(),
                "-c".into(),
                "approval_policy=\"never\"".into(),
            ]);
        }
        args.extend(["app-server".into(), "--listen".into(), "stdio://".into()]);
    } else {
        args.extend([
            "--effort".into(),
            request.effort.as_deref().unwrap_or("medium").into(),
        ]);
        args.extend([
            "--settings".into(),
            serde_json::json!({"fastMode": request.fast_mode, "ultracode": request.ultra_mode})
                .to_string(),
        ]);
        args.extend(
            [
                "--print",
                "--verbose",
                "--output-format",
                "stream-json",
                "--replay-user-messages",
                "--include-partial-messages",
                "--input-format",
                "stream-json",
            ]
            .map(ToOwned::to_owned),
        );
        if let Some(id) = &request.provider_session_id {
            args.extend(["--resume".into(), id.clone()]);
        }
        if let Some(model) = request
            .model
            .as_ref()
            .filter(|model| !model.trim().is_empty())
        {
            args.extend(["--model".into(), model.clone()]);
        }
        if request.mode.as_deref() == Some("plan") {
            args.extend(["--permission-mode".into(), "plan".into()]);
        } else if request.full_access {
            args.extend(["--permission-mode".into(), "bypassPermissions".into()]);
        }
        if let Some(directory) = request
            .attachments
            .first()
            .and_then(|file| Path::new(&file.path).parent())
        {
            args.extend(["--add-dir".into(), directory.to_string_lossy().into_owned()]);
        }
    }
    args
}

async fn hydrate_skills(request: &mut ChatTurnRequest) -> Result<(), String> {
    request.skills.clear();
    if request.runner_type != "codex" || !request.prompt.contains('$') {
        return Ok(());
    }
    let (prompt, cli, workdir, project) = (
        request.prompt.clone(),
        request.cli_path.clone(),
        request.workdir.clone(),
        request
            .project_path
            .clone()
            .unwrap_or_else(|| request.workdir.clone()),
    );
    request.skills = tauri::async_runtime::spawn_blocking(move || {
        crate::agent_catalog::resolve_codex_skills(&prompt, &cli, &workdir, &project)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(())
}

fn build_input(request: &ChatTurnRequest) -> Result<String, String> {
    let mut prompt = request.prompt.clone();
    if request.runner_type == "codex" && request.mode.as_deref() == Some("plan") {
        prompt = format!("Plan mode: analyze and propose a plan. Do not edit files or execute modifying commands until the user switches to Code mode.\n\n{prompt}");
    }
    if !request.attachments.is_empty() {
        prompt.push_str("\n\nFiles attached by the user (local paths; read as needed):\n");
        for attachment in &request.attachments {
            // JSON string encoding prevents filenames from masquerading as prompt instructions.
            prompt.push_str(&format!(
                "- {}: {}\n",
                serde_json::to_string(&attachment.name).unwrap_or_default(),
                serde_json::to_string(&attachment.path).unwrap_or_default()
            ));
        }
    }
    if request.runner_type == "codex" {
        return Ok(prompt);
    }
    let mut content = vec![serde_json::json!({"type": "text", "text": prompt})];
    for attachment in request
        .attachments
        .iter()
        .filter(|file| file.mime_type.starts_with("image/"))
    {
        let data = fs::read(&attachment.path).map_err(|error| error.to_string())?;
        if data.len() as u64 > MAX_ATTACHMENT_BYTES {
            return Err("Image exceeds 20 MiB.".into());
        }
        content.push(serde_json::json!({
            "type": "image", "source": {
                "type": "base64", "media_type": attachment.mime_type,
                "data": STANDARD.encode(data),
            }
        }));
    }
    Ok(format!(
        "{}\n",
        serde_json::json!({
            "type": "user", "message": {"role": "user", "content": content},
            "parent_tool_use_id": null,
        })
    ))
}

fn append_knowledge_context(prompt: &mut String, context: &str) {
    // Native slash commands must remain intact, including commands with arguments.
    if !prompt.trim().is_empty() && !prompt.trim_start().starts_with('/') {
        prompt.push_str(&bounded_text(context, MAX_KNOWLEDGE_CONTEXT_BYTES));
    }
}

enum ProcessOutput {
    Stdout(String),
    Stderr(String),
    Warning(String),
    Closed,
}

fn read_output(reader: impl Read, stdout: bool, sender: SyncSender<ProcessOutput>) {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let buffer = match reader.fill_buf() {
            Ok(buffer) if !buffer.is_empty() => buffer,
            Err(error) => {
                let _ = sender.send(ProcessOutput::Warning(format!(
                    "Provider output could not be read: {error}"
                )));
                break;
            }
            _ => break,
        };
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(buffer.len(), |index| index + 1);
        if line.len() + consumed > MAX_PROTOCOL_LINE {
            oversized = true;
            line.clear();
        }
        if !oversized {
            line.extend_from_slice(&buffer[..consumed]);
        }
        reader.consume(consumed);
        if newline.is_some() {
            let output = if oversized {
                ProcessOutput::Warning(
                    "A large tool output was omitted from the conversation.".into(),
                )
            } else {
                let text = String::from_utf8_lossy(&line)
                    .trim_end_matches(['\r', '\n'])
                    .to_owned();
                if stdout {
                    ProcessOutput::Stdout(text)
                } else {
                    ProcessOutput::Stderr(text)
                }
            };
            if sender.send(output).is_err() {
                return;
            }
            line.clear();
            oversized = false;
        }
    }
    if oversized {
        let _ = sender.send(ProcessOutput::Warning(
            "A large tool output was omitted from the conversation.".into(),
        ));
    } else if !line.is_empty() {
        let text = String::from_utf8_lossy(&line).into_owned();
        let _ = sender.send(if stdout {
            ProcessOutput::Stdout(text)
        } else {
            ProcessOutput::Stderr(text)
        });
    }
    let _ = sender.send(ProcessOutput::Closed);
}

fn emit_event(app: &tauri::AppHandle, provider: &str, event: ChatEvent) {
    if let Some(provider_id) = &event.provider_session_id {
        let _ = app.emit(
            "provider-session-bound",
            serde_json::json!({
                "session_id": event.session_id,
                "runner_type": provider,
                "provider_session_id": provider_id,
            }),
        );
    }
    let _ = app.emit("chat-event", event);
}

fn terminate_process(process: &ChatProcess) {
    process.cancelled.store(true, Ordering::SeqCst);
    if let Ok(mut child) = process.child.lock() {
        // Do not target a PID after it has already been reaped and could have been reused.
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
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
            let _ = background_command("kill")
                .args(["-TERM", "--", &format!("-{}", child.id())])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = child.kill();
    }
}

#[tauri::command]
pub async fn start_chat_turn(
    app: tauri::AppHandle,
    mut request: ChatTurnRequest,
) -> Result<(), String> {
    validate_request(&request)?;
    let _launch_guard = crate::cli_updates::launch_guard()?;
    if app
        .state::<crate::state::PtyWriterMap>()
        .lock()
        .map_err(|_| "Terminal registry unavailable.")?
        .contains_key(&request.session_id)
    {
        return Err("Stop the native terminal before sending a chat message.".into());
    }
    if !request.cli_path.trim().is_empty() {
        request.cli_path = fs::canonicalize(&request.cli_path)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
    }
    let workdir = fs::canonicalize(expand_path(&request.workdir))
        .map_err(|_| "The project folder no longer exists.")?;
    if !workdir.is_dir() {
        return Err("The project path is not a folder.".into());
    }
    if !request.attachments.is_empty() {
        let directory = attachment_dir(&app, &request.session_id)?;
        validate_attachments(&mut request, &directory)?;
    }
    let original_prompt = request.prompt.clone();
    hydrate_skills(&mut request).await?;
    let project_path = request
        .project_path
        .clone()
        .unwrap_or_else(|| request.workdir.clone());
    if request.provider_session_id.is_none() {
        crate::memory_runtime::reset(
            &app,
            &project_path,
            &request.session_id,
            &request.runner_type,
        );
    }
    let handle = app.clone();
    let (memory_project, memory_session, memory_provider, memory_query) = (
        project_path.clone(),
        request.session_id.clone(),
        request.runner_type.clone(),
        request.prompt.clone(),
    );
    let memory = tauri::async_runtime::spawn_blocking(move || {
        crate::memory_runtime::prepare_or_report(
            &handle,
            &memory_project,
            &memory_session,
            &memory_provider,
            &memory_query,
        )
    })
    .await
    .ok()
    .flatten();
    if let Some(memory) = &memory {
        append_knowledge_context(&mut request.prompt, &memory.text);
    }
    crate::token_economy::reset_after_compaction(
        &request.runner_type,
        &request.session_id,
        &request.prompt,
    );
    let mut arguments = build_arguments(&request);
    let economy = crate::token_economy::prepare_launch(
        &app,
        &request.runner_type,
        &request.workdir,
        &request.cli_path,
        &request.session_id,
        &mut arguments,
    );
    if let Err(error) = crate::memory_runtime::configure_launch(
        &app,
        &project_path,
        &request.session_id,
        &request.runner_type,
        &mut arguments,
    ) {
        let _ = app.emit(
            "shared-memory-error",
            serde_json::json!({"sessionId":request.session_id,"error":error}),
        );
    }
    let delivered_guidance =
        !economy.guidance.is_empty() && !request.prompt.trim_start().starts_with('/');
    crate::token_economy::append_guidance(&mut request.prompt, &economy.guidance);
    let input = live::initial_input(&request)?;
    let executable = find_cli_path(&request.runner_type, &request.cli_path);
    let (executable, arguments) = resolve_windows_pty_command(&executable, &arguments);
    #[cfg(windows)]
    if Path::new(&executable)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "cmd" | "bat" | "ps1"))
    {
        return Err("This CLI wrapper cannot be launched safely. Configure the native executable path in Settings.".into());
    }
    let state = app.state::<ChatProcessState>();
    let mut processes = state
        .0
        .lock()
        .map_err(|_| "Chat process registry unavailable.")?;
    if processes.contains_key(&request.session_id) {
        return Err("This conversation already has a response in progress.".into());
    }
    let mut command = background_command(&executable);
    if request.runner_type == "claude-code" {
        command.env(
            "CLAUDE_CODE_EFFORT_LEVEL",
            request.effort.as_deref().unwrap_or("medium"),
        );
    }
    command
        .args(arguments)
        .current_dir(workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .env("AGENTDECK_SESSION_ID", &request.session_id)
        .env("AGENTDECK_RUNNER_TYPE", &request.runner_type);
    let rtk_path = economy
        .env
        .iter()
        .find(|(key, _)| key == "AGENTDECK_RTK_PATH")
        .map(|(_, value)| value.as_str());
    command.env(
        "PATH",
        crate::token_economy::enrich_path(&std::env::var("PATH").unwrap_or_default(), rtk_path),
    );
    command.envs(economy.env.iter().cloned());
    // Use the official account login, consistently with the existing native terminal transport.
    for key in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
    ] {
        command.env_remove(key);
    }
    if request.runner_type == "claude-code" {
        command.env_remove("CLAUDECODE");
        command.env("CLAUDE_CODE_FORWARD_SUBAGENT_TEXT", "1");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start {}: {error}", request.runner_type))?;
    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (Some(stdin), Some(stdout), Some(stderr)) = (stdin, stdout, stderr) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("The provider output stream could not be opened.".into());
    };
    let process = Arc::new(ChatProcess {
        turn_id: request.turn_id.clone(),
        provider: request.runner_type.clone(),
        project_path: project_path.clone(),
        input: Mutex::new(live::LiveInput::new(
            stdin,
            request.runner_type == "codex",
            request.compact_before_turn && request.provider_session_id.is_some(),
        )),
        child: Mutex::new(child),
        cancelled: AtomicBool::new(false),
    });
    processes.insert(request.session_id.clone(), process.clone());
    drop(processes);
    let parser = ChatParser::new(request.session_id.clone(), request.turn_id.clone());
    let mut started = parser.event("status");
    started.status = Some("started".into());
    started.pid = Some(pid);
    emit_event(&app, &request.runner_type, started);
    if request.compact_before_turn && request.provider_session_id.is_some() {
        let mut compacting = parser.event("status");
        compacting.status = Some("compacting".into());
        emit_event(&app, &request.runner_type, compacting);
    }
    crate::memory_runtime::capture_events(
        &app,
        &project_path,
        &request.session_id,
        &request.runner_type,
        crate::memory_capture::normalize(
            &serde_json::json!({"hook_event_name":"UserPromptSubmit","event_id":request.turn_id,"prompt":original_prompt}),
        ),
    );
    let (sender, receiver) = mpsc::sync_channel(128);
    let sender_out = sender.clone();
    std::thread::spawn(move || read_output(stdout, true, sender_out));
    let sender_err = sender.clone();
    std::thread::spawn(move || read_output(stderr, false, sender_err));
    let guidance_provider = request.runner_type.clone();
    let compacting_before_input =
        request.compact_before_turn && request.provider_session_id.is_some();
    let input_process = process.clone();
    std::thread::spawn(move || {
        let sent = input_process
            .input
            .lock()
            .map_err(|_| "Input unavailable".to_owned())
            .and_then(|mut control| {
                if guidance_provider == "codex" {
                    control.initialize()
                } else {
                    control.write_text(&input)
                }
            });
        if let Err(error) = sent {
            let _ = sender.send(ProcessOutput::Warning(format!(
                "Could not send the message to the provider: {error}"
            )));
        } else if guidance_provider != "codex" && !compacting_before_input {
            let _ = sender.send(ProcessOutput::Stdout(
                serde_json::json!({"type":"agentdeck.initial-delivered"}).to_string(),
            ));
        }
        // Keep stdin open so additional user input can reach an active conversation.
    });
    std::thread::spawn(move || {
        let mut parser = parser;
        let mut stderr_tail = String::new();
        let mut closed = 0;
        let mut exit: Option<ExitStatus> = None;
        let mut exited_at: Option<Instant> = None;
        let mut visible_messages: Vec<(String, String)> = Vec::new();
        let mut capture_stream = crate::memory_capture::StreamCapture::default();
        let mut live = live::LiveProtocol::new(&request);
        let launched_at = Instant::now();
        loop {
            match receiver.recv_timeout(Duration::from_millis(40)) {
                Ok(ProcessOutput::Stdout(line)) => {
                    let lines = match process.input.lock() {
                        Ok(mut input) => live.ingest(&line, &mut input),
                        Err(_) => vec![
                            serde_json::json!({"type":"error","message":"Chat input unavailable"})
                                .to_string(),
                        ],
                    };
                    for line in lines {
                        if let Ok(record) = serde_json::from_str::<serde_json::Value>(&line) {
                            if record["type"] == "agentdeck.initial-delivered" {
                                if delivered_guidance {
                                    crate::token_economy::mark_guidance_delivered(
                                        &request.runner_type,
                                        &request.session_id,
                                    );
                                }
                                if let Some(memory) = &memory {
                                    crate::memory_runtime::mark_delivered(memory);
                                }
                                continue;
                            }
                            if record["type"] == "agentdeck.input" {
                                let mut event = parser.event("input");
                                event.item_id = record["message_id"].as_str().map(str::to_owned);
                                event.status = record["status"].as_str().map(str::to_owned);
                                event.text = record["error"].as_str().map(str::to_owned);
                                emit_event(&app, &request.runner_type, event);
                                continue;
                            }
                        }
                        if let Ok(record) = serde_json::from_str::<serde_json::Value>(&line) {
                            crate::memory_runtime::capture_events(
                                &app,
                                &project_path,
                                &request.session_id,
                                &request.runner_type,
                                capture_stream.ingest(&record),
                            );
                            if record["parent_tool_use_id"].is_null()
                                && (record["subtype"] == "compact_boundary"
                                    || record["type"] == "context_compacted"
                                    || record["payload"]["type"] == "context_compacted")
                            {
                                crate::token_economy::reset_after_compaction(
                                    &request.runner_type,
                                    &request.session_id,
                                    "/compact",
                                );
                                crate::memory_runtime::reset(
                                    &app,
                                    &project_path,
                                    &request.session_id,
                                    &request.runner_type,
                                );
                            }
                        }
                        if request.runner_type == "claude-code" {
                            if let Ok(record) = serde_json::from_str::<serde_json::Value>(&line) {
                                if record["type"] == "rate_limit_event" {
                                    crate::provider_usage::ingest_claude_rate_limit(&app, &record);
                                }
                            }
                        }
                        for event in parser.parse(&request.runner_type, &line) {
                            if event.kind == "text" && event.parent_id.is_none() {
                                let id = event.item_id.clone().unwrap_or_default();
                                if let Some((_, text)) =
                                    visible_messages.iter_mut().find(|(key, _)| key == &id)
                                {
                                    *text = if event.delta {
                                        crate::memory_runtime::truncate(
                                            &format!(
                                                "{text}{}",
                                                event.text.as_deref().unwrap_or("")
                                            ),
                                            16000,
                                        )
                                    } else {
                                        crate::memory_runtime::truncate(
                                            event.text.as_deref().unwrap_or(""),
                                            16000,
                                        )
                                    };
                                } else {
                                    if visible_messages.len() >= 8 {
                                        visible_messages.remove(0);
                                    }
                                    visible_messages.push((
                                        id,
                                        crate::memory_runtime::truncate(
                                            event.text.as_deref().unwrap_or(""),
                                            16000,
                                        ),
                                    ));
                                }
                            }
                            emit_event(&app, &request.runner_type, event);
                        }
                    }
                }
                Ok(ProcessOutput::Stderr(line)) => {
                    if !line.trim().is_empty() {
                        stderr_tail = bounded_text(&format!("{line}\n{stderr_tail}"), 8_192);
                        let mut event = parser.message("status", &line);
                        event.status = Some("diagnostic".into());
                        emit_event(&app, &request.runner_type, event);
                    }
                }
                Ok(ProcessOutput::Warning(text)) => {
                    emit_event(&app, &request.runner_type, parser.message("status", &text))
                }
                Ok(ProcessOutput::Closed) => closed += 1,
                Err(_) => {}
            }
            if live.compacting() && launched_at.elapsed() > Duration::from_secs(180) {
                parser.failed = true;
                emit_event(&app, &request.runner_type, parser.message("error", "Context compaction timed out. Your next request was not sent; the existing conversation is preserved. Retry or adjust automatic compaction in the chat context settings."));
                terminate_process(&process);
                break;
            }
            if exit.is_none() {
                match process
                    .child
                    .lock()
                    .map_err(|_| ())
                    .and_then(|mut child| child.try_wait().map_err(|_| ()))
                {
                    Ok(Some(status)) => {
                        exit = Some(status);
                        exited_at = Some(Instant::now());
                    }
                    Err(_) => {
                        parser.failed = true;
                        emit_event(
                            &app,
                            &request.runner_type,
                            parser.message("error", "Could not read provider process status."),
                        );
                        terminate_process(&process);
                        break;
                    }
                    _ => {}
                }
            }
            if exit.is_some()
                && (closed >= 2
                    || exited_at.is_some_and(|time| time.elapsed() > Duration::from_secs(2)))
            {
                break;
            }
        }
        let cancelled = process.cancelled.load(Ordering::SeqCst);
        if !cancelled && exit.is_some_and(|status| !status.success()) && !parser.failed {
            parser.failed = true;
            let detail = if stderr_tail.is_empty() {
                "The provider exited without completing its response. Check its native login and model configuration.".to_owned()
            } else {
                stderr_tail
            };
            emit_event(&app, &request.runner_type, parser.message("error", &detail));
        }
        // Remove only our generation; a late worker cannot remove a newer turn.
        if let Ok(mut processes) = app.state::<ChatProcessState>().0.lock() {
            if processes
                .get(&request.session_id)
                .is_some_and(|entry| entry.turn_id == request.turn_id)
            {
                processes.remove(&request.session_id);
            }
        }
        let mut done = parser.event("done");
        if cancelled || parser.failed || !exit.is_some_and(|status| status.success()) {
            // A pipe write alone does not prove the model accepted the context (login/spawn errors).
            crate::memory_runtime::reset(
                &app,
                &project_path,
                &request.session_id,
                &request.runner_type,
            );
        }
        if !cancelled && !parser.failed && exit.is_some_and(|status| status.success()) {
            if let Some((_, answer)) = visible_messages.last() {
                crate::memory_runtime::capture(
                    &app,
                    &project_path,
                    &request.session_id,
                    &request.runner_type,
                    answer,
                );
            }
        } else {
            let reason = if cancelled {
                "Turn interrupted; work remains pending"
            } else {
                "Provider turn failed; work remains pending"
            };
            let mut events = crate::memory_capture::normalize(
                &serde_json::json!({"hook_event_name":"StopFailure","event_id":request.turn_id,"last_assistant_message":reason}),
            );
            events.push(crate::shared_memory::MemoryEvent {
                id: format!("{}:end", request.turn_id),
                kind: "turn-end".into(),
                title: "Incomplete turn".into(),
                summary: reason.into(),
                files: vec![],
                branch: String::new(),
            });
            crate::memory_runtime::capture_events(
                &app,
                &project_path,
                &request.session_id,
                &request.runner_type,
                events,
            );
        }
        done.status = Some(
            if cancelled {
                "stopped"
            } else if parser.failed {
                "error"
            } else {
                "completed"
            }
            .into(),
        );
        emit_event(&app, &request.runner_type, done);
    });
    Ok(())
}

#[tauri::command]
pub fn stop_chat_turn(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let process = app
        .state::<ChatProcessState>()
        .0
        .lock()
        .map_err(|_| "Chat process registry unavailable.")?
        .get(&session_id)
        .cloned();
    if let Some(process) = process {
        terminate_process(&process);
    }
    Ok(())
}

#[tauri::command]
pub async fn steer_chat_turn(
    app: tauri::AppHandle,
    mut request: ChatTurnRequest,
    message_id: String,
) -> Result<String, String> {
    validate_request(&request)?;
    if !valid_identifier(&message_id) {
        return Err("Invalid message identifier".into());
    }
    let process = app
        .state::<ChatProcessState>()
        .0
        .lock()
        .map_err(|_| "Chat registry unavailable")?
        .get(&request.session_id)
        .cloned()
        .ok_or("This response has already ended")?;
    if process.turn_id != request.turn_id
        || process.provider != request.runner_type
        || process.cancelled.load(Ordering::SeqCst)
    {
        return Err("This response has already ended".into());
    }
    if !request.attachments.is_empty() {
        let directory = attachment_dir(&app, &request.session_id)?;
        validate_attachments(&mut request, &directory)?;
    }
    hydrate_skills(&mut request).await?;
    let status = process
        .input
        .lock()
        .map_err(|_| "Input unavailable")?
        .submit(&request, &message_id)?;
    let mut events = crate::memory_capture::normalize(
        &serde_json::json!({"hook_event_name":"UserPromptSubmit","event_id":message_id,"prompt":request.prompt}),
    );
    for event in &mut events {
        event.kind = "addition".into();
    }
    crate::memory_runtime::capture_events(
        &app,
        &process.project_path,
        &request.session_id,
        &request.runner_type,
        events,
    );
    Ok(status.into())
}

pub fn stop_all_chat_processes(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<ChatProcessState>() else {
        return;
    };
    let processes = state
        .0
        .lock()
        .map(|map| map.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for process in processes {
        terminate_process(&process);
    }
}
pub fn has_active_processes(app: &tauri::AppHandle) -> bool {
    app.state::<ChatProcessState>()
        .0
        .lock()
        .map(|map| !map.is_empty())
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn request(provider: &str) -> ChatTurnRequest {
        ChatTurnRequest {
            session_id: "session-1".into(),
            turn_id: "turn-1".into(),
            runner_type: provider.into(),
            workdir: ".".into(),
            project_path: None,
            prompt: "Help with $(untrusted) & a file".into(),
            compact_before_turn: false,
            cli_path: String::new(),
            provider_session_id: None,
            model: None,
            mode: None,
            effort: None,
            fast_mode: false,
            ultra_mode: false,
            full_access: false,
            attachments: Vec::new(),
            skills: Vec::new(),
        }
    }

    #[test]
    fn prompts_never_become_cli_arguments_or_permission_bypasses() {
        for provider in ["codex", "claude-code"] {
            let req = request(provider);
            let args = build_arguments(&req);
            assert!(!args.iter().any(|arg| arg.contains("untrusted")
                || arg.contains("bypass")
                || arg.contains("acceptEdits")));
            assert!(build_input(&req).unwrap().contains("untrusted"));
        }
    }

    #[test]
    fn effort_and_speed_override_inherited_defaults_on_new_and_resumed_turns() {
        for provider in ["codex", "claude-code"] {
            for resumed in [false, true] {
                let mut req = request(provider);
                if resumed {
                    req.provider_session_id = Some("native-session".into());
                }
                let args = build_arguments(&req);
                if provider == "codex" {
                    assert!(args.contains(&"model_reasoning_effort=\"medium\"".into()));
                    assert!(args.contains(&"service_tier=\"default\"".into()));
                    assert!(args.contains(&"features.fast_mode=false".into()));
                } else {
                    assert!(args.windows(2).any(|pair| pair == ["--effort", "medium"]));
                    let pos = args.iter().position(|arg| arg == "--settings").unwrap();
                    let value: serde_json::Value = serde_json::from_str(&args[pos + 1]).unwrap();
                    assert_eq!(value["ultracode"], false);
                    assert_eq!(value["fastMode"], false);
                }
                req.effort = Some("low".into());
                req.fast_mode = true;
                req.ultra_mode = true;
                let args = build_arguments(&req);
                if provider == "codex" {
                    assert!(args.contains(&"model_reasoning_effort=\"ultra\"".into()));
                    assert!(args.contains(&"service_tier=\"fast\"".into()));
                    let config = args
                        .iter()
                        .position(|arg| arg.contains("model_reasoning_effort"))
                        .unwrap();
                    if resumed {
                        assert!(config < args.iter().position(|arg| arg == "app-server").unwrap());
                    }
                } else {
                    // Claude's Ultracode switch does not raise the selected effort.
                    assert!(args.windows(2).any(|pair| pair == ["--effort", "low"]));
                    let pos = args.iter().position(|arg| arg == "--settings").unwrap();
                    let value: serde_json::Value = serde_json::from_str(&args[pos + 1]).unwrap();
                    assert_eq!(value["ultracode"], true);
                    assert_eq!(value["fastMode"], true);
                }
                req.ultra_mode = false;
                req.fast_mode = false;
                let args = build_arguments(&req);
                if provider == "codex" {
                    assert!(args.contains(&"model_reasoning_effort=\"low\"".into()));
                }
                req.effort = Some("ultra\" --unsafe".into());
                assert!(validate_request(&req).is_err());
            }
        }
    }

    #[test]
    fn codex_all_base_efforts_reach_new_and_resumed_cli_arguments() {
        for effort in ["none", "minimal", "low", "medium", "high", "xhigh", "max"] {
            for resumed in [false, true] {
                let mut req = request("codex");
                req.effort = Some(effort.into());
                if resumed {
                    req.provider_session_id = Some("native-session".into());
                }
                assert!(validate_request(&req).is_ok());
                assert!(
                    build_arguments(&req).contains(&format!("model_reasoning_effort=\"{effort}\""))
                );
            }
        }
        for effort in ["none", "minimal"] {
            let mut req = request("claude-code");
            req.effort = Some(effort.into());
            assert!(validate_request(&req).is_err());
        }
    }

    #[test]
    fn codex_resume_uses_native_id_and_restores_images() {
        let mut req = request("codex");
        req.provider_session_id = Some("native-session".into());
        req.mode = Some("plan".into());
        req.attachments.push(ChatAttachment {
            name: "diagram.png".into(),
            path: "C:/with space/diagram.png".into(),
            mime_type: "image/png".into(),
            size: 20,
        });
        let args = build_arguments(&req);
        assert!(args.contains(&"app-server".into()));
        assert!(!args.contains(&"exec".into()));
        assert!(args.contains(&"sandbox_mode=\"read-only\"".into()));
        let input = live::codex_input(&req).unwrap();
        assert_eq!(input[1]["type"], "localImage");
        assert_eq!(input[1]["path"], "C:/with space/diagram.png");
        assert_eq!(req.provider_session_id.as_deref(), Some("native-session"));
    }

    #[test]
    fn claude_input_is_structured_and_plan_is_explicit() {
        let mut req = request("claude-code");
        req.mode = Some("plan".into());
        let args = build_arguments(&req);
        assert!(args
            .windows(2)
            .any(|args| args == ["--permission-mode", "plan"]));
        let input: serde_json::Value = serde_json::from_str(&build_input(&req).unwrap()).unwrap();
        assert_eq!(input["message"]["content"][0]["text"], req.prompt);
        assert_eq!(input["type"], "user");
    }
    #[test]
    fn full_access_is_explicit_and_plan_retains_read_only_permissions() {
        for provider in ["codex", "claude-code"] {
            let mut req = request(provider);
            req.full_access = true;
            let args = build_arguments(&req);
            assert!(args.iter().any(|arg| arg.contains(if provider == "codex" {
                "danger-full-access"
            } else {
                "bypassPermissions"
            })));
            req.mode = Some("plan".into());
            let args = build_arguments(&req);
            assert!(
                !args
                    .iter()
                    .any(|arg| arg.contains("danger-full-access")
                        || arg.contains("bypassPermissions"))
            );
        }
    }

    #[test]
    fn invalid_identifiers_paths_and_excessive_attachments_are_rejected() {
        for name in ["../x", "..\\x", "a:b", "x\n", "..", "x."] {
            assert!(!valid_attachment_name(name), "{name}");
        }
        assert!(valid_attachment_name("análise final.txt"));
        let mut req = request("codex");
        req.session_id = "../outside".into();
        assert!(validate_request(&req).is_err());
        req.session_id = "safe".into();
        req.provider_session_id = Some("--bypass".into());
        assert!(validate_request(&req).is_err());
        req.provider_session_id = None;
        req.model = Some("--bypass".into());
        assert!(validate_request(&req).is_err());
    }

    #[test]
    fn attachment_content_is_detected_instead_of_trusting_browser_mime() {
        assert_eq!(image_mime(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(image_mime(b"not actually an image"), None);
    }

    #[test]
    fn knowledge_enrichment_preserves_prompt_slash_commands_and_unicode_boundaries() {
        let original = "Explain the architecture";
        let mut prompt = original.to_string();
        append_knowledge_context(&mut prompt, "\n\nRelevant local knowledge: design notes");
        assert!(prompt.starts_with(original));
        assert!(prompt.ends_with("design notes"));

        let mut slash = "  /model sonnet".to_string();
        append_knowledge_context(&mut slash, "must not be appended");
        assert_eq!(slash, "  /model sonnet");

        let mut prompt = original.to_string();
        append_knowledge_context(&mut prompt, &"é".repeat(MAX_KNOWLEDGE_CONTEXT_BYTES));
        assert!(prompt.len() <= original.len() + MAX_KNOWLEDGE_CONTEXT_BYTES + 32);
        assert!(prompt.ends_with("[output truncated]"));
    }

    #[test]
    fn protocol_reader_bounds_long_lines_and_recovers() {
        let data = format!(
            "{}\n{{\"type\":\"turn.started\"}}\n",
            "x".repeat(MAX_PROTOCOL_LINE + 1)
        );
        let (sender, receiver) = mpsc::sync_channel(8);
        read_output(data.as_bytes(), true, sender);
        let outputs: Vec<_> = receiver.try_iter().collect();
        assert!(matches!(&outputs[0], ProcessOutput::Warning(_)));
        assert!(
            matches!(&outputs[1], ProcessOutput::Stdout(line) if line.contains("turn.started"))
        );
        assert!(matches!(&outputs[2], ProcessOutput::Closed));
    }
}
