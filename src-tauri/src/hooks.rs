use std::fs;
use std::io::Read;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::Manager;

use crate::provider_sessions::emit_provider_session_bound;
use crate::session_lifecycle::{
    emit_session_lifecycle, HookSource, SessionLifecycleSignal, SessionRoutingHint,
};
#[cfg(not(unix))]
use crate::util::home_dir;
use crate::util::resolve_provider_file_path;

#[derive(Debug, Clone)]
struct HookCommandSpec {
    event_name: &'static str,
    matcher: Option<&'static str>,
    command: String,
    shell: Option<&'static str>,
    timeout: Option<u64>,
    status_message: Option<&'static str>,
}

#[cfg(unix)]
fn hook_bridge_command(source: HookSource) -> Result<String, String> {
    let source_name = source.label();
    let socket_path = source.socket_path();
    Ok(format!(
        "/usr/bin/python3 -c 'import json, os, socket, sys; payload=json.load(sys.stdin); sid=os.environ.get(\"AGENTDECK_SESSION_ID\"); runner=os.environ.get(\"AGENTDECK_RUNNER_TYPE\"); payload[\"agentdeck_source\"]=\"{source_name}\"; payload[\"agentdeck_session_id\"]=sid if sid else payload.get(\"agentdeck_session_id\"); payload[\"agentdeck_runner_type\"]=runner if runner else payload.get(\"agentdeck_runner_type\"); sock=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); sock.connect(\"{socket_path}\"); sock.sendall(json.dumps(payload).encode(\"utf-8\")); sock.close()' >/dev/null 2>&1 || true"
    ))
}

#[cfg(not(unix))]
const WINDOWS_POWERSHELL: &str = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";

#[cfg(not(unix))]
const WINDOWS_BRIDGE_SCRIPT: &str = r#"param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$PayloadArgs
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

try {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw) -and $PayloadArgs.Count -gt 0) {
    $raw = $PayloadArgs -join ' '
  }
  if ([string]::IsNullOrWhiteSpace($raw)) {
    exit 0
  }

  $payload = $raw | ConvertFrom-Json
  if (-not $payload) {
    exit 0
  }

  $sessionId = $env:AGENTDECK_SESSION_ID
  $runnerType = $env:AGENTDECK_RUNNER_TYPE
  if ($sessionId) {
    $payload | Add-Member -NotePropertyName agentdeck_session_id -NotePropertyValue $sessionId -Force
  }
  if ($runnerType) {
    $payload | Add-Member -NotePropertyName agentdeck_runner_type -NotePropertyValue $runnerType -Force
  }
  $payload | Add-Member -NotePropertyName agentdeck_source -NotePropertyValue $Source -Force

  $json = $payload | ConvertTo-Json -Depth 32 -Compress
  $client = [System.Net.Sockets.TcpClient]::new()
  $client.Connect([System.Net.IPAddress]::Loopback, $Port)

  try {
    $stream = $client.GetStream()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
  } finally {
    if ($stream) {
      $stream.Dispose()
    }
    $client.Dispose()
  }
} catch {
  try {
    $logPath = Join-Path (Split-Path -Parent $PSCommandPath) 'bridge-error.log'
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
    Add-Content -LiteralPath $logPath -Value "$stamp [$Source] $($_.Exception.Message)" -Encoding utf8
  } catch {
  }
  exit 0
}
"#;

#[cfg(not(unix))]
fn windows_hook_dir() -> Result<PathBuf, String> {
    let home = home_dir().ok_or(crate::i18n::native_text("native.home", "HOME"))?;
    Ok(home.join(".agentdeck").join("hooks"))
}

#[cfg(not(unix))]
fn windows_bridge_script_path() -> Result<PathBuf, String> {
    Ok(windows_hook_dir()?.join("hook-bridge.ps1"))
}

#[cfg(not(unix))]
fn escape_powershell_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(not(unix))]
fn powershell_script_command(source: HookSource) -> Result<String, String> {
    let script = windows_bridge_script_path()?;
    let script = escape_powershell_single_quoted(&script.to_string_lossy());
    Ok(format!(
        "& '{script}' -Source '{}' -Port {}",
        source.label(),
        source.tcp_port()
    ))
}

#[cfg(not(unix))]
fn codex_notify_command() -> Result<Vec<String>, String> {
    let script = windows_bridge_script_path()?;
    Ok(vec![
        WINDOWS_POWERSHELL.to_string(),
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-ExecutionPolicy".to_string(),
        "Bypass".to_string(),
        "-File".to_string(),
        script.to_string_lossy().to_string(),
        "-Source".to_string(),
        HookSource::Codex.label().to_string(),
        "-Port".to_string(),
        HookSource::Codex.tcp_port().to_string(),
    ])
}

#[cfg(not(unix))]
fn write_text_file_if_changed(path: &PathBuf, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            crate::i18n::native_text("native.create", &format!("{} : {e}", parent.display()))
        })?;
    }

    let needs_write = match fs::read_to_string(path) {
        Ok(existing) => existing != content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => true,
        Err(err) => {
            return Err(crate::i18n::native_text(
                "native.read",
                &format!("{} : {err}", path.display()),
            ))
        }
    };

    if needs_write {
        fs::write(path, content).map_err(|e| {
            crate::i18n::native_text("native.write", &format!("{} : {e}", path.display()))
        })?;
    }

    Ok(())
}

#[cfg(not(unix))]
fn ensure_windows_hook_bridge_assets() -> Result<(), String> {
    let script_path = windows_bridge_script_path()?;
    write_text_file_if_changed(&script_path, WINDOWS_BRIDGE_SCRIPT)?;
    Ok(())
}

#[cfg(not(unix))]
fn hook_bridge_command(source: HookSource) -> Result<String, String> {
    ensure_windows_hook_bridge_assets()?;
    powershell_script_command(source)
}

fn hook_specs(source: HookSource) -> Result<Vec<HookCommandSpec>, String> {
    let command = hook_bridge_command(source)?;
    #[cfg(unix)]
    let shell = None;
    #[cfg(not(unix))]
    let shell = Some("powershell");

    match source {
        HookSource::ClaudeCode => Ok(vec![
            HookCommandSpec {
                event_name: "UserPromptSubmit",
                matcher: Some(""),
                command: command.clone(),
                shell,
                timeout: None,
                status_message: None,
            },
            HookCommandSpec {
                event_name: "Stop",
                matcher: Some(""),
                command: command.clone(),
                shell,
                timeout: None,
                status_message: None,
            },
            HookCommandSpec {
                event_name: "StopFailure",
                matcher: Some(""),
                command: command.clone(),
                shell,
                timeout: None,
                status_message: None,
            },
            HookCommandSpec {
                event_name: "Notification",
                matcher: Some(""),
                command,
                shell,
                timeout: None,
                status_message: None,
            },
        ]),
        #[cfg(unix)]
        HookSource::Codex => Ok(vec![
            HookCommandSpec {
                event_name: "UserPromptSubmit",
                matcher: None,
                command: command.clone(),
                shell: None,
                timeout: Some(5),
                status_message: None,
            },
            HookCommandSpec {
                event_name: "Stop",
                matcher: None,
                command,
                shell: None,
                timeout: Some(5),
                status_message: None,
            },
        ]),
        #[cfg(not(unix))]
        HookSource::Codex => Ok(Vec::new()),
    }
}

fn is_managed_command(command: &str, source: HookSource) -> bool {
    #[cfg(unix)]
    {
        let socket_path = source.socket_path();
        return command.contains(&socket_path);
    }

    #[cfg(not(unix))]
    {
        is_managed_windows_command(command, source)
    }
}

#[cfg(not(unix))]
fn is_managed_windows_command(command: &str, source: HookSource) -> bool {
    let normalized = command.replace('\\', "/").to_ascii_lowercase();
    if let Some(home) = home_dir() {
        for namespace in [".agentdeck"] {
            let bridge = home
                .join(namespace)
                .join("hooks/hook-bridge.ps1")
                .to_string_lossy()
                .replace('\\', "/")
                .to_ascii_lowercase();
            if normalized.contains(&bridge) || normalized.contains(&bridge.replace('\'', "''")) {
                return true;
            }
        }
    }
    // Older versions used an encoded inline bridge. Decode it before deciding ownership;
    // EncodedCommand by itself can belong to an unrelated user/security hook.
    let arguments = command.split_whitespace().collect::<Vec<_>>();
    let Some(position) = arguments
        .iter()
        .position(|argument| argument.eq_ignore_ascii_case("-EncodedCommand"))
    else {
        return false;
    };
    let Some(encoded) = arguments.get(position + 1) else {
        return false;
    };
    use base64::Engine;
    let Ok(bytes) =
        base64::engine::general_purpose::STANDARD.decode(encoded.trim_matches(['\'', '"']))
    else {
        return false;
    };
    if bytes.len() % 2 != 0 {
        return false;
    }
    let words = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    let Ok(script) = String::from_utf16(&words) else {
        return false;
    };
    let script = script.to_ascii_lowercase();
    script.contains("agentdeck_session_id")
        && script.contains("tcpclient")
        && script.contains(&source.tcp_port().to_string())
}

fn load_json_file(path: &PathBuf) -> Result<Value, String> {
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = fs::read_to_string(path).map_err(|e| {
        crate::i18n::native_text("native.read", &format!("{} : {e}", path.display()))
    })?;
    Ok(serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({})))
}

fn ensure_hooks_object<'a>(
    root: &'a mut Value,
    path_label: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    if root.get("hooks").is_none() {
        root["hooks"] = serde_json::json!({});
    }
    root["hooks"].as_object_mut().ok_or_else(|| {
        crate::i18n::native_text("native.invalidConfig", &format!("{path_label} hooks"))
    })
}

fn build_hook_entry(spec: &HookCommandSpec) -> Value {
    let mut hook = serde_json::json!({
        "type": "command",
        "command": spec.command.clone(),
    });
    if let Some(shell) = spec.shell {
        hook["shell"] = Value::from(shell);
    }
    if let Some(timeout) = spec.timeout {
        hook["timeout"] = Value::from(timeout);
    }
    if let Some(status_message) = spec.status_message {
        hook["statusMessage"] = Value::from(status_message);
    }

    let mut group = Map::new();
    if let Some(matcher) = spec.matcher {
        group.insert("matcher".to_string(), Value::from(matcher));
    }
    group.insert("hooks".to_string(), Value::Array(vec![hook]));
    Value::Object(group)
}

fn normalize_managed_hook(hook: &mut Value, spec: &HookCommandSpec) -> bool {
    let Some(obj) = hook.as_object_mut() else {
        *hook = serde_json::json!({});
        return normalize_managed_hook(hook, spec);
    };

    let mut changed = false;

    if obj.get("type").and_then(|v| v.as_str()) != Some("command") {
        obj.insert("type".to_string(), Value::from("command"));
        changed = true;
    }
    if obj.get("command").and_then(|v| v.as_str()) != Some(spec.command.as_str()) {
        obj.insert("command".to_string(), Value::from(spec.command.clone()));
        changed = true;
    }
    match spec.shell {
        Some(shell) => {
            if obj.get("shell").and_then(|v| v.as_str()) != Some(shell) {
                obj.insert("shell".to_string(), Value::from(shell));
                changed = true;
            }
        }
        None => {
            if obj.remove("shell").is_some() {
                changed = true;
            }
        }
    }

    match spec.timeout {
        Some(timeout) => {
            if obj.get("timeout").and_then(|v| v.as_u64()) != Some(timeout) {
                obj.insert("timeout".to_string(), Value::from(timeout));
                changed = true;
            }
        }
        None => {
            if obj.remove("timeout").is_some() {
                changed = true;
            }
        }
    }

    match spec.status_message {
        Some(status_message) => {
            if obj.get("statusMessage").and_then(|v| v.as_str()) != Some(status_message) {
                obj.insert("statusMessage".to_string(), Value::from(status_message));
                changed = true;
            }
        }
        None => {
            if obj.remove("statusMessage").is_some() {
                changed = true;
            }
        }
    }

    changed
}

fn merge_hook_specs(
    root: &mut Value,
    source: HookSource,
    specs: &[HookCommandSpec],
    path_label: &str,
) -> Result<Vec<String>, String> {
    let hooks_obj = ensure_hooks_object(root, path_label)?;
    let mut changed_events = Vec::new();

    for spec in specs {
        let event_value = hooks_obj
            .entry(spec.event_name.to_string())
            .or_insert_with(|| Value::Array(Vec::new()));

        if !event_value.is_array() {
            *event_value = Value::Array(Vec::new());
        }
        let event_arr = event_value.as_array_mut().ok_or_else(|| {
            crate::i18n::native_text(
                "native.invalidConfig",
                &format!("{path_label} {} hooks", spec.event_name),
            )
        })?;

        let mut has_current_command = false;
        let mut event_changed = false;

        event_arr.retain_mut(|group| {
            let Some(group_obj) = group.as_object_mut() else {
                event_changed = true;
                return false;
            };

            let hooks = group_obj
                .entry("hooks".to_string())
                .or_insert_with(|| Value::Array(Vec::new()));

            if !hooks.is_array() {
                *hooks = Value::Array(Vec::new());
                event_changed = true;
            }

            let hook_arr = hooks.as_array_mut().expect("hooks array just normalized");
            let before_len = hook_arr.len();

            hook_arr.retain_mut(|hook| {
                let command = hook.get("command").and_then(|v| v.as_str()).unwrap_or("");
                if command == spec.command {
                    if has_current_command {
                        event_changed = true;
                        return false;
                    }
                    has_current_command = true;
                    if normalize_managed_hook(hook, spec) {
                        event_changed = true;
                    }
                    return true;
                }
                if is_managed_command(command, source) {
                    event_changed = true;
                    return false;
                }
                true
            });

            if hook_arr.len() != before_len {
                event_changed = true;
            }

            !hook_arr.is_empty()
        });

        if !has_current_command {
            event_arr.push(build_hook_entry(spec));
            event_changed = true;
        }

        if event_changed {
            changed_events.push(spec.event_name.to_string());
        }
    }

    Ok(changed_events)
}

fn save_json_file(path: &PathBuf, json: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            crate::i18n::native_text("native.create", &format!("{} : {e}", parent.display()))
        })?;
    }
    let output = serde_json::to_string_pretty(json).map_err(|e| {
        crate::i18n::native_text("native.serialize", &format!("{} : {e}", path.display()))
    })?;
    fs::write(path, output)
        .map_err(|e| crate::i18n::native_text("native.write", &format!("{} : {e}", path.display())))
}

fn strip_managed_hooks(root: &mut Value, source: HookSource) -> bool {
    let Some(hooks_obj) = root
        .get_mut("hooks")
        .and_then(|value| value.as_object_mut())
    else {
        return false;
    };

    let event_names: Vec<String> = hooks_obj.keys().cloned().collect();
    let mut changed = false;
    let mut empty_events = Vec::new();

    for event_name in event_names {
        let Some(event_value) = hooks_obj.get_mut(&event_name) else {
            continue;
        };
        let Some(event_arr) = event_value.as_array_mut() else {
            continue;
        };

        let before_group_len = event_arr.len();
        event_arr.retain_mut(|group| {
            let Some(group_obj) = group.as_object_mut() else {
                changed = true;
                return false;
            };

            let Some(hooks_value) = group_obj.get_mut("hooks") else {
                changed = true;
                return false;
            };
            let Some(hook_arr) = hooks_value.as_array_mut() else {
                changed = true;
                return false;
            };

            let before_hook_len = hook_arr.len();
            hook_arr.retain(|hook| {
                let command = hook.get("command").and_then(|v| v.as_str()).unwrap_or("");
                !is_managed_command(command, source)
            });
            if hook_arr.len() != before_hook_len {
                changed = true;
            }

            !hook_arr.is_empty()
        });

        if event_arr.len() != before_group_len {
            changed = true;
        }

        if event_arr.is_empty() {
            empty_events.push(event_name);
        }
    }

    for event_name in empty_events {
        hooks_obj.remove(&event_name);
        changed = true;
    }

    changed
}

fn has_managed_hook_for_spec(root: &Value, spec: &HookCommandSpec) -> bool {
    root.get("hooks")
        .and_then(|value| value.as_object())
        .and_then(|hooks_obj| hooks_obj.get(spec.event_name))
        .and_then(|value| value.as_array())
        .is_some_and(|groups| {
            groups.iter().any(|group| {
                group
                    .get("hooks")
                    .and_then(|value| value.as_array())
                    .is_some_and(|hooks| {
                        hooks.iter().any(|hook| {
                            hook.get("command").and_then(|value| value.as_str())
                                == Some(spec.command.as_str())
                        })
                    })
            })
        })
}

fn missing_managed_events(root: &Value, specs: &[HookCommandSpec]) -> Vec<String> {
    specs
        .iter()
        .filter(|spec| !has_managed_hook_for_spec(root, spec))
        .map(|spec| spec.event_name.to_string())
        .collect()
}

fn ensure_claude_hook_settings() -> Result<String, String> {
    let settings_path = resolve_provider_file_path("claude-code", "", "settings.json")
        .ok_or(crate::i18n::native_text("native.parse", "Claude Code"))?;
    let mut settings = load_json_file(&settings_path)?;
    let specs = hook_specs(HookSource::ClaudeCode)?;
    let changed = merge_hook_specs(
        &mut settings,
        HookSource::ClaudeCode,
        &specs,
        &settings_path.display().to_string(),
    )?;

    if changed.is_empty() {
        return Ok(crate::i18n::native_text("native.upToDate", "Claude Code hooks").to_string());
    }

    save_json_file(&settings_path, &settings)?;
    Ok(crate::i18n::native_text(
        "native.configured",
        &format!(
            "Claude Code hooks: {} ({})",
            settings_path.display(),
            changed.join(", ")
        ),
    ))
}

fn disable_claude_hook_settings() -> Result<String, String> {
    let settings_path = resolve_provider_file_path("claude-code", "", "settings.json")
        .ok_or(crate::i18n::native_text("native.parse", "Claude Code"))?;
    let mut settings = load_json_file(&settings_path)?;
    let changed = strip_managed_hooks(&mut settings, HookSource::ClaudeCode);

    if !changed {
        return Ok(crate::i18n::native_text("native.disabled", "Claude Code hooks").to_string());
    }

    save_json_file(&settings_path, &settings)?;
    Ok(crate::i18n::native_text(
        "native.disabled",
        &format!("Claude Code hooks: {}", settings_path.display()),
    ))
}

fn load_toml_file(path: &PathBuf) -> Result<toml::Table, String> {
    let content = if path.exists() {
        fs::read_to_string(path).map_err(|e| {
            crate::i18n::native_text("native.read", &format!("{} : {e}", path.display()))
        })?
    } else {
        String::new()
    };

    if content.trim().is_empty() {
        Ok(toml::Table::new())
    } else {
        Ok(content
            .parse::<toml::Table>()
            .unwrap_or_else(|_| toml::Table::new()))
    }
}

fn save_toml_file(path: &PathBuf, table: &toml::Table) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            crate::i18n::native_text("native.create", &format!("{} : {e}", parent.display()))
        })?;
    }

    let output = toml::to_string_pretty(table).map_err(|e| {
        crate::i18n::native_text("native.serialize", &format!("{} : {e}", path.display()))
    })?;
    fs::write(path, output)
        .map_err(|e| crate::i18n::native_text("native.write", &format!("{} : {e}", path.display())))
}

#[cfg(unix)]
fn ensure_codex_feature_flag() -> Result<String, String> {
    let config_path = resolve_provider_file_path("codex", "", "config.toml")
        .ok_or(crate::i18n::native_text("native.parse", "Codex"))?;
    let mut config = load_toml_file(&config_path)?;

    let features = config
        .entry("features")
        .or_insert_with(|| toml::Value::Table(toml::Table::new()));

    if !features.is_table() {
        *features = toml::Value::Table(toml::Table::new());
    }

    let features_table = features.as_table_mut().ok_or_else(|| {
        crate::i18n::native_text(
            "native.invalidConfig",
            &format!("{} [features]", config_path.display()),
        )
    })?;

    let already_enabled = features_table.get("codex_hooks").and_then(|v| v.as_bool()) == Some(true);

    if already_enabled {
        return Ok(crate::i18n::native_text(
            "native.enabled",
            &format!("Codex hooks feature : {}", config_path.display()),
        ));
    }

    features_table.insert("codex_hooks".to_string(), toml::Value::Boolean(true));
    save_toml_file(&config_path, &config)?;

    Ok(crate::i18n::native_text(
        "native.enabled",
        &format!("Codex hooks feature: {}", config_path.display()),
    ))
}

#[cfg(not(unix))]
fn ensure_codex_notify_settings() -> Result<String, String> {
    ensure_windows_hook_bridge_assets()?;

    let config_path = resolve_provider_file_path("codex", "", "config.toml")
        .ok_or(crate::i18n::native_text("native.parse", "Codex"))?;
    let mut config = load_toml_file(&config_path)?;
    let desired = codex_notify_command()?;
    let desired_values: Vec<toml::Value> =
        desired.iter().cloned().map(toml::Value::String).collect();

    let notify_changed = match config.get("notify") {
        Some(toml::Value::Array(current)) => current != &desired_values,
        Some(_) => true,
        None => true,
    };

    if notify_changed {
        config.insert("notify".to_string(), toml::Value::Array(desired_values));
        save_toml_file(&config_path, &config)?;
        return Ok(crate::i18n::native_text(
            "native.configured",
            &format!("Codex Windows notify: {}", config_path.display()),
        ));
    }

    Ok(crate::i18n::native_text(
        "native.upToDate",
        &format!("Codex Windows notify : {}", config_path.display()),
    ))
}

#[cfg(unix)]
fn ensure_codex_hook_settings() -> Result<String, String> {
    let hooks_path = resolve_provider_file_path("codex", "", "hooks.json")
        .ok_or(crate::i18n::native_text("native.parse", "Codex"))?;
    let mut hooks = load_json_file(&hooks_path)?;
    let specs = hook_specs(HookSource::Codex)?;
    let changed = merge_hook_specs(
        &mut hooks,
        HookSource::Codex,
        &specs,
        &hooks_path.display().to_string(),
    )?;

    if changed.is_empty() {
        return Ok(crate::i18n::native_text("native.upToDate", "Codex hooks").to_string());
    }

    save_json_file(&hooks_path, &hooks)?;
    Ok(crate::i18n::native_text(
        "native.configured",
        &format!(
            "Codex hooks: {} ({})",
            hooks_path.display(),
            changed.join(", ")
        ),
    ))
}

#[cfg(not(unix))]
fn ensure_codex_hook_settings() -> Result<String, String> {
    ensure_codex_notify_settings()
}

#[cfg(unix)]
fn disable_codex_feature_flag() -> Result<String, String> {
    let config_path = resolve_provider_file_path("codex", "", "config.toml")
        .ok_or(crate::i18n::native_text("native.parse", "Codex"))?;
    let mut config = load_toml_file(&config_path)?;

    let Some(features) = config
        .get_mut("features")
        .and_then(|value| value.as_table_mut())
    else {
        return Ok(crate::i18n::native_text("native.disabled", "Codex hooks feature").to_string());
    };

    let already_disabled = features
        .get("codex_hooks")
        .and_then(|value| value.as_bool())
        != Some(true);

    if already_disabled {
        return Ok(crate::i18n::native_text("native.disabled", "Codex hooks feature").to_string());
    }

    features.insert("codex_hooks".to_string(), toml::Value::Boolean(false));
    save_toml_file(&config_path, &config)?;
    Ok(crate::i18n::native_text(
        "native.disabled",
        &format!("Codex hooks feature: {}", config_path.display()),
    ))
}

#[cfg(unix)]
fn disable_codex_hook_settings() -> Result<String, String> {
    let hooks_path = resolve_provider_file_path("codex", "", "hooks.json")
        .ok_or(crate::i18n::native_text("native.parse", "Codex"))?;
    let mut hooks = load_json_file(&hooks_path)?;
    let changed = strip_managed_hooks(&mut hooks, HookSource::Codex);

    let hook_message = if changed {
        save_json_file(&hooks_path, &hooks)?;
        crate::i18n::native_text(
            "native.disabled",
            &format!("Codex hooks: {}", hooks_path.display()),
        )
    } else {
        crate::i18n::native_text("native.disabled", "Codex hooks").to_string()
    };

    let feature_message = disable_codex_feature_flag()?;
    Ok(format!("{feature_message}\n{hook_message}"))
}

#[cfg(not(unix))]
fn disable_codex_hook_settings() -> Result<String, String> {
    let config_path = resolve_provider_file_path("codex", "", "config.toml")
        .ok_or(crate::i18n::native_text("native.parse", "Codex"))?;
    let mut config = load_toml_file(&config_path)?;

    if config.remove("notify").is_none() {
        return Ok(crate::i18n::native_text("native.disabled", "Codex Windows notify").to_string());
    }

    save_toml_file(&config_path, &config)?;
    Ok(crate::i18n::native_text(
        "native.disabled",
        &format!("Codex Windows notify: {}", config_path.display()),
    ))
}

pub fn disable_all_hooks() -> Result<String, String> {
    let claude = disable_claude_hook_settings()?;
    let codex = disable_codex_hook_settings()?;
    Ok(format!("{claude}\n{codex}"))
}

#[derive(Debug, Serialize)]
pub struct NotificationHookStatus {
    enabled: bool,
    claude_hooks_configured: bool,
    codex_hooks_configured: bool,
    codex_feature_enabled: bool,
    claude_listener_ready: bool,
    codex_listener_ready: bool,
    healthy: bool,
    issues: Vec<String>,
}

fn claude_hooks_configured() -> Result<bool, String> {
    let settings_path = resolve_provider_file_path("claude-code", "", "settings.json")
        .ok_or(crate::i18n::native_text("native.parse", "Claude Code"))?;
    let settings = load_json_file(&settings_path)?;
    let specs = hook_specs(HookSource::ClaudeCode)?;
    Ok(missing_managed_events(&settings, &specs).is_empty())
}

fn codex_hooks_configured() -> Result<bool, String> {
    #[cfg(unix)]
    {
        let hooks_path = resolve_provider_file_path("codex", "", "hooks.json")
            .ok_or(crate::i18n::native_text("native.parse", "Codex"))?;
        let hooks = load_json_file(&hooks_path)?;
        let specs = hook_specs(HookSource::Codex)?;
        return Ok(missing_managed_events(&hooks, &specs).is_empty());
    }

    #[cfg(not(unix))]
    {
        let config_path = resolve_provider_file_path("codex", "", "config.toml")
            .ok_or(crate::i18n::native_text("native.parse", "Codex"))?;
        let config = load_toml_file(&config_path)?;
        return Ok(
            matches!(config.get("notify"), Some(toml::Value::Array(values)) if !values.is_empty()),
        );
    }
}

fn codex_feature_enabled() -> Result<bool, String> {
    #[cfg(unix)]
    {
        let config_path = resolve_provider_file_path("codex", "", "config.toml")
            .ok_or(crate::i18n::native_text("native.parse", "Codex"))?;
        let config = load_toml_file(&config_path)?;
        let enabled = config
            .get("features")
            .and_then(|value| value.as_table())
            .and_then(|table| table.get("codex_hooks"))
            .and_then(|value| value.as_bool())
            == Some(true);
        return Ok(enabled);
    }

    #[cfg(not(unix))]
    {
        Ok(true)
    }
}

fn hook_listener_ready(source: HookSource) -> bool {
    #[cfg(unix)]
    {
        std::path::Path::new(&source.socket_path()).exists()
    }

    #[cfg(not(unix))]
    {
        let _ = source;
        true
    }
}

#[tauri::command]
pub fn setup_claude_hooks() -> Result<String, String> {
    ensure_claude_hook_settings()
}

#[tauri::command]
pub fn setup_codex_hooks() -> Result<String, String> {
    #[cfg(unix)]
    {
        let feature = ensure_codex_feature_flag()?;
        let hooks = ensure_codex_hook_settings()?;
        return Ok(format!("{feature}\n{hooks}"));
    }

    #[cfg(not(unix))]
    {
        let notify = ensure_codex_hook_settings()?;
        return Ok(crate::i18n::native_text(
            "native.nativeHooks",
            &format!("Codex Windows hooks notify \n{notify}"),
        ));
    }

    #[allow(unreachable_code)]
    Ok(String::new())
}

#[tauri::command]
pub fn setup_all_hooks() -> Result<String, String> {
    let claude = ensure_claude_hook_settings()?;
    #[cfg(unix)]
    {
        let codex_feature = ensure_codex_feature_flag()?;
        let codex_hooks = ensure_codex_hook_settings()?;
        return Ok(format!("{claude}\n{codex_feature}\n{codex_hooks}"));
    }

    #[cfg(not(unix))]
    {
        let codex_notify = ensure_codex_hook_settings()?;
        return Ok(crate::i18n::native_text(
            "native.nativeHooks",
            &format!("{claude}\nCodex Windows hooks notify \n{codex_notify}"),
        ));
    }

    #[allow(unreachable_code)]
    Ok(claude)
}

pub fn reconcile_integrations_on_startup(app: &tauri::AppHandle) -> Result<String, String> {
    let locale = crate::i18n::current_locale(&app.state::<crate::i18n::LocaleState>());
    if crate::integration_control::notifications_and_hooks_enabled(app) {
        let configured = setup_all_hooks()?;
        return Ok(crate::i18n::translate(
            locale,
            "notifications.hook_enabled",
            &[("detail", &configured)],
        ));
    }

    let disabled = disable_all_hooks()?;
    Ok(crate::i18n::translate(
        locale,
        "notifications.hook_disabled",
        &[("detail", &disabled)],
    ))
}

#[tauri::command]
pub fn set_notifications_and_hooks_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<String, String> {
    let result = if enabled {
        setup_all_hooks()?
    } else {
        disable_all_hooks()?
    };

    crate::integration_control::save_preferences(&app, enabled)?;
    Ok(result)
}

#[tauri::command]
pub fn get_notifications_and_hooks_status(
    app: tauri::AppHandle,
) -> Result<NotificationHookStatus, String> {
    let locale = crate::i18n::current_locale(&app.state::<crate::i18n::LocaleState>());
    let enabled = crate::integration_control::notifications_and_hooks_enabled(&app);
    let claude_hooks_configured = claude_hooks_configured()?;
    let codex_hooks_configured = codex_hooks_configured()?;
    let codex_feature_enabled = codex_feature_enabled()?;
    let claude_listener_ready = hook_listener_ready(HookSource::ClaudeCode);
    let codex_listener_ready = hook_listener_ready(HookSource::Codex);

    let mut issues = Vec::new();
    if enabled && !claude_hooks_configured {
        issues.push(crate::i18n::translate(
            locale,
            "notifications.claude_hooks_not_configured",
            &[],
        ));
    }
    if enabled && !codex_hooks_configured {
        issues.push(crate::i18n::translate(
            locale,
            "notifications.codex_hooks_not_configured",
            &[],
        ));
    }
    if enabled && !codex_feature_enabled {
        issues.push(crate::i18n::translate(
            locale,
            "notifications.codex_feature_disabled",
            &[],
        ));
    }
    if enabled && !claude_listener_ready {
        issues.push(crate::i18n::translate(
            locale,
            "notifications.claude_listener_not_ready",
            &[],
        ));
    }
    if enabled && !codex_listener_ready {
        issues.push(crate::i18n::translate(
            locale,
            "notifications.codex_listener_not_ready",
            &[],
        ));
    }

    let healthy = if enabled { issues.is_empty() } else { true };

    Ok(NotificationHookStatus {
        enabled,
        claude_hooks_configured,
        codex_hooks_configured,
        codex_feature_enabled,
        claude_listener_ready,
        codex_listener_ready,
        healthy,
        issues,
    })
}

/// Add the directory to trustedDirectories in Claude settings.json.
#[tauri::command]
pub fn trust_workspace(path: String) -> Result<(), String> {
    let settings_path = resolve_provider_file_path("claude-code", "", "settings.json")
        .ok_or(crate::i18n::native_text("native.parse", "Claude Code"))?;

    let content = if settings_path.exists() {
        fs::read_to_string(&settings_path).map_err(|e| e.to_string())?
    } else {
        "{}".to_string()
    };

    let mut json: Value = serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}));

    let trusted = json
        .as_object_mut()
        .ok_or(crate::i18n::native_text(
            "native.invalidConfig",
            "settings.json",
        ))?
        .entry("trustedDirectories")
        .or_insert(serde_json::json!([]));

    if let Value::Array(arr) = trusted {
        if !arr.iter().any(|v| v.as_str() == Some(&path)) {
            arr.push(Value::String(path));
        }
    }

    let out = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?;
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&settings_path, out).map_err(|e| e.to_string())?;

    Ok(())
}

fn hook_prompt(json: &Value) -> Option<&str> {
    json["prompt"]
        .as_str()
        .or_else(|| json["input-messages"].as_array()?.last()?.as_str())
}

fn completed_hook_turn(json: &Value) -> Option<String> {
    let turn = json["turn-id"]
        .as_str()
        .or_else(|| json["turn_id"].as_str())?
        .trim();
    if turn.is_empty() || turn.len() > 256 {
        return None;
    }
    let thread = json["thread-id"]
        .as_str()
        .or_else(|| json["thread_id"].as_str())
        .unwrap_or("");
    if thread.len() > 256 {
        return None;
    }
    Some(format!("{thread}:{turn}"))
}

fn is_completion_hook(source: HookSource, event: &str, json: &Value) -> bool {
    if crate::notification::completion::is_child_event(json)
        || json["is_error"] == true
        || json["stop_hook_active"] == true
        || hook_prompt(json)
            .and_then(|prompt| prompt.split_whitespace().next())
            .is_some_and(|word| word.eq_ignore_ascii_case("/compact"))
        || ["status", "turn_status", "turn-status"].iter().any(|key| {
            json[*key].as_str().is_some_and(|status| {
                matches!(
                    status,
                    "error" | "failed" | "interrupted" | "cancelled" | "stopped"
                )
            })
        })
    {
        return false;
    }
    // Codex uses one bridge per platform. Ignore a leftover legacy bridge so a
    // Stop hook and notify callback cannot both announce the same completion.
    match source {
        HookSource::ClaudeCode => event == "Stop",
        HookSource::Codex if cfg!(unix) => event == "Stop",
        HookSource::Codex => {
            event.is_empty()
                && json
                    .get("type")
                    .or_else(|| json.get("event"))
                    .and_then(Value::as_str)
                    == Some("agent-turn-complete")
        }
    }
}

fn hook_session_id(json: &Value) -> Option<String> {
    json.get("agentdeck_session_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn dispatch_hook_event(app: &tauri::AppHandle, source: HookSource, json: &Value) {
    let locale = crate::i18n::current_locale(&app.state::<crate::i18n::LocaleState>());
    if !crate::integration_control::notifications_and_hooks_enabled(app) {
        eprintln!(
            "[hooks:{}] ignored because notifications and hooks are disabled",
            source.label()
        );
        return;
    }
    if crate::notification::completion::is_child_event(json) {
        return;
    }

    let event_name = json
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let routing = SessionRoutingHint {
        source,
        agentdeck_session_id: hook_session_id(json),
        cwd: json
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    };

    eprintln!(
        "[hooks:{}] received: {} agentdeck_session={:?} cwd={:?}",
        source.label(),
        event_name,
        routing.agentdeck_session_id,
        routing.cwd
    );

    match source {
        HookSource::ClaudeCode => match event_name {
            "UserPromptSubmit" => {
                emit_provider_session_bound(app, &routing, json);
                emit_session_lifecycle(
                    app,
                    routing,
                    SessionLifecycleSignal::Running {
                        prompt: hook_prompt(json).map(str::to_owned),
                    },
                );
            }
            "Stop" if is_completion_hook(source, event_name, json) => {
                emit_session_lifecycle(
                    app,
                    routing,
                    SessionLifecycleSignal::Completed {
                        turn_id: completed_hook_turn(json),
                        prompt: hook_prompt(json).map(str::to_owned),
                    },
                );
            }
            "StopFailure" => {
                let translated_unknown_error =
                    crate::i18n::translate(locale, "notifications.unknown_error", &[]);
                let error = json
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or(translated_unknown_error.as_str());
                emit_session_lifecycle(
                    app,
                    routing,
                    SessionLifecycleSignal::Error {
                        message: error.to_string(),
                    },
                );
            }
            _ => {}
        },
        HookSource::Codex => match event_name {
            "" | "Stop" if is_completion_hook(source, event_name, json) => {
                emit_session_lifecycle(
                    app,
                    routing,
                    SessionLifecycleSignal::Completed {
                        turn_id: completed_hook_turn(json),
                        prompt: hook_prompt(json).map(str::to_owned),
                    },
                );
            }
            "UserPromptSubmit" => {
                emit_provider_session_bound(app, &routing, json);
                emit_session_lifecycle(
                    app,
                    routing,
                    SessionLifecycleSignal::Running {
                        prompt: hook_prompt(json).map(str::to_owned),
                    },
                );
            }
            _ => {}
        },
    }
}

#[cfg(unix)]
fn start_hook_socket_server(app: tauri::AppHandle, source: HookSource) {
    use std::os::unix::net::UnixListener;

    let socket_path = source.socket_path();
    if let Some(parent) = std::path::Path::new(&socket_path).parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!(
                "[hooks:{}] Could not create socket directory {}: {e}",
                source.label(),
                parent.display()
            );
            return;
        }
    }

    let _ = fs::remove_file(&socket_path);

    let listener = match UnixListener::bind(&socket_path) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("[hooks:{}] bind failed: {e}", source.label());
            return;
        }
    };

    eprintln!("[hooks:{}] listening on {}", source.label(), socket_path);

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let stream = match stream {
                Ok(stream) => stream,
                Err(e) => {
                    eprintln!("[hooks:{}] accept error: {e}", source.label());
                    continue;
                }
            };

            let mut reader = std::io::BufReader::new(stream);
            let mut payload = String::new();
            if let Err(e) = reader.read_to_string(&mut payload) {
                eprintln!("[hooks:{}] read failed: {e}", source.label());
                continue;
            }

            let json: Value = match serde_json::from_str(&payload) {
                Ok(json) => json,
                Err(e) => {
                    eprintln!("[hooks:{}] JSON parse failed: {e}", source.label());
                    continue;
                }
            };

            dispatch_hook_event(&app, source, &json);
        }
    });
}

#[cfg(not(unix))]
fn start_hook_socket_server(app: tauri::AppHandle, source: HookSource) {
    use std::net::{Ipv4Addr, SocketAddr, TcpListener};

    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, source.tcp_port()));
    let listener = match TcpListener::bind(addr) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("[hooks:{}] bind {} failed: {e}", source.label(), addr);
            return;
        }
    };

    eprintln!("[hooks:{}] listening on {}", source.label(), addr);

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let stream = match stream {
                Ok(stream) => stream,
                Err(e) => {
                    eprintln!("[hooks:{}] accept error: {e}", source.label());
                    continue;
                }
            };

            let mut reader = std::io::BufReader::new(stream);
            let mut payload = String::new();
            if let Err(e) = reader.read_to_string(&mut payload) {
                eprintln!("[hooks:{}] read failed: {e}", source.label());
                continue;
            }

            let payload = payload.trim();
            if payload.is_empty() {
                continue;
            }

            let json: Value = match serde_json::from_str(payload) {
                Ok(json) => json,
                Err(e) => {
                    eprintln!("[hooks:{}] JSON parse failed: {e}", source.label());
                    continue;
                }
            };

            dispatch_hook_event(&app, source, &json);
        }
    });
}

pub fn start_hook_socket_servers(app: tauri::AppHandle) {
    start_hook_socket_server(app.clone(), HookSource::ClaudeCode);
    start_hook_socket_server(app, HookSource::Codex);
}

/// Send a system notification with click callbacks through the notification module.
///
/// On macOS, mac-notification-sys provides persistent notifications and click callbacks.
/// All notification clicks route through focus_popup(session_id).
#[tauri::command]
pub fn send_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
    session_id: Option<String>,
) -> Result<(), String> {
    crate::notification::send_notification_with_callback(
        app,
        title,
        body,
        None,
        Some(true),
        session_id,
    )
}

#[cfg(test)]
mod namespace_tests {
    use super::*;

    #[test]
    fn completion_hooks_exclude_intermediate_child_failed_and_compaction_events() {
        assert!(is_completion_hook(
            HookSource::ClaudeCode,
            "Stop",
            &serde_json::json!({})
        ));
        for event in [
            "Notification",
            "PreToolUse",
            "PostToolUse",
            "SubagentStop",
            "StopFailure",
            "PreCompact",
            "UserPromptSubmit",
        ] {
            assert!(!is_completion_hook(
                HookSource::ClaudeCode,
                event,
                &serde_json::json!({})
            ));
        }
        for payload in [
            serde_json::json!({"agent_id":"child"}),
            serde_json::json!({"parent_tool_use_id":"tool"}),
            serde_json::json!({"is_error":true}),
            serde_json::json!({"status":"interrupted"}),
            serde_json::json!({"stop_hook_active":true}),
            serde_json::json!({"prompt":"/compact keep decisions"}),
            serde_json::json!({"input-messages":["/compact"]}),
        ] {
            assert!(
                !is_completion_hook(HookSource::ClaudeCode, "Stop", &payload),
                "{payload}"
            );
        }
        for kind in [
            "item-complete",
            "tool-complete",
            "progress",
            "permission_prompt",
            "idle_prompt",
            "agent-turn-failed",
        ] {
            assert!(!is_completion_hook(
                HookSource::Codex,
                "",
                &serde_json::json!({"type":kind})
            ));
        }
        let completion =
            serde_json::json!({"type":"agent-turn-complete","thread-id":"thread","turn-id":"turn"});
        assert_eq!(
            is_completion_hook(HookSource::Codex, "", &completion),
            cfg!(not(unix))
        );
        assert_eq!(
            is_completion_hook(HookSource::Codex, "Stop", &completion),
            cfg!(unix)
        );
        assert_eq!(
            completed_hook_turn(&completion).as_deref(),
            Some("thread:turn")
        );
    }

    #[test]
    fn hook_session_id_rejects_empty_and_provider_ids() {
        assert_eq!(
            hook_session_id(&serde_json::json!({"agentdeck_session_id":" 16 "})).as_deref(),
            Some("16")
        );
        for payload in [
            serde_json::json!({"agentdeck_session_id":null}),
            serde_json::json!({"agentdeck_session_id":" "}),
            serde_json::json!({"session_id":"provider"}),
        ] {
            assert_eq!(hook_session_id(&payload), None);
        }
    }

    #[cfg(not(unix))]
    #[test]
    fn windows_reconciliation_preserves_unrelated_powershell_hooks() {
        use base64::Engine;
        let encode = |script: &str| {
            let bytes = script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>();
            format!(
                "{WINDOWS_POWERSHELL} -NoProfile -EncodedCommand {}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
        };
        assert!(!is_managed_command(
            &encode("Write-Output 'security audit'"),
            HookSource::ClaudeCode
        ));
        assert!(!is_managed_command(
            "powershell -File C:/custom/hook-bridge.ps1",
            HookSource::ClaudeCode
        ));
        assert!(!is_managed_command(
            "powershell -File C:/.agentdeck/user-hook.ps1",
            HookSource::ClaudeCode
        ));
        let managed = encode("$sid=$env:AGENTDECK_SESSION_ID; $c=[System.Net.Sockets.TcpClient]::new(); $c.Connect('localhost',46331)");
        assert!(is_managed_command(&managed, HookSource::ClaudeCode));
        assert!(!is_managed_command(&managed, HookSource::Codex));
        if let Some(home) = home_dir() {
            let managed_bridge = format!(
                "& '{}' -Source 'claude-code' -Port 46331",
                home.join(".agentdeck/hooks/hook-bridge.ps1").display()
            );
            assert!(is_managed_command(&managed_bridge, HookSource::ClaudeCode));
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_reconciliation_recognizes_only_managed_sockets() {
        for source in [HookSource::ClaudeCode, HookSource::Codex] {
            assert!(is_managed_command(&source.socket_path(), source));
        }
        assert!(!is_managed_command(
            "python3 /opt/security-hook.py",
            HookSource::ClaudeCode
        ));
    }
}
