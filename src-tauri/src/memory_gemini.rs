//! Per-process Gemini defaults. Higher-priority user, project and admin settings
//! retain their native precedence; no provider configuration is changed on disk.
use serde_json::{Map, Value};
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_DEFAULTS_BYTES: u64 = 1024 * 1024;
const SERVER_NAME: &str = "agentdeck_memory";

fn defaults_path(defaults: Option<OsString>, system: Option<OsString>) -> PathBuf {
    if let Some(path) = defaults.filter(|value| !value.is_empty()) {
        return PathBuf::from(path);
    }
    let system = system
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            #[cfg(target_os = "windows")]
            let path = "C:\\ProgramData\\gemini-cli\\settings.json";
            #[cfg(target_os = "macos")]
            let path = "/Library/Application Support/GeminiCli/settings.json";
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            let path = "/etc/gemini-cli/settings.json";
            PathBuf::from(path)
        });
    system
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("system-defaults.json")
}

fn merge_server(mut defaults: Value, server: Value) -> Result<Value, String> {
    let valid_server = server.is_object()
        && server["command"]
            .as_str()
            .is_some_and(|command| !command.trim().is_empty())
        && server["args"]
            .as_array()
            .is_some_and(|args| args.iter().all(Value::is_string));
    if !valid_server {
        return Err("Gemini memory server must provide a command and string arguments.".into());
    }
    let object = defaults
        .as_object_mut()
        .ok_or("Gemini system defaults must be a JSON object; existing settings were preserved.")?;
    let servers = object
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or("Gemini mcpServers must be an object; existing settings were preserved.")?;
    if servers.get(SERVER_NAME).is_some_and(|old| old != &server) {
        return Err(
            "Gemini defaults already define agentdeck_memory; existing server was preserved."
                .into(),
        );
    }
    servers.insert(SERVER_NAME.into(), server);
    Ok(defaults)
}

fn session_filename(session: &str) -> String {
    let safe: String = session
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .take(64)
        .collect();
    // A fresh suffix also prevents concurrent launches from sharing a writable
    // overlay, including session ids whose sanitized forms happen to collide.
    format!("gemini-{}-{}.json", safe, uuid::Uuid::new_v4())
}

/// Returns the environment override to set on this child process only.
/// Invalid/unreadable settings fail closed so callers can use bounded prompt
/// context without silently dropping the user's defaults or policy.
pub fn defaults_overlay(
    data_dir: &Path,
    session: &str,
    mcp_server: Value,
    capture_hook: Option<Value>,
) -> Result<Option<(String, String)>, String> {
    let source = defaults_path(
        std::env::var_os("GEMINI_CLI_SYSTEM_DEFAULTS_PATH"),
        std::env::var_os("GEMINI_CLI_SYSTEM_SETTINGS_PATH"),
    );
    let defaults = match fs::File::open(&source) {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(MAX_DEFAULTS_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| {
                    "Cannot read Gemini system defaults; existing settings were preserved."
                })?;
            if bytes.len() as u64 > MAX_DEFAULTS_BYTES {
                return Err("Gemini defaults exceed the safe overlay size; existing settings were preserved.".into());
            }
            let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
            serde_json::from_slice(bytes).map_err(|_| {
                "Gemini defaults are not plain JSON; existing settings were preserved.".to_string()
            })?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Object(Map::new()),
        Err(_) => {
            return Err(
                "Cannot open Gemini system defaults; existing settings were preserved.".into(),
            );
        }
    };
    let mut overlay = merge_server(defaults, mcp_server)?;
    if let Some(hook) = capture_hook {
        crate::memory_capture::merge_hooks(&mut overlay, "gemini", hook)?;
    }
    let directory = data_dir.join("memory").join("mcp-config");
    fs::create_dir_all(&directory)
        .map_err(|_| "Cannot create Gemini memory configuration directory.")?;
    let path = directory.join(session_filename(session));
    let bytes = serde_json::to_vec(&overlay)
        .map_err(|_| "Cannot serialize Gemini memory configuration.")?;
    fs::write(&path, bytes).map_err(|_| "Cannot write Gemini memory configuration.")?;
    Ok(Some((
        "GEMINI_CLI_SYSTEM_DEFAULTS_PATH".into(),
        path.to_string_lossy().into_owned(),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn merge_preserves_policies_permissions_and_existing_servers() {
        let original = json!({
            "mcpServers": {"existing": {"command": "other.exe", "args": ["--safe"]}},
            "mcp": {"allowed": ["existing"], "excluded": ["agentdeck_memory"]},
            "admin": {"mcp": {"enabled": false}},
            "security": {"folderTrust": {"enabled": true}},
            "general": {"defaultApprovalMode": "plan"},
            "policyPaths": ["policy.toml"]
        });
        let server = json!({"command": "C:\\App Dir\\agentdeck.exe", "args": ["--memory-mcp"]});
        let mut merged = merge_server(original.clone(), server.clone()).unwrap();
        assert_eq!(merged["mcpServers"][SERVER_NAME], server);
        assert_eq!(merge_server(merged.clone(), server).unwrap(), merged);
        merged["mcpServers"]
            .as_object_mut()
            .unwrap()
            .remove(SERVER_NAME);
        assert_eq!(merged, original);
    }

    #[test]
    fn invalid_or_colliding_defaults_are_not_overwritten() {
        let server = json!({"command": "app.exe", "args": ["--memory-mcp"]});
        for defaults in [
            Value::Null,
            json!([]),
            json!({"mcpServers": null}),
            json!({"mcpServers": {"agentdeck_memory": {"command": "custom"}}}),
        ] {
            assert!(merge_server(defaults, server.clone()).is_err());
        }
        assert!(merge_server(json!({}), json!({"command": "app.exe", "args": [3]})).is_err());
    }

    #[test]
    fn provider_path_precedence_and_safe_filenames() {
        let system = PathBuf::from("custom").join("settings.json");
        assert_eq!(
            defaults_path(None, Some(system.into_os_string())),
            PathBuf::from("custom").join("system-defaults.json")
        );
        assert_eq!(
            defaults_path(Some(OsString::from("explicit.json")), None),
            PathBuf::from("explicit.json")
        );
        let filename = session_filename("../../session\\outside:*?\0");
        assert_eq!(Path::new(&filename).components().count(), 1);
        assert!(!filename.contains(".."));
        assert!(filename.starts_with("gemini-sessionoutside-"));
    }
}
