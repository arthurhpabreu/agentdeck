use serde::Serialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModel {
    id: String,
    label: String,
    reasoning_efforts: Vec<String>,
    fast_mode: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolved_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cli_version: Option<String>,
}

fn valid_model_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && !value.starts_with('-')
        && !value.chars().any(char::is_control)
}

fn parse_claude_models(value: &serde_json::Value, version: Option<&str>) -> Vec<AgentModel> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .take(100)
        .filter_map(|model| {
            let id = model.get("value")?.as_str()?;
            if !valid_model_id(id) {
                return None;
            }
            let resolved_model = model
                .get("resolvedModel")
                .and_then(|value| value.as_str())
                .filter(|value| valid_model_id(value))
                .map(str::to_owned);
            let mut label = model
                .get("displayName")
                .and_then(|value| value.as_str())
                .filter(|value| value.len() <= 180 && !value.chars().any(char::is_control))
                .unwrap_or(id)
                .to_owned();
            // Some CLI builds return a generic displayName even when resolvedModel
            // identifies the exact release. Derive its version, never pin an alias.
            if let Some(resolved) = &resolved_model {
                let pattern = regex::Regex::new(
                    r"^claude-(?:opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$",
                )
                .unwrap();
                if let Some(parts) = pattern.captures(resolved) {
                    let version = match parts.get(2) {
                        Some(minor) => format!("{}.{}", &parts[1], minor.as_str()),
                        None => parts[1].to_string(),
                    };
                    if !label.contains(&version) {
                        label = format!("{label} {version}");
                    }
                }
            }
            let reasoning_efforts = model
                .get("supportedEffortLevels")
                .and_then(|value| value.as_array())
                .into_iter()
                .flatten()
                .filter_map(|level| level.as_str())
                .filter(|level| matches!(*level, "low" | "medium" | "high" | "xhigh" | "max"))
                .map(str::to_owned)
                .collect();
            Some(AgentModel {
                id: id.to_owned(),
                label,
                reasoning_efforts,
                fast_mode: model
                    .get("supportsFastMode")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false),
                resolved_model,
                cli_version: version.map(str::to_owned),
            })
        })
        .collect()
}

/// Only an SDK initialize control request is sent. No user prompt, model turn,
/// project hooks, plugins or MCP servers are executed by this metadata probe.
fn claude_catalogue(cli_path: &str) -> Result<Vec<AgentModel>, String> {
    if !cli_path.is_empty() && !std::path::Path::new(cli_path).is_file() {
        return Err("The configured Claude CLI path is not an executable file.".into());
    }
    let executable = crate::util::find_cli_path("claude-code", cli_path);
    let arguments = [
        "--safe-mode",
        "--print",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--no-session-persistence",
    ]
    .map(str::to_owned)
    .to_vec();
    let (executable, arguments) = crate::util::resolve_windows_pty_command(&executable, &arguments);
    #[cfg(windows)]
    if std::path::Path::new(&executable)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "cmd" | "bat" | "ps1"))
    {
        return Err("Configure a native Claude executable to read its model catalogue.".into());
    }
    let mut child = crate::util::background_command(&executable)
        .args(arguments)
        .env("DISABLE_AUTOUPDATER", "1")
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Could not start Claude to read its model catalogue.")?;
    let request = serde_json::json!({"type":"control_request","request_id":"agentdeck-catalogue","request":{"subtype":"initialize","hooks":{},"sdkMcpServers":[]}});
    let input = child
        .stdin
        .as_mut()
        .ok_or("Claude metadata input unavailable.")
        .and_then(|stdin| {
            writeln!(stdin, "{request}")
                .map_err(|_| "Could not initialize the Claude model catalogue.")
        });
    if let Err(error) = input {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error.into());
    }
    let stdout = child
        .stdout
        .take()
        .ok_or("Claude metadata output unavailable.")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout.take(2 * 1024 * 1024))
            .lines()
            .map_while(Result::ok)
        {
            if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
                if event["type"] == "control_response"
                    && event["response"]["request_id"] == "agentdeck-catalogue"
                {
                    let _ = sender.send(event["response"]["response"]["models"].clone());
                    break;
                }
            }
        }
    });
    let result = receiver.recv_timeout(Duration::from_secs(10));
    crate::cli_updates::terminate_probe(&mut child);
    let _ = reader.join();
    let models = result.map_err(|_| {
        "Claude model catalogue unavailable. Check the CLI installation and sign-in, then refresh."
    })?;

    // This command is local metadata too; bound its output and runtime independently.
    let version = (|| -> Option<String> {
        let mut child = crate::util::background_command(&executable)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let output = child.stdout.take()?;
        let (sender, receiver) = mpsc::sync_channel(1);
        let reader = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = output.take(256).read_to_string(&mut text);
            let _ = sender.send(text);
        });
        let result = receiver.recv_timeout(Duration::from_secs(3)).ok();
        let _ = child.kill();
        let _ = child.wait();
        let _ = reader.join();
        result.and_then(|text| {
            text.split_whitespace()
                .next()
                .filter(|version| {
                    version.len() <= 40
                        && version
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
                })
                .map(str::to_owned)
        })
    })();
    let models = parse_claude_models(&models, version.as_deref());
    if models.is_empty() {
        return Err("Claude did not report a model catalogue. Update the CLI and refresh.".into());
    }
    Ok(models)
}

fn codex_catalogue(cli_path: &str, workdir: &str) -> Result<Vec<AgentModel>, String> {
    let executable = crate::util::find_cli_path("codex", cli_path);
    let version = crate::cli_updates::installed_version(&executable);
    let (program, args) = crate::util::resolve_windows_pty_command(
        &executable,
        &["app-server".into(), "--listen".into(), "stdio://".into()],
    );
    let mut child = crate::util::background_command(&program)
        .args(args)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Codex catalogue unavailable.")?;
    let output = child
        .stdout
        .take()
        .ok_or("Codex metadata output unavailable.")?;
    let (sender, receiver) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output.take(4 * 1024 * 1024))
            .lines()
            .map_while(Result::ok)
        {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                if value.get("id").is_some() && sender.send(value).is_err() {
                    break;
                }
            }
        }
    });
    let result = (|| -> Result<(serde_json::Value, Option<serde_json::Value>), String> {
        let input = child
            .stdin
            .as_mut()
            .ok_or("Codex metadata input unavailable.")?;
        writeln!(input, "{}", serde_json::json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"agentdeck","version":env!("CARGO_PKG_VERSION")}}})).map_err(|_| "Codex initialize failed.")?;
        let initialized = receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "Codex initialize timed out.")?;
        if initialized.get("error").is_some() {
            return Err("Codex initialize rejected.".into());
        }
        writeln!(input, "{}", serde_json::json!({"method":"initialized"}))
            .map_err(|_| "Codex initialize failed.")?;
        writeln!(input, "{}", serde_json::json!({"id":2,"method":"model/list","params":{"limit":100,"includeHidden":false}})).map_err(|_| "Codex model list failed.")?;
        let response = receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "Codex models timed out.")?;
        if response["id"] != 2 || !response["result"]["data"].is_array() {
            return Err("Codex did not report models.".into());
        }
        let models = response["result"]["data"].clone();
        let cwd = if workdir.is_empty() {
            None
        } else {
            Some(crate::util::expand_path(workdir))
        };
        writeln!(input, "{}", serde_json::json!({"id":3,"method":"config/read","params":{"includeLayers":false,"cwd":cwd}})).map_err(|_| "Codex configuration unavailable.")?;
        let config = receiver
            .recv_timeout(Duration::from_secs(10))
            .ok()
            .filter(|response| response["id"] == 3 && response["result"]["config"].is_object())
            .map(|response| response["result"]["config"].clone());
        Ok((models, config))
    })();
    drop(child.stdin.take());
    crate::cli_updates::terminate_probe(&mut child);
    let _ = reader.join();
    let (values, config) = result?;
    let models = parse_codex_models(&values, version.as_deref(), config.as_ref());
    if models.is_empty() {
        return Err("Codex reported no models.".into());
    }
    Ok(models)
}

fn codex_effort(value: &str) -> bool {
    matches!(
        value,
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
    )
}
fn codex_fast_mode(value: &serde_json::Value) -> bool {
    value["supportsFastMode"] == true
        || value
            .get("additionalSpeedTiers")
            .or_else(|| value.get("additional_speed_tiers"))
            .and_then(|value| value.as_array())
            .is_some_and(|tiers| {
                tiers
                    .iter()
                    .any(|tier| matches!(tier.as_str(), Some("fast" | "priority")))
            })
        || value
            .get("serviceTiers")
            .or_else(|| value.get("service_tiers"))
            .and_then(|value| value.as_array())
            .is_some_and(|tiers| {
                tiers
                    .iter()
                    .any(|tier| matches!(tier["id"].as_str(), Some("fast" | "priority")))
            })
}

fn parse_codex_models(
    values: &serde_json::Value,
    version: Option<&str>,
    config: Option<&serde_json::Value>,
) -> Vec<AgentModel> {
    let mut models: Vec<AgentModel> = values
        .as_array()
        .into_iter()
        .flatten()
        .take(100)
        .filter(|value| value["hidden"] != true)
        .filter_map(|value| {
            let id = value["model"]
                .as_str()
                .or_else(|| value["id"].as_str())
                .filter(|id| valid_model_id(id))?
                .to_string();
            let label = value["displayName"]
                .as_str()
                .filter(|value| value.len() < 180 && !value.chars().any(char::is_control))
                .unwrap_or(&id)
                .to_string();
            let reasoning_efforts = value["supportedReasoningEfforts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|value| value["reasoningEffort"].as_str())
                .filter(|value| codex_effort(value))
                .map(str::to_owned)
                .collect();
            Some(AgentModel {
                resolved_model: Some(id.clone()),
                id,
                label,
                reasoning_efforts,
                fast_mode: codex_fast_mode(value),
                cli_version: version.map(str::to_owned),
            })
        })
        .collect();
    // isDefault is the provider recommendation, not necessarily the user's
    // actual CLI default. Resolve layered config first, including profiles.
    if let Some(config) = config {
        let profile_model = config["profile"]
            .as_str()
            .and_then(|profile| config["profiles"][profile]["model"].as_str());
        let configured = profile_model
            .or_else(|| config["model"].as_str())
            .filter(|model| !model.is_empty());
        let recommended = values
            .as_array()
            .into_iter()
            .flatten()
            .find(|value| value["isDefault"] == true)
            .and_then(|value| value["model"].as_str());
        if let Some(model) = configured
            .or(recommended)
            .and_then(|id| models.iter().find(|model| model.id == id))
            .cloned()
        {
            models.insert(
                0,
                AgentModel {
                    id: "default".into(),
                    ..model
                },
            );
        }
    }
    models
}

/// Read only CLI model metadata. Never serialize account/authentication fields.
#[tauri::command]
pub async fn list_agent_models(
    runner_type: String,
    cli_path: Option<String>,
    workdir: Option<String>,
) -> Result<Vec<AgentModel>, String> {
    if runner_type == "claude-code" {
        return tauri::async_runtime::spawn_blocking(move || {
            let _guard = crate::cli_updates::launch_guard()?;
            claude_catalogue(cli_path.as_deref().unwrap_or_default())
        })
        .await
        .map_err(|error| error.to_string())?;
    }
    if runner_type != "codex" {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::cli_updates::launch_guard()?;
        let live = codex_catalogue(
            cli_path.as_deref().unwrap_or_default(),
            workdir.as_deref().unwrap_or_default(),
        );
        // A stale or malformed disk cache must never discard a successful live
        // catalogue (which already contains speed tiers and all effort levels).
        if live.is_ok() {
            return live;
        }
        let root = std::env::var_os("CODEX_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| crate::util::home_dir().map(|p| p.join(".codex")));
        let Some(root) = root else {
            return live;
        };
        let path = root.join("models_cache.json");
        if !path.exists() {
            return live;
        }
        let mut data = String::new();
        std::fs::File::open(path)
            .map_err(|e| e.to_string())?
            .take(4 * 1024 * 1024)
            .read_to_string(&mut data)
            .map_err(|e| e.to_string())?;
        let json: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
        let cached: Vec<AgentModel> = json
            .get("models")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .filter(|v| v.get("visibility").and_then(|v| v.as_str()) != Some("hide"))
            .filter_map(|v| {
                let id = v.get("slug").or_else(|| v.get("id"))?.as_str()?.to_string();
                let label = v
                    .get("display_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&id)
                    .to_string();
                let reasoning_efforts = v
                    .get("supported_reasoning_levels")
                    .and_then(|value| value.as_array())
                    .into_iter()
                    .flatten()
                    .filter_map(|value| value.get("effort").and_then(|value| value.as_str()))
                    .filter(|value| codex_effort(value))
                    .map(str::to_owned)
                    .collect();
                let fast_mode = codex_fast_mode(v);
                Some(AgentModel {
                    resolved_model: Some(id.clone()),
                    id,
                    label,
                    reasoning_efforts,
                    fast_mode,
                    cli_version: None,
                })
            })
            .collect();
        match live {
            Ok(models) => Ok(models),
            Err(_) if !cached.is_empty() => Ok(cached),
            Err(error) => Err(error),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Opt-in native metadata probe; no user prompt or inference"]
    fn installed_native_catalogues_smoke() {
        for (name, models) in [
            ("Claude", claude_catalogue("").unwrap()),
            ("Codex", codex_catalogue("", "").unwrap()),
        ] {
            assert!(!models.is_empty());
            let default = models
                .iter()
                .find(|model| model.id == "default")
                .expect("installed CLI default must resolve");
            assert!(default.resolved_model.is_some());
            assert!(default.cli_version.is_some());
            if name == "Codex" {
                assert!(default.reasoning_efforts.contains(&"ultra".into()));
                assert!(default.fast_mode);
            }
            for model in models {
                println!("{name}: {}", serde_json::to_string(&model).unwrap());
            }
        }
    }
    #[test]
    fn codex_default_uses_effective_config_and_preserves_native_capabilities() {
        let values = serde_json::json!([
            {"model":"recommended","isDefault":true,"supportedReasoningEfforts":[{"reasoningEffort":"medium"}]},
            {"model":"configured","displayName":"Configured model","supportedReasoningEfforts":[{"reasoningEffort":"none"},{"reasoningEffort":"minimal"},{"reasoningEffort":"low"},{"reasoningEffort":"medium"},{"reasoningEffort":"high"},{"reasoningEffort":"xhigh"},{"reasoningEffort":"max"},{"reasoningEffort":"ultra"},{"reasoningEffort":"invented"}],"additionalSpeedTiers":["fast"],"account":{"email":"private@example.invalid"}},
            {"model":"hidden","hidden":true}, {"model":"--invalid"}
        ]);
        let config = serde_json::json!({"model":"configured","api_key":"private-secret"});
        let models = parse_codex_models(&values, Some("0.160.1"), Some(&config));
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].id, "default");
        assert_eq!(models[0].resolved_model.as_deref(), Some("configured"));
        assert_eq!(
            models[0].reasoning_efforts,
            ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
        );
        assert!(models[0].fast_mode);
        assert!(!models[1].fast_mode);
        assert_eq!(models[0].cli_version.as_deref(), Some("0.160.1"));
        let serialized = serde_json::to_string(&models).unwrap();
        assert!(!serialized.contains("private"));
        assert!(!serialized.contains("api_key"));
        let profile = serde_json::json!({"model":"recommended","profile":"work","profiles":{"work":{"model":"configured"}}});
        assert_eq!(
            parse_codex_models(&values, None, Some(&profile))[0]
                .resolved_model
                .as_deref(),
            Some("configured")
        );
        assert_eq!(
            parse_codex_models(&values, None, Some(&serde_json::json!({})))[0]
                .resolved_model
                .as_deref(),
            Some("recommended")
        );
        for config in [
            None,
            Some(serde_json::json!({"model":"not-in-catalogue"})),
            Some(serde_json::json!({"model":"hidden"})),
        ] {
            assert!(parse_codex_models(&values, None, config.as_ref())
                .iter()
                .all(|model| model.id != "default"));
        }
    }
    #[test]
    fn codex_fast_uses_reported_speed_tiers_without_assuming_support() {
        for value in [
            serde_json::json!({"serviceTiers":[{"id":"priority"}]}),
            serde_json::json!({"additional_speed_tiers":["fast"]}),
            serde_json::json!({"supportsFastMode":true}),
        ] {
            assert!(codex_fast_mode(&value));
        }
        for value in [
            serde_json::json!({}),
            serde_json::json!({"serviceTiers":[{"id":"default"}]}),
            serde_json::json!({"additionalSpeedTiers":["unknown"]}),
        ] {
            assert!(!codex_fast_mode(&value));
        }
    }
    #[test]
    fn claude_catalogue_keeps_versions_capabilities_and_no_account_fields() {
        let value = serde_json::json!([
            {"value":"opus","displayName":"Opus 5.5","resolvedModel":"claude-opus-5-5","supportedEffortLevels":["low","medium","xhigh","max","invalid"],"supportsFastMode":true,"account":{"email":"private@example.invalid"}},
            {"value":"haiku","displayName":"Haiku","resolvedModel":"claude-haiku-4-5-20251001"},
            {"value":"--injected","displayName":"Invalid"}
        ]);
        let models = parse_claude_models(&value, Some("2.1.287"));
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].resolved_model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(models[0].label, "Opus 5.5");
        assert_eq!(
            models[0].reasoning_efforts,
            ["low", "medium", "xhigh", "max"]
        );
        assert!(models[0].fast_mode);
        assert!(!models[1].fast_mode);
        assert!(models[1].reasoning_efforts.is_empty());
        assert_eq!(models[1].label, "Haiku 4.5");
        let serialized = serde_json::to_string(&models).unwrap();
        assert!(!serialized.contains("private@example"));
        assert!(!serialized.contains("account"));
        assert!(serialized.contains("cliVersion"));
    }
}
