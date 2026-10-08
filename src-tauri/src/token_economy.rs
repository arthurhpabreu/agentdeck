//! Session-scoped token economy. Never rewrites provider configuration or changes permissions.
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

const CODEX_TOOL_BUDGET: u64 = 6_000;
const MAX_METADATA_BYTES: u64 = 256 * 1024;
const GUIDANCE: &str = "Token economy: search scoped paths and read relevant line ranges; avoid repeated full-file reads and broad logs. Prefix shell commands with RTK: use supported compact commands (rtk git diff, rtk cargo test, rtk pytest); use rtk proxy <program> <arguments> for unsupported commands, including rtk proxy powershell -NoProfile -Command <script> on Windows. Preserve inherited RTK_DB_PATH so this app can measure commands. Proxy records output without compression. RTK output may omit diagnostics: on failure or missing detail, read its saved full-output log or rerun with rtk proxy and inspect relevant ranges. Preserve commands, exit status, security checks and required tests; never skip verification or change model/permissions to save tokens. Treat compression as an aid, not evidence that tests passed.";
const NO_RTK_GUIDANCE: &str = "Token economy: search scoped paths and read relevant line ranges; avoid repeated full-file reads and broad logs. Prefer targeted tests and concise progress updates, but retain actionable errors and run all required verification. Expand relevant raw output whenever needed; never reduce model quality or permissions to save tokens.";

fn delivered_guidance() -> &'static Mutex<HashSet<String>> {
    static DELIVERED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    DELIVERED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn guidance_key(provider: &str, session_id: &str) -> String {
    format!("{provider}:{session_id}")
}

fn needs_guidance(provider: &str, session_id: &str) -> bool {
    delivered_guidance()
        .lock()
        .map(|set| !set.contains(&guidance_key(provider, session_id)))
        .unwrap_or(true)
}

pub fn mark_guidance_delivered(provider: &str, session_id: &str) {
    if let Ok(mut delivered) = delivered_guidance().lock() {
        if delivered.len() >= 1024 {
            delivered.clear();
        }
        delivered.insert(guidance_key(provider, session_id));
    }
}

pub fn reset_after_compaction(provider: &str, session_id: &str, query: &str) {
    if matches!(query.split_whitespace().next(), Some("/compact" | "/clear")) {
        if let Ok(mut delivered) = delivered_guidance().lock() {
            delivered.remove(&guidance_key(provider, session_id));
        }
    }
}

#[derive(Clone, Debug, Default)]
struct Capabilities {
    path: Option<String>,
    version: Option<String>,
    claude_hook: bool,
}

#[derive(Deserialize, Serialize)]
struct Config {
    enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenEconomyStatus {
    enabled: bool,
    available: bool,
    version: Option<String>,
    claude_hook_available: bool,
    codex_hook_available: bool,
    total_input_tokens: Option<u64>,
    total_output_tokens: Option<u64>,
    saved_tokens: Option<u64>,
    savings_percent: Option<f64>,
    command_count: Option<u64>,
    scope: &'static str,
    source: &'static str,
    estimation_method: &'static str,
    codex_tool_output_limit: u64,
    reason: Option<String>,
    executable_path: Option<String>,
    database_path: Option<String>,
    project_path: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MeasurementScope {
    #[default]
    Agentdeck,
    Project,
    Global,
}

impl MeasurementScope {
    fn name(self) -> &'static str {
        match self {
            Self::Agentdeck => "agentdeck",
            Self::Project => "project",
            Self::Global => "global",
        }
    }
}

#[derive(Default)]
pub struct LaunchEconomy {
    pub env: Vec<(String, String)>,
    pub guidance: String,
}

fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("token-economy");
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

pub fn enabled(app: &tauri::AppHandle) -> bool {
    directory(app)
        .ok()
        .and_then(|path| fs::read(path.join("settings.json")).ok())
        .and_then(|bytes| serde_json::from_slice::<Config>(&bytes).ok())
        .map(|config| config.enabled)
        .unwrap_or(true)
}

fn capture(program: &str, args: &[&str], env: &[(String, String)]) -> Option<String> {
    capture_in(program, args, env, None)
}

fn capture_in(
    program: &str,
    args: &[&str],
    env: &[(String, String)],
    workdir: Option<&Path>,
) -> Option<String> {
    let mut command = crate::util::background_command(program);
    command
        .args(args)
        .env_remove("RTK_DB_PATH")
        .envs(env.iter().cloned())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(workdir) = workdir {
        command.current_dir(workdir);
    }
    let mut child = command.spawn().ok()?;
    let output = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = output.take(MAX_METADATA_BYTES).read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let bytes = reader.join().ok()?;
                return status
                    .success()
                    .then(|| String::from_utf8_lossy(&bytes).into_owned());
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn capabilities(force: bool) -> Capabilities {
    static CACHE: OnceLock<Mutex<Option<(Instant, Capabilities)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some((time, caps)) = &*guard {
            if !force && time.elapsed() < Duration::from_secs(60) {
                return caps.clone();
            }
        }
    }
    let quiet = vec![("RTK_TELEMETRY_DISABLED".into(), "1".into())];
    // A stale PATH or a WindowsApps alias must not hide a working native install.
    let mut candidates = vec![crate::cli_detect::resolve_command_path("rtk")];
    let executable = if cfg!(windows) { "rtk.exe" } else { "rtk" };
    if let Some(home) = crate::util::home_dir() {
        for folder in [".local/bin", ".cargo/bin", "scoop/shims"] {
            let candidate = home.join(folder).join(executable);
            if candidate.is_file() {
                candidates.push(candidate.to_string_lossy().into_owned());
            }
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(
            std::env::split_paths(&path)
                .map(|directory| directory.join(executable))
                .filter(|candidate| candidate.is_file())
                .map(|candidate| candidate.to_string_lossy().into_owned()),
        );
    }
    let mut seen = HashSet::new();
    let detected = candidates
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .find_map(|path| {
            let version = capture(&path, &["--version"], &quiet)?;
            let version = version.trim().chars().take(100).collect::<String>();
            version
                .to_ascii_lowercase()
                .starts_with("rtk ")
                .then_some((path, version))
        });
    let (path, version) = match detected {
        Some((path, version)) => (Some(path), Some(version)),
        None => (None, None),
    };
    let caps = Capabilities {
        claude_hook: path
            .as_ref()
            .and_then(|path| capture(path, &["hook", "claude", "--help"], &quiet))
            .is_some_and(|text| text.contains("PreToolUse")),
        path,
        version,
    };
    if let Ok(mut guard) = cache.lock() {
        *guard = Some((Instant::now(), caps.clone()));
    }
    caps
}

fn tracking_env(app: &tauri::AppHandle) -> Result<Vec<(String, String)>, String> {
    Ok(vec![
        (
            "RTK_DB_PATH".into(),
            directory(app)?
                .join("history.db")
                .to_string_lossy()
                .into_owned(),
        ),
        ("RTK_TELEMETRY_DISABLED".into(), "1".into()),
    ])
}

pub fn enrich_path(base: &str, rtk_path: Option<&str>) -> String {
    let separator = if cfg!(windows) { ';' } else { ':' };
    let Some(parent) = rtk_path
        .and_then(|path| Path::new(path).parent())
        .filter(|path| !path.as_os_str().is_empty())
    else {
        return base.to_owned();
    };
    let directory = parent.to_string_lossy();
    let remaining = base
        .split(separator)
        .filter(|item| {
            if cfg!(windows) {
                !item.eq_ignore_ascii_case(&directory)
            } else {
                *item != directory
            }
        })
        .collect::<Vec<_>>()
        .join(&separator.to_string());
    format!("{directory}{separator}{remaining}")
}

fn merge_claude_hook(settings: &mut Value) -> Result<(), ()> {
    if !settings.is_object() || settings["disableAllHooks"] == true {
        return Err(());
    }
    let hooks = settings
        .as_object_mut()
        .ok_or(())?
        .entry("hooks")
        .or_insert_with(|| json!({}));
    let groups = hooks
        .as_object_mut()
        .ok_or(())?
        .entry("PreToolUse")
        .or_insert_with(|| json!([]));
    let groups = groups.as_array_mut().ok_or(())?;
    if groups.iter().any(|group| {
        group["hooks"].as_array().is_some_and(|hooks| {
            hooks.iter().any(|hook| {
                hook["command"].as_str().is_some_and(|command| {
                    command.contains("rtk hook claude") || command.contains("rtk-rewrite")
                })
            })
        })
    }) {
        return Ok(());
    }
    groups.push(json!({"matcher":"Bash", "hooks":[{
        "type":"command", "command":"rtk hook claude", "timeout":5
    }]}));
    Ok(())
}

fn read_settings(value: &str, workdir: &str) -> Option<Value> {
    if value.trim_start().starts_with('{') {
        return serde_json::from_str(value).ok();
    }
    let path = crate::util::resolve_path_from_workdir(workdir, value);
    let file = fs::File::open(path).ok()?;
    let mut content = String::new();
    file.take(MAX_METADATA_BYTES)
        .read_to_string(&mut content)
        .ok()?;
    serde_json::from_str(&content).ok()
}

fn add_claude_overlay(
    app: &tauri::AppHandle,
    workdir: &str,
    session_id: &str,
    args: &mut Vec<String>,
) {
    let settings_position = args
        .iter()
        .position(|arg| arg == "--settings" || arg.starts_with("--settings="));
    let mut settings = match settings_position {
        Some(position) => {
            let value = args[position]
                .strip_prefix("--settings=")
                .or_else(|| args.get(position + 1).map(String::as_str));
            let Some(settings) = value.and_then(|value| read_settings(value, workdir)) else {
                return;
            };
            settings
        }
        None => json!({}),
    };
    if merge_claude_hook(&mut settings).is_err() {
        return;
    }
    // Never use the caller's identifier as a path component without sanitizing it.
    let name: String = session_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(100)
        .collect();
    let Ok(directory) = directory(app) else {
        return;
    };
    let overlay = directory.join(format!(
        "claude-{}-settings.json",
        if name.is_empty() { "session" } else { &name }
    ));
    let Ok(bytes) = serde_json::to_vec(&settings) else {
        return;
    };
    if fs::write(&overlay, bytes).is_err() {
        return;
    }
    let value = overlay.to_string_lossy().into_owned();
    if let Some(position) = settings_position {
        if args[position].starts_with("--settings=") {
            args[position] = format!("--settings={value}");
        } else if let Some(argument) = args.get_mut(position + 1) {
            *argument = value;
        }
    } else {
        args.extend(["--settings".into(), value]);
    }
}

fn add_claude_guidance(args: &mut Vec<String>, guidance: &str) {
    if let Some(position) = args.iter().position(|arg| arg == "--append-system-prompt") {
        if let Some(value) = args.get_mut(position + 1) {
            value.push_str(&format!("\n\n{guidance}"));
        }
    } else if let Some(value) = args
        .iter_mut()
        .find(|arg| arg.starts_with("--append-system-prompt="))
    {
        value.push_str(&format!("\n\n{guidance}"));
    } else if !args.iter().any(|arg| {
        arg == "--append-system-prompt-file" || arg.starts_with("--append-system-prompt-file=")
    }) {
        args.extend(["--append-system-prompt".into(), guidance.into()]);
    }
}

fn minimum_configured_limit(paths: &[PathBuf]) -> Option<u64> {
    let mut limit = CODEX_TOOL_BUDGET;
    for path in paths.iter().filter(|path| path.exists()) {
        let mut content = String::new();
        fs::File::open(path)
            .ok()?
            .take(MAX_METADATA_BYTES)
            .read_to_string(&mut content)
            .ok()?;
        let config = toml::from_str::<toml::Value>(&content).ok()?;
        // Named profiles can be layered from separate files. Leave their explicit policy intact.
        if config
            .get("profile")
            .and_then(toml::Value::as_str)
            .is_some()
        {
            return None;
        }
        if let Some(value) = config.get("tool_output_token_limit") {
            let configured = value.as_integer()?;
            if configured <= 0 {
                return None;
            }
            limit = limit.min(configured as u64);
        }
    }
    Some(limit)
}

fn codex_tool_limit(cli_path: &str, workdir: &str) -> Option<u64> {
    let mut paths = Vec::new();
    if let Some(path) = crate::util::resolve_provider_file_path("codex", cli_path, "config.toml") {
        paths.push(path);
    }
    for directory in Path::new(workdir).ancestors() {
        let candidate = directory.join(".codex").join("config.toml");
        if !paths.contains(&candidate) {
            paths.push(candidate);
        }
    }
    minimum_configured_limit(&paths)
}

/// Applies only to this CLI process; inherited provider files and approval settings stay intact.
pub fn prepare_launch(
    app: &tauri::AppHandle,
    provider: &str,
    workdir: &str,
    cli_path: &str,
    session_id: &str,
    args: &mut Vec<String>,
) -> LaunchEconomy {
    if !enabled(app) {
        return LaunchEconomy::default();
    }
    let caps = capabilities(false);
    let guidance = if caps.path.is_some() {
        GUIDANCE
    } else {
        NO_RTK_GUIDANCE
    };
    let mut environment = tracking_env(app).unwrap_or_default();
    if let Some(path) = &caps.path {
        environment.push(("AGENTDECK_RTK_PATH".into(), path.clone()));
    }
    if provider == "claude-code" {
        if caps.claude_hook {
            add_claude_overlay(app, workdir, session_id, args);
        }
        add_claude_guidance(args, guidance);
    }
    if provider == "codex"
        && !args
            .iter()
            .any(|argument| argument.contains("tool_output_token_limit"))
        && !args.iter().any(|argument| {
            argument == "--profile" || argument == "-p" || argument.starts_with("--profile=")
        })
    {
        // Root-level -c is supported by both the TUI and exec/resume. Never override an explicit CLI value.
        if let Some(limit) = codex_tool_limit(cli_path, workdir) {
            args.splice(
                0..0,
                ["-c".into(), format!("tool_output_token_limit={limit}")],
            );
        }
    }
    if provider == "codex"
        && caps.claude_hook
        && args.iter().any(|arg| {
            arg.contains("danger-full-access")
                || arg == "--dangerously-bypass-approvals-and-sandbox"
        })
    {
        if let (Some(path), Ok(executable)) = (&caps.path, std::env::current_exe()) {
            use base64::Engine;
            let context = base64::engine::general_purpose::STANDARD
                .encode(json!({"rtkPath":path,"provider":"codex"}).to_string());
            let definition = json!({"type":"command","command":crate::memory_capture::callback_command(&executable.to_string_lossy(),"--rtk-hook",&context),"timeout":5});
            if let Err(error) = crate::memory_capture::codex_rtk_override(definition, args) {
                let _ = app.emit(
                    "token-economy-error",
                    json!({"sessionId":session_id,"error":error}),
                );
            }
        }
    }
    LaunchEconomy {
        env: environment,
        guidance: if provider == "claude-code" || !needs_guidance(provider, session_id) {
            String::new()
        } else {
            guidance.into()
        },
    }
}

pub fn append_guidance(prompt: &mut String, guidance: &str) {
    if !guidance.is_empty() && !prompt.trim_start().starts_with('/') {
        prompt.push_str(&format!("\n\n[Agentdeck session guidance]\n{guidance}"));
    }
}

pub fn followup_guidance(app: &tauri::AppHandle, provider: &str, session_id: &str) -> String {
    if !enabled(app) || provider == "claude-code" || !needs_guidance(provider, session_id) {
        return String::new();
    }
    if capabilities(false).path.is_some() {
        GUIDANCE.into()
    } else {
        NO_RTK_GUIDANCE.into()
    }
}

/// Economy mode bounds retrieved excerpts rather than deleting them based on unsafe conversation-cache assumptions.
pub fn knowledge_limits(app: &tauri::AppHandle) -> (usize, usize) {
    if enabled(app) {
        (2, 800)
    } else {
        (3, 1200)
    }
}

fn summary_values(
    value: &Value,
) -> (
    Option<u64>,
    Option<u64>,
    Option<u64>,
    Option<f64>,
    Option<u64>,
) {
    let summary = &value["summary"];
    (
        summary["total_input"].as_u64(),
        summary["total_output"].as_u64(),
        summary["total_saved"].as_u64(),
        summary["avg_savings_pct"]
            .as_f64()
            .filter(|value| value.is_finite() && (0.0..=100.0).contains(value)),
        summary["total_commands"].as_u64(),
    )
}

fn status(
    app: &tauri::AppHandle,
    scope: MeasurementScope,
    workdir: Option<&str>,
    force: bool,
) -> TokenEconomyStatus {
    let caps = capabilities(force);
    let database_path = (scope != MeasurementScope::Global)
        .then(|| {
            directory(app)
                .ok()
                .map(|directory| directory.join("history.db").to_string_lossy().into_owned())
        })
        .flatten();
    let mut result = TokenEconomyStatus {
        enabled: enabled(app),
        available: caps.path.is_some(),
        version: caps.version,
        claude_hook_available: caps.claude_hook,
        // Adapter availability is not a claim of native hook trust or execution.
        codex_hook_available: caps.claude_hook,
        total_input_tokens: None,
        total_output_tokens: None,
        saved_tokens: None,
        savings_percent: None,
        command_count: None,
        scope: scope.name(),
        source: if scope == MeasurementScope::Project {
            "rtk gain --project --format json"
        } else {
            "rtk gain --format json"
        },
        estimation_method: "bytes/4",
        codex_tool_output_limit: CODEX_TOOL_BUDGET,
        reason: None,
        executable_path: caps.path.clone(),
        database_path,
        project_path: (scope == MeasurementScope::Project)
            .then(|| workdir.map(str::to_owned))
            .flatten(),
    };
    let Some(path) = caps.path else {
        result.reason = Some(
            "RTK is not installed. Scoped reading and concise-output guidance remain available."
                .into(),
        );
        return result;
    };
    let project = if scope == MeasurementScope::Project {
        let Some(project) = workdir
            .map(Path::new)
            .filter(|path| path.is_absolute() && path.is_dir())
        else {
            result.reason = Some("The project folder is unavailable; choose an existing project to measure its commands.".into());
            return result;
        };
        Some(project)
    } else {
        None
    };
    let environment = if scope == MeasurementScope::Global {
        Ok(vec![("RTK_TELEMETRY_DISABLED".into(), "1".into())])
    } else {
        tracking_env(app)
    };
    let arguments = if project.is_some() {
        vec!["gain", "--project", "--format", "json"]
    } else {
        vec!["gain", "--format", "json"]
    };
    let measurement = environment
        .ok()
        .and_then(|env| capture_in(&path, &arguments, &env, project))
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    if let Some(measurement) = measurement {
        (
            result.total_input_tokens,
            result.total_output_tokens,
            result.saved_tokens,
            result.savings_percent,
            result.command_count,
        ) = summary_values(&measurement);
    }
    if result.command_count.is_none() {
        result.reason =
            Some("RTK is available but its local measurements could not be read.".into());
    }
    result
}

#[tauri::command]
pub async fn get_token_economy_status(
    app: tauri::AppHandle,
    workdir: Option<String>,
    scope: Option<MeasurementScope>,
    force: Option<bool>,
) -> Result<TokenEconomyStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        status(
            &app,
            scope.unwrap_or_default(),
            workdir.as_deref(),
            force.unwrap_or(false),
        )
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn set_token_economy_enabled(
    app: tauri::AppHandle,
    enabled: bool,
    workdir: Option<String>,
    scope: Option<MeasurementScope>,
) -> Result<TokenEconomyStatus, String> {
    let path = directory(&app)?.join("settings.json");
    fs::write(
        path,
        serde_json::to_vec(&Config { enabled }).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    // Re-enabling economy must deliver RTK guidance to existing Codex chats too.
    if let Ok(mut delivered) = delivered_guidance().lock() {
        delivered.clear();
    }
    let _ = app.emit("token-economy-changed", json!({"enabled":enabled}));
    get_token_economy_status(app, workdir, scope, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_overlay_preserves_hooks_statusline_and_approval_settings() {
        let mut settings = json!({
            "fastMode": false, "ultracode": false,
            "permissions":{"defaultMode":"plan"}, "statusLine":{"command":"custom-status"},
            "hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"security-check"}]}],
                "Stop":[{"hooks":[{"command":"notify"}]}]}
        });
        merge_claude_hook(&mut settings).unwrap();
        merge_claude_hook(&mut settings).unwrap();
        assert_eq!(settings["hooks"]["PreToolUse"].as_array().unwrap().len(), 2);
        assert_eq!(settings["permissions"]["defaultMode"], "plan");
        assert_eq!(settings["statusLine"]["command"], "custom-status");
        assert_eq!(settings["fastMode"], false);
        assert_eq!(settings["ultracode"], false);
        assert_eq!(
            settings["hooks"]["Stop"][0]["hooks"][0]["command"],
            "notify"
        );
        assert!(!settings.to_string().contains("permissionDecision"));
        let mut disabled = json!({"disableAllHooks":true});
        assert!(merge_claude_hook(&mut disabled).is_err());
    }

    #[test]
    fn stats_require_real_nonnegative_values_and_are_not_account_tokens() {
        assert_eq!(
            summary_values(
                &json!({"summary":{"total_commands":3,"total_input":100,"total_output":30,"total_saved":70,"avg_savings_pct":70.0}})
            ),
            (Some(100), Some(30), Some(70), Some(70.0), Some(3))
        );
        assert_eq!(
            summary_values(&json!({"summary":{"total_saved":-1,"avg_savings_pct":150}})),
            (None, None, None, None, None)
        );
        assert_eq!(summary_values(&json!({})), (None, None, None, None, None));
        assert_eq!(
            summary_values(
                &json!({"summary":{"total_commands":0,"total_input":0,"total_output":0,"total_saved":0,"avg_savings_pct":0.0}})
            ),
            (Some(0), Some(0), Some(0), Some(0.0), Some(0))
        );
    }

    #[test]
    fn detected_rtk_directory_takes_precedence_over_other_path_entries() {
        let separator = if cfg!(windows) { ';' } else { ':' };
        let directory = std::env::temp_dir().join("agentdeck-rtk-path");
        let executable = directory.join(if cfg!(windows) { "rtk.exe" } else { "rtk" });
        let base = format!("other{separator}{}{separator}last", directory.display());
        let enriched = enrich_path(&base, executable.to_str());
        assert_eq!(enriched.split(separator).next(), directory.to_str());
        assert_eq!(
            enriched
                .split(separator)
                .filter(|entry| *entry == directory.to_string_lossy())
                .count(),
            1
        );
        assert_eq!(enrich_path(&base, None), base);
    }

    #[test]
    #[ignore = "requires a locally installed RTK; run explicitly for end-to-end verification"]
    fn installed_rtk_tracks_an_isolated_database_and_separates_projects() {
        let caps = capabilities(true);
        let executable = caps
            .path
            .expect("RTK must be installed for this integration test");
        let root =
            std::env::temp_dir().join(format!("agentdeck-rtk-check-{}", uuid::Uuid::new_v4()));
        let first = root.join("first");
        let second = root.join("second");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        let env = vec![
            (
                "RTK_DB_PATH".into(),
                root.join("history.db").to_string_lossy().into_owned(),
            ),
            ("RTK_TELEMETRY_DISABLED".into(), "1".into()),
        ];
        let measure = |directory: &Path, project: bool| {
            let arguments = if project {
                vec!["gain", "--project", "--format", "json"]
            } else {
                vec!["gain", "--format", "json"]
            };
            let output = capture_in(&executable, &arguments, &env, Some(directory)).unwrap();
            summary_values(&serde_json::from_str::<Value>(&output).unwrap())
        };
        assert_eq!(measure(&first, false).4, Some(0));
        for directory in [&first, &second] {
            capture_in(
                &executable,
                &["proxy", &executable, "--version"],
                &env,
                Some(directory),
            )
            .expect("RTK proxy must run and preserve tracking env");
        }
        assert_eq!(measure(&first, false).4, Some(2));
        assert_eq!(measure(&first, true).4, Some(1));
        assert_eq!(measure(&second, true).4, Some(1));
        assert!(measure(&first, false).0.unwrap() > 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guidance_preserves_existing_custom_system_prompt_and_slash_commands() {
        let mut args = vec![
            "--append-system-prompt".into(),
            "Existing user instructions".into(),
        ];
        add_claude_guidance(&mut args, GUIDANCE);
        assert!(args[1].starts_with("Existing user instructions\n\n"));
        assert!(args[1].contains("saved full-output log"));
        let mut command = "/compact".to_owned();
        append_guidance(&mut command, GUIDANCE);
        assert_eq!(command, "/compact");
    }

    #[test]
    fn guidance_is_sent_once_per_conversation_and_rearmed_after_compaction() {
        let session = uuid::Uuid::new_v4().to_string();
        assert!(needs_guidance("codex", &session));
        mark_guidance_delivered("codex", &session);
        assert!(!needs_guidance("codex", &session));
        assert!(needs_guidance("claude-code", &session));
        reset_after_compaction("codex", &session, "/compact keep the current goal");
        assert!(needs_guidance("codex", &session));
    }

    #[test]
    fn codex_never_increases_a_smaller_layered_limit_or_overrides_unknown_profiles() {
        let directory =
            std::env::temp_dir().join(format!("agentdeck-economy-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let user = directory.join("user.toml");
        let project = directory.join("project.toml");
        fs::write(&user, "tool_output_token_limit = 10000").unwrap();
        fs::write(&project, "tool_output_token_limit = 1000").unwrap();
        assert_eq!(
            minimum_configured_limit(&[user.clone(), project.clone()]),
            Some(1000)
        );
        fs::write(&project, "profile = 'careful'").unwrap();
        assert_eq!(
            minimum_configured_limit(&[user.clone(), project.clone()]),
            None
        );
        fs::write(&project, "[invalid").unwrap();
        assert_eq!(minimum_configured_limit(&[user, project]), None);
        fs::remove_dir_all(directory).unwrap();
    }
}
