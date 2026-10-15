//! Optional, per-process model routing. Never rewrites CLI/project configuration,
//! permissions or account settings. Metadata discovery never starts inference.
use crate::agent_models::AgentModel;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

#[derive(Default, Deserialize, Serialize)]
struct Config {
    enabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub model: String,
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub coordinator: Role,
    pub explorer: Role,
    pub advisor: Role,
    advisor_mode: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    enabled: bool,
    available: bool,
    profile: Option<Profile>,
    reason: Option<&'static str>,
}

type Cache = HashMap<(String, String, String), (Instant, Result<Vec<AgentModel>, &'static str>)>;
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("multi-agent-economy");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root.join("settings.json"))
}

pub fn enabled(app: &tauri::AppHandle) -> bool {
    let Ok(_guard) = SETTINGS_LOCK.lock() else {
        return false;
    };
    config_path(app)
        .ok()
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<Config>(&bytes).ok())
        .unwrap_or_default()
        .enabled
}

fn recent_enough(version: Option<&str>, minimum: [u32; 3]) -> bool {
    let Some(numbers) = version
        .and_then(|value| {
            value
                .split_whitespace()
                .find(|part| part.as_bytes().first().is_some_and(u8::is_ascii_digit))
        })
        .and_then(|value| {
            value
                .split('.')
                .map(str::parse::<u32>)
                .collect::<Result<Vec<_>, _>>()
                .ok()
        })
    else {
        return false;
    };
    numbers.len() == 3 && numbers.as_slice() >= minimum.as_slice()
}

fn role(model: &AgentModel, effort: Option<&str>) -> Role {
    Role {
        model: model
            .resolved_model
            .clone()
            .unwrap_or_else(|| model.id.clone()),
        label: model.label.clone(),
        effort: effort
            .filter(|effort| model.reasoning_efforts.iter().any(|value| value == effort))
            .map(str::to_owned),
    }
}

fn profile(
    provider: &str,
    models: &[AgentModel],
    selected_model: Option<&str>,
    selected_effort: Option<&str>,
) -> Result<Profile, &'static str> {
    let minimum = if provider == "codex" {
        [0, 162, 1]
    } else {
        [2, 1, 300]
    };
    if !models
        .iter()
        .any(|model| recent_enough(model.cli_version.as_deref(), minimum))
    {
        return Err("cli_update_required");
    }
    let by_id = |id: &str| models.iter().find(|model| model.id == id);
    // Describe the user's selection; never use this role to configure the main model.
    let selected_id = selected_model
        .filter(|id| !id.trim().is_empty())
        .unwrap_or("default");
    let mut coordinator = models
        .iter()
        .find(|model| model.id == selected_id)
        .or_else(|| {
            models.iter().find(|model| {
                model.id != "default" && model.resolved_model.as_deref() == Some(selected_id)
            })
        })
        .map(|model| role(model, None))
        .unwrap_or_else(|| Role {
            model: selected_id.into(),
            label: selected_id.into(),
            effort: None,
        });
    coordinator.effort = selected_effort
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if provider == "claude-code" {
        let explorer = by_id("haiku").ok_or("models_unavailable")?;
        let advisor = by_id("opus").ok_or("models_unavailable")?;
        // Native advisor pairings are capability-ranked. Unknown/default/Fable
        // main models get an independent review subagent, never a forced Sonnet.
        // A native default may also come from project settings or resumed state,
        // which an isolated metadata catalogue cannot prove.
        let native = selected_id != "default"
            && native_claude_pair(
                &coordinator.model,
                advisor.resolved_model.as_deref().unwrap_or(&advisor.id),
            );
        return Ok(Profile {
            coordinator,
            explorer: role(explorer, Some("low")),
            advisor: role(advisor, if native { None } else { Some("high") }),
            advisor_mode: if native { "native" } else { "subagent" },
        });
    }
    // Only documented model families found in the actual catalogue are used.
    // No silent fallback to an arbitrary (possibly more expensive) model.
    let advisor = by_id("gpt-6-astra")
        .or_else(|| by_id("gpt-6.1-sol"))
        .or_else(|| by_id("gpt-6-sol"))
        .or_else(|| by_id("gpt-5.6-sol"))
        .ok_or("models_unavailable")?;
    let explorer = by_id("gpt-6-luna")
        .or_else(|| by_id("gpt-5.6-luna"))
        .ok_or("models_unavailable")?;
    let result = Profile {
        coordinator,
        explorer: role(explorer, Some("low")),
        advisor: role(advisor, Some("high")),
        advisor_mode: "subagent",
    };
    if result.explorer.effort.is_none() || result.advisor.effort.is_none() {
        return Err("models_unavailable");
    }
    Ok(result)
}

fn native_claude_pair(main: &str, advisor: &str) -> bool {
    let main_pattern = regex::Regex::new(
        r"^claude-(?:sonnet-(?:4-6|5|5-5)|haiku-(?:4-5|5-5)|opus-(?:4-6|4-7|4-8|5|5-5))(?:-\d{8})?$",
    ).unwrap();
    let advisor_pattern = regex::Regex::new(r"^claude-opus-(?:5|5-5)(?:-\d{8})?$").unwrap();
    main_pattern.is_match(main) && advisor_pattern.is_match(advisor)
}

async fn catalogue(
    provider: &str,
    cli_path: &str,
    workdir: &str,
    force: bool,
) -> Result<Vec<AgentModel>, &'static str> {
    let key = (provider.to_owned(), cli_path.to_owned(), workdir.to_owned());
    let cache = CACHE.get_or_init(Default::default);
    if !force {
        if let Some((time, models)) = cache
            .lock()
            .ok()
            .and_then(|entries| entries.get(&key).cloned())
        {
            if time.elapsed() < Duration::from_secs(300) {
                return models;
            }
        }
    }
    let result = crate::agent_models::list_agent_models(
        provider.to_owned(),
        Some(cli_path.to_owned()),
        Some(workdir.to_owned()),
    )
    .await
    .map_err(|_| "models_unavailable");
    if let Ok(mut entries) = cache.lock() {
        if entries.len() >= 32 {
            entries.retain(|_, (time, _)| time.elapsed() < Duration::from_secs(300));
        }
        if entries.len() >= 32 {
            entries.clear();
        }
        entries.insert(key, (Instant::now(), result.clone()));
    }
    result
}

#[tauri::command]
pub async fn get_multi_agent_status(
    app: tauri::AppHandle,
    runner_type: String,
    cli_path: Option<String>,
    workdir: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    force: Option<bool>,
) -> Status {
    let enabled = enabled(&app);
    if !matches!(runner_type.as_str(), "codex" | "claude-code") {
        return Status {
            enabled,
            available: false,
            profile: None,
            reason: Some("unsupported_provider"),
        };
    }
    match catalogue(
        &runner_type,
        cli_path.as_deref().unwrap_or_default(),
        workdir.as_deref().unwrap_or_default(),
        force.unwrap_or(false),
    )
    .await
    .and_then(|models| profile(&runner_type, &models, model.as_deref(), effort.as_deref()))
    {
        Ok(profile) => Status {
            enabled,
            available: true,
            profile: Some(profile),
            reason: None,
        },
        Err(reason) => Status {
            enabled,
            available: false,
            profile: None,
            reason: Some(reason),
        },
    }
}

#[tauri::command]
pub fn get_multi_agent_enabled(app: tauri::AppHandle) -> bool {
    enabled(&app)
}

#[tauri::command]
pub fn set_multi_agent_enabled(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    let _guard = SETTINGS_LOCK
        .lock()
        .map_err(|_| "Multi-agent settings are unavailable")?;
    fs::write(
        config_path(&app)?,
        serde_json::to_vec(&Config { enabled }).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let _ = app.emit("multi-agent-economy-changed", json!({"enabled":enabled}));
    Ok(enabled)
}

pub async fn prepare(
    app: &tauri::AppHandle,
    provider: &str,
    cli_path: &str,
    workdir: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<Option<Profile>, String> {
    if !enabled(app) || !matches!(provider, "codex" | "claude-code") {
        return Ok(None);
    }
    catalogue(provider, cli_path, workdir, false).await
        .and_then(|models| profile(provider, &models, model, effort))
        .map(Some).map_err(|_| "Multi-agent economy is enabled but this CLI/model catalogue is not supported. Refresh Economy, update the CLI or turn off multi-agent economy before retrying.".into())
}

fn replace_pair(args: &mut Vec<String>, flags: &[&str], flag: &str, value: String) {
    let mut position = 0;
    while position < args.len() {
        if flags.iter().any(|flag| args[position] == *flag) {
            args.remove(position);
            if position < args.len() {
                args.remove(position);
            }
        } else if flags.iter().any(|flag| {
            args[position].starts_with(&format!("{flag}="))
                || flag.len() == 2 && args[position].starts_with(flag) && args[position].len() > 2
        }) {
            args.remove(position);
        } else {
            position += 1;
        }
    }
    args.extend([flag.into(), value]);
}

/// Read launch metadata without changing the native arguments or resolving a
/// missing model into an explicit override (especially for resumed sessions).
pub fn selection(provider: &str, args: &[String]) -> (Option<String>, Option<String>) {
    let mut model = None;
    let mut config_model = None;
    let mut effort = None;
    let mut index = 0;
    while index < args.len() && args[index] != "--" {
        let arg = &args[index];
        let mut value_for = |long: &str, short: Option<&str>| -> Option<String> {
            if arg == long || short.is_some_and(|short| arg == short) {
                index += 1;
                return args
                    .get(index)
                    .filter(|value| value.as_str() != "--")
                    .cloned();
            }
            arg.strip_prefix(&format!("{long}="))
                .or_else(|| {
                    short.and_then(|short| {
                        arg.strip_prefix(short)
                            .filter(|value| !value.is_empty())
                            .map(|value| value.strip_prefix('=').unwrap_or(value))
                    })
                })
                .map(str::to_owned)
        };
        if let Some(value) = value_for("--model", Some("-m")) {
            model = Some(value);
        } else if provider == "codex" {
            if let Some(value) = value_for("--config", Some("-c")) {
                if let Some((key, value)) = value.split_once('=') {
                    let key = key.trim();
                    if matches!(key, "model" | "model_reasoning_effort") {
                        let parsed = format!("value={value}")
                            .parse::<toml::Table>()
                            .ok()
                            .and_then(|table| {
                                table
                                    .get("value")
                                    .and_then(toml::Value::as_str)
                                    .map(str::to_owned)
                            })
                            .unwrap_or_else(|| value.trim().to_owned());
                        if key == "model" {
                            config_model = Some(parsed);
                        } else {
                            effort = Some(parsed);
                        }
                    }
                }
            }
        } else if let Some(value) = value_for("--effort", None) {
            effort = Some(value);
        }
        if args.get(index).is_some_and(|arg| arg == "--") {
            break;
        }
        index += 1;
    }
    (model.or(config_model), effort)
}

/// Apply before RTK and memory overlays so their hooks/settings remain intact.
/// Permissions, sandbox, MCP and skills are deliberately not modified here.
pub fn configure(
    profile: &Profile,
    provider: &str,
    workdir: &str,
    args: &mut Vec<String>,
) -> Result<Vec<(String, String)>, String> {
    let boundary = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    let mut options = args[..boundary].to_vec();
    let env = configure_agents(profile, provider, workdir, &mut options)?;
    options.extend_from_slice(&args[boundary..]);
    *args = options;
    Ok(env)
}

fn configure_agents(
    profile: &Profile,
    provider: &str,
    workdir: &str,
    args: &mut Vec<String>,
) -> Result<Vec<(String, String)>, String> {
    if provider == "codex" {
        for (key, value) in [
            ("agents.enabled", "true".into()),
            ("agents.max_concurrent_threads_per_session", "3".into()),
            (
                "agents.default_subagent_model",
                json!(profile.explorer.model).to_string(),
            ),
            (
                "agents.default_subagent_reasoning_effort",
                json!(profile.explorer.effort).to_string(),
            ),
        ] {
            args.extend(["-c".into(), format!("{key}={value}")]);
        }
        return Ok(Vec::new());
    }
    if profile.advisor_mode == "native" {
        replace_pair(
            args,
            &["--advisor"],
            "--advisor",
            profile.advisor.model.clone(),
        );
    }
    // Main model, effort, settings, Fast/Ultra and their environment overrides
    // remain exactly as selected. Only auxiliary agent configuration is added.
    let mut agents = read_overlay(args, "--agents", workdir)?;
    agents["agentdeck-economy-explorer"] = json!({
        "description":"Read-only exploration of files and documentation. Use for independent bounded searches before implementing changes.",
        "prompt":"Explore only the requested question. Do not edit files, launch other agents or consult the advisor. Prefer targeted search. Return at most 8 concise findings with file/line evidence; do not paste complete files or repeat the parent conversation.",
        "model":profile.explorer.model,
        "tools":["Read","Grep","Glob","WebFetch","WebSearch"],
        "maxTurns":8
    });
    if let Some(effort) = &profile.explorer.effort {
        agents["agentdeck-economy-explorer"]["effort"] = json!(effort);
    }
    if profile.advisor_mode == "subagent" {
        agents["agentdeck-economy-advisor"] = json!({
            "description":"Read-only independent review for consequential decisions, repeated failures or risky changes. Use sparingly.",
            "prompt":"Review only the supplied concise brief and evidence. Do not edit files, launch agents or consult the native advisor. Return at most 8 concise findings with evidence and recommended next steps. Do not repeat the parent conversation.",
            "model":profile.advisor.model,
            "tools":["Read","Grep","Glob","WebFetch","WebSearch"],
            "maxTurns":8
        });
        if let Some(effort) = &profile.advisor.effort {
            agents["agentdeck-economy-advisor"]["effort"] = json!(effort);
        }
    }
    replace_pair(args, &["--agents"], "--agents", agents.to_string());
    // Route unspecified subagent models; built-ins and explicit agent models retain precedence.
    Ok(vec![(
        "CLAUDE_CODE_SUBAGENT_MODEL".into(),
        profile.explorer.model.clone(),
    )])
}

fn read_overlay(args: &[String], flag: &str, workdir: &str) -> Result<serde_json::Value, String> {
    let Some(position) = args
        .iter()
        .rposition(|arg| arg == flag || arg.starts_with(&format!("{flag}=")))
    else {
        return Ok(json!({}));
    };
    let value = args[position]
        .strip_prefix(&format!("{flag}="))
        .or_else(|| args.get(position + 1).map(String::as_str))
        .ok_or("Missing CLI overlay value")?;
    let text = if value.trim_start().starts_with('{') {
        value.to_owned()
    } else {
        use std::io::Read;
        let path = crate::util::resolve_path_from_workdir(workdir, value);
        let mut text = String::new();
        fs::File::open(path)
            .and_then(|file| file.take(2 * 1024 * 1024).read_to_string(&mut text))
            .map_err(|_| "Could not read CLI overlay for multi-agent economy")?;
        text
    };
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "Invalid CLI overlay for multi-agent economy")?;
    if !value.is_object() {
        return Err("CLI overlay must be an object".into());
    }
    Ok(value)
}

pub fn guidance(profile: &Profile, provider: &str) -> String {
    let advisor = if provider == "codex" {
        format!("For consequential plan decisions, a repeated failure, or a risky final review, spawn a fresh advisor with model={} and reasoning_effort={}. Explicitly set both values; default subagents use the explorer model. Send a concise problem brief and relevant evidence, not the full conversation. Advisor is read-only; no nested delegation.", profile.advisor.model, profile.advisor.effort.as_deref().unwrap_or("high"))
    } else if profile.advisor_mode == "native" {
        "Consult the native advisor only for a consequential plan decision, a repeated failure, or a risky final review. Each consultation sends conversation context and consumes additional tokens. Avoid repeated consultations and do not call it for routine edits.".into()
    } else {
        format!("For a consequential plan decision, a repeated failure, or a risky final review, use the read-only agentdeck-economy-advisor subagent (model={}). Send a concise problem brief and relevant evidence, not the full conversation. No nested delegation. Avoid routine or repeated consultations.", profile.advisor.model)
    };
    format!("\n[Agentdeck multi-agent economy]\nYou coordinate and implement with the user's selected main model, effort and speed options. Do not switch the main model to enact this mode. Use at most two independent read-only explorers in parallel when a task benefits from separate investigation; simple work stays local. Exploration model: {}{}{}. Give narrow questions and ask for short evidence-based summaries (at most 8 findings); do not duplicate scans, paste whole files, copy the full parent history, or spawn agents recursively. {} Preserve all user choices, approvals, sandbox rules and selected knowledge scope. This mode does not authorize external actions.\n[/Agentdeck multi-agent economy]\n", profile.explorer.model,
        if provider == "claude-code" { " (agentdeck-economy-explorer)" } else { "" },
        profile.explorer.effort.as_ref().map(|effort| format!(", reasoning_effort={effort}")).unwrap_or_default(), advisor)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn models() -> Vec<AgentModel> {
        serde_json::from_value(json!([
        {"id":"gpt-6.1-sol","label":"Sol","reasoningEfforts":["medium","high"],"fastMode":true,"cliVersion":"0.162.1"},
        {"id":"gpt-6-luna","label":"Luna","reasoningEfforts":["low"],"fastMode":false,"cliVersion":"0.162.1"},
        {"id":"gpt-6-astra","label":"Astra","reasoningEfforts":["high"],"fastMode":true,"cliVersion":"0.162.1"}
    ])).unwrap()
    }

    fn claude_models() -> Vec<AgentModel> {
        serde_json::from_value(json!([
            {"id":"default","resolvedModel":"claude-sonnet-5-5","label":"Default","reasoningEfforts":["medium"],"fastMode":false,"cliVersion":"2.1.300"},
            {"id":"sonnet","resolvedModel":"claude-sonnet-5-5","label":"Sonnet 5.5","reasoningEfforts":["medium"],"fastMode":false,"cliVersion":"2.1.300"},
            {"id":"haiku","resolvedModel":"claude-haiku-5-5","label":"Haiku 5.5","reasoningEfforts":["low"],"fastMode":false,"cliVersion":"2.1.300"},
            {"id":"opus","resolvedModel":"claude-opus-5-5","label":"Opus 5.5","reasoningEfforts":["high","max"],"fastMode":true,"cliVersion":"2.1.300"},
            {"id":"fable","resolvedModel":"claude-fable-5-1","label":"Fable 5.1","reasoningEfforts":["max"],"fastMode":false,"cliVersion":"2.1.300"}
        ])).unwrap()
    }

    #[test]
    fn requires_known_available_models_and_verified_cli() {
        let mut values = models();
        assert_eq!(
            profile("codex", &values, Some("gpt-6-astra"), Some("high"))
                .unwrap()
                .explorer
                .model,
            "gpt-6-luna"
        );
        values.retain(|model| !model.id.ends_with("astra"));
        assert_eq!(
            profile("codex", &values, Some("custom-main"), None)
                .unwrap()
                .advisor
                .model,
            "gpt-6.1-sol"
        );
        values.retain(|model| !model.id.ends_with("luna"));
        assert_eq!(
            profile("codex", &values, None, None).unwrap_err(),
            "models_unavailable"
        );
        for model in &mut values {
            model.cli_version = Some("0.100.0".into());
        }
        assert_eq!(
            profile("codex", &values, None, None).unwrap_err(),
            "cli_update_required"
        );
    }
    #[test]
    fn codex_preserves_selected_main_model_effort_speed_permissions_and_resume() {
        for main_args in [
            vec!["--model", "gpt-6-astra"],
            vec!["--model=gpt-6-astra"],
            vec!["-m", "gpt-6-astra"],
            vec!["-mgpt-6-astra"],
            vec!["-m=gpt-6-astra"],
            vec!["-c", "model=\"custom-model\""],
            vec![],
        ] {
            for resumed in [false, true] {
                let mut args = main_args
                    .iter()
                    .map(|value| (*value).into())
                    .collect::<Vec<String>>();
                args.extend(
                    [
                        "-c",
                        "model_reasoning_effort=\"ultra\"",
                        "-c",
                        "service_tier=\"fast\"",
                        "-c",
                        "features.fast_mode=true",
                        "-c",
                        "sandbox_mode=\"read-only\"",
                    ]
                    .map(str::to_owned),
                );
                if resumed {
                    args.extend(["resume".into(), "native-conversation".into()]);
                }
                let original = args.clone();
                let (model, effort) = selection("codex", &args);
                let routing =
                    profile("codex", &models(), model.as_deref(), effort.as_deref()).unwrap();
                assert!(configure(&routing, "codex", "", &mut args)
                    .unwrap()
                    .is_empty());
                assert_eq!(&args[..original.len()], &original);
                // Every added config key affects auxiliary agents only.
                assert!(args[original.len()..]
                    .chunks_exact(2)
                    .all(|pair| pair[0] == "-c" && pair[1].starts_with("agents.")));
                assert!(args.contains(&"agents.default_subagent_model=\"gpt-6-luna\"".into()));
                assert!(args.contains(&"agents.max_concurrent_threads_per_session=3".into()));
                assert_eq!(routing.coordinator.effort.as_deref(), Some("ultra"));
                assert!(guidance(&routing, "codex").contains("model=gpt-6-astra"));
            }
        }
    }
    #[test]
    fn claude_merge_retains_hooks_permissions_and_custom_agents() {
        let profile = profile("claude-code", &claude_models(), Some("opus"), Some("max")).unwrap();
        let mut args = vec![
            "--model=opus".into(),
            "--effort=max".into(),
            "--settings={\"fastMode\":true}".into(),
            "--settings".into(),
            json!({"permissions":{"deny":["Bash(rm*)"]},"hooks":{"Stop":[]},"fastMode":true,"ultracode":true})
                .to_string(),
            "--agents".into(),
            json!({"custom":{"model":"inherit"}}).to_string(),
        ];
        let original_settings = read_overlay(&args, "--settings", "").unwrap();
        let original_main = args[..5].to_vec();
        let env = configure(&profile, "claude-code", "", &mut args).unwrap();
        let settings = read_overlay(&args, "--settings", "").unwrap();
        assert_eq!(&args[..5], &original_main);
        assert_eq!(settings, original_settings);
        assert_eq!(settings["permissions"]["deny"][0], "Bash(rm*)");
        assert!(settings["hooks"]["Stop"].is_array());
        assert_eq!(settings["fastMode"], true);
        assert_eq!(settings["ultracode"], true);
        assert!(read_overlay(&args, "--agents", "").unwrap()["custom"].is_object());
        assert_eq!(
            args.iter()
                .filter(|arg| arg.starts_with("--model"))
                .collect::<Vec<_>>(),
            vec![&"--model=opus".to_string()]
        );
        assert!(env
            .iter()
            .any(|(key, _)| key == "CLAUDE_CODE_SUBAGENT_MODEL"));
        assert!(!env.iter().any(|(key, _)| key == "CLAUDE_CODE_EFFORT_LEVEL"));
        assert_eq!(
            read_overlay(&args, "--agents", "").unwrap()["agentdeck-economy-explorer"]["effort"],
            "low"
        );
    }
    #[test]
    fn claude_native_advisor_only_for_known_explicit_compatible_main_models() {
        let mut values = claude_models();
        for main in [
            "sonnet",
            "opus",
            "haiku",
            "claude-sonnet-4-6-20251001",
            "claude-opus-5-5",
        ] {
            let routing = profile("claude-code", &values, Some(main), Some("max")).unwrap();
            assert_eq!(routing.coordinator.effort.as_deref(), Some("max"));
            assert_eq!(routing.advisor_mode, "native");
            assert_eq!(routing.explorer.model, "claude-haiku-5-5");
        }
        // Sonnet need not be installed, selected, or support a prescribed main effort.
        values.retain(|model| model.id != "sonnet");
        assert!(profile("claude-code", &values, Some("opus"), Some("max")).is_ok());
    }

    #[test]
    fn claude_custom_fable_and_default_preserve_native_selection_and_use_review_subagent() {
        for main in [
            None,
            Some(""),
            Some("default"),
            Some("fable"),
            Some("claude-fable-5-1"),
            Some("private-model"),
            Some("claude-sonnet-6"),
        ] {
            for resumed in [false, true] {
                let routing = profile("claude-code", &claude_models(), main, None).unwrap();
                assert_eq!(routing.advisor_mode, "subagent");
                assert!(routing.coordinator.effort.is_none());
                let mut args: Vec<String> = vec![
                    "--effort=max".into(),
                    "--settings={\"fastMode\":true,\"ultracode\":true}".into(),
                ];
                if let Some(model) = main.filter(|id| !id.is_empty() && *id != "default") {
                    args.extend(["--model".into(), model.into()]);
                }
                if resumed {
                    args.extend(["--resume".into(), "native-conversation".into()]);
                }
                let original = args.clone();
                configure(&routing, "claude-code", "", &mut args).unwrap();
                assert_eq!(&args[..original.len()], &original);
                assert!(!args.iter().any(|arg| arg.starts_with("--advisor")));
                let agents = read_overlay(&args, "--agents", "").unwrap();
                assert_eq!(
                    agents["agentdeck-economy-advisor"]["model"],
                    "claude-opus-5-5"
                );
                assert_eq!(agents["agentdeck-economy-advisor"]["effort"], "high");
                assert!(agents["agentdeck-economy-advisor"]["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|tool| !matches!(tool.as_str(), Some("Edit" | "Write" | "Bash"))));
                assert!(guidance(&routing, "claude-code").contains("agentdeck-economy-advisor"));
            }
        }
    }

    #[test]
    fn profiles_reflect_each_sessions_selection_without_mutating_catalogue() {
        let values = claude_models();
        let before = serde_json::to_string(&values).unwrap();
        let native = profile("claude-code", &values, Some("opus"), Some("max")).unwrap();
        let fallback = profile("claude-code", &values, Some("fable"), Some("low")).unwrap();
        assert_ne!(
            serde_json::to_string(&native).unwrap(),
            serde_json::to_string(&fallback).unwrap()
        );
        assert_eq!(native.coordinator.model, "claude-opus-5-5");
        assert_eq!(fallback.coordinator.model, "claude-fable-5-1");
        assert_eq!(
            profile("claude-code", &values, Some("claude-sonnet-5-5"), None)
                .unwrap()
                .coordinator
                .label,
            "Sonnet 5.5"
        );
        assert_eq!(before, serde_json::to_string(&values).unwrap());
        let codex = models()
            .into_iter()
            .filter(|model| !model.id.ends_with("sol"))
            .collect::<Vec<_>>();
        assert!(profile("codex", &codex, Some("gpt-6-astra"), Some("high")).is_ok());
    }

    #[test]
    fn selection_reads_native_flag_forms_precedence_and_stops_at_prompt_separator() {
        let cases = [
            (vec!["--model", "opus"], Some("opus"), None),
            (
                vec!["--model=opus", "--effort=max"],
                Some("opus"),
                Some("max"),
            ),
            (
                vec!["-m", "fable", "--effort", "low"],
                Some("fable"),
                Some("low"),
            ),
            (vec!["-mfable"], Some("fable"), None),
            (vec!["-m=fable"], Some("fable"), None),
            (vec!["--", "--model=prompt-text"], None, None),
            (vec!["--model", "--", "--model=prompt-text"], None, None),
        ];
        for (args, model, effort) in cases {
            let args = args.into_iter().map(str::to_owned).collect::<Vec<_>>();
            assert_eq!(
                selection("claude-code", &args),
                (model.map(str::to_owned), effort.map(str::to_owned))
            );
        }
        for config in ["-c", "--config"] {
            let args = [
                config,
                "model='first'",
                "-cmodel=\"second\"",
                "--config=model_reasoning_effort='xhigh'",
                "--",
                "-mignored",
            ]
            .map(str::to_owned);
            assert_eq!(
                selection("codex", &args),
                (Some("second".into()), Some("xhigh".into()))
            );
            let mut args = args[..4].to_vec();
            args.extend([
                "--model=chosen".into(),
                "-c".into(),
                "model=last-config".into(),
            ]);
            assert_eq!(selection("codex", &args).0.as_deref(), Some("chosen"));
        }
    }

    #[test]
    fn routing_only_changes_options_before_prompt_separator() {
        let tail = [
            "--",
            "user prompt",
            "--model=literal",
            "--advisor=literal",
            "--agents",
            "{not an overlay}",
            "--settings=literal",
        ]
        .map(str::to_owned);
        for (provider, models, main) in [
            ("codex", models(), "gpt-6-astra"),
            ("claude-code", claude_models(), "opus"),
        ] {
            let routing = profile(provider, &models, Some(main), Some("high")).unwrap();
            let prefix = ["--model", main].map(str::to_owned);
            let mut args = prefix.to_vec();
            args.extend_from_slice(&tail);
            configure(&routing, provider, "", &mut args).unwrap();
            let boundary = args.iter().position(|arg| arg == "--").unwrap();
            assert_eq!(&args[boundary..], &tail);
            assert_eq!(&args[..prefix.len()], &prefix);
            assert!(boundary > prefix.len());
        }
    }
}
