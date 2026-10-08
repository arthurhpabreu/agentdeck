//! Bounded provider events. No terminal scraping, reasoning or raw transcript persistence.
use crate::shared_memory::{redact_secrets, Engine, MemoryEvent};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Default)]
pub struct StreamCapture {
    pending: std::collections::HashMap<String, (String, Value)>,
}
impl StreamCapture {
    pub fn ingest(&mut self, input: &Value) -> Vec<MemoryEvent> {
        let mut events = Vec::new();
        if input["type"] == "assistant" {
            if let Some(blocks) = input["message"]["content"].as_array() {
                for block in blocks {
                    if block["type"] == "tool_use" && self.pending.len() < 32 {
                        if let (Some(id), Some(name)) =
                            (block["id"].as_str(), block["name"].as_str())
                        {
                            // Keep only the fields useful for a handoff, excluding code and secrets.
                            let source = &block["input"];
                            let mut metadata = json!({});
                            for key in ["command", "cmd", "file_path", "path", "absolute_path"] {
                                if let Some(text) = source[key].as_str() {
                                    metadata[key] = json!(bounded(text, 2000));
                                }
                            }
                            self.pending.insert(id.into(), (name.into(), metadata));
                        }
                    }
                }
            }
        } else if input["type"] == "user" {
            if let Some(blocks) = input["message"]["content"].as_array() {
                for block in blocks {
                    if block["type"] == "tool_result" {
                        if let Some((name, metadata)) = block["tool_use_id"]
                            .as_str()
                            .and_then(|id| self.pending.remove(id))
                        {
                            events.extend(normalize(&json!({"hook_event_name":"PostToolUse","tool_use_id":block["tool_use_id"],"tool_name":name,"tool_input":metadata,"is_error":block["is_error"]})));
                        }
                    }
                }
            }
        } else if input["type"] == "item.completed" {
            let item = &input["item"];
            if item["type"] == "command_execution" {
                events.extend(normalize(&json!({"hook_event_name":"PostToolUse","tool_use_id":item["id"],"tool_name":"Bash","tool_input":{"command":item["command"]},"tool_response":{"exit_code":item["exit_code"]}})));
            } else if item["type"] == "file_change" {
                if let Some(changes) = item["changes"].as_array() {
                    for (position, change) in changes.iter().take(16).enumerate() {
                        events.extend(normalize(&json!({"hook_event_name":"PostToolUse","tool_use_id":format!("{}:{position}",item["id"].as_str().unwrap_or("file")),"tool_name":"apply_patch","tool_input":{"path":change["path"]},"is_error":item["status"]=="failed"})));
                    }
                }
            }
        }
        events
    }
}

fn bounded(text: &str, max: usize) -> String {
    crate::memory_runtime::truncate(&redact_secrets(text), max)
}
fn clean_prompt(text: &str) -> String {
    let mut text = text.to_owned();
    for (open, close) in [
        ("<agentdeck_memory>", "</agentdeck_memory>"),
        ("<agentdeck_knowledge>", "</agentdeck_knowledge>"),
    ] {
        while let Some(start) = text.find(open) {
            let Some(end) = text[start..].find(close) else {
                text.truncate(start);
                break;
            };
            text.replace_range(start..start + end + close.len(), "");
        }
    }
    bounded(text.trim(), 1600)
}
pub fn normalize(input: &Value) -> Vec<MemoryEvent> {
    let event = input["hook_event_name"].as_str().unwrap_or("");
    let key = input["event_id"]
        .as_str()
        .or(input["tool_use_id"].as_str())
        .or(input["turn_id"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let id = format!("{:x}", Sha256::digest(format!("{event}:{key}").as_bytes()));
    let mut files = Vec::new();
    let tool_input = &input["tool_input"];
    for key in ["file_path", "path", "absolute_path"] {
        if let Some(file) = tool_input[key].as_str() {
            files.push(bounded(file, 300));
        }
    }
    // apply_patch reports a patch string: keep only file headers, never patch bodies.
    if input["tool_name"] == "apply_patch" {
        for line in tool_input["command"].as_str().unwrap_or("").lines() {
            for prefix in ["*** Update File: ", "*** Add File: ", "*** Delete File: "] {
                if let Some(file) = line.strip_prefix(prefix) {
                    if files.len() < 16 {
                        files.push(bounded(file, 300));
                    }
                }
            }
        }
    }
    let make = |kind: &str, summary: String| MemoryEvent {
        id: id.clone(),
        kind: kind.into(),
        title: bounded(input["tool_name"].as_str().unwrap_or(event), 240),
        summary,
        files: files.clone(),
        branch: String::new(),
    };
    match event {
        "UserPromptSubmit" | "BeforeAgent" => {
            let prompt = clean_prompt(input["prompt"].as_str().unwrap_or(""));
            if prompt.is_empty() || prompt.starts_with('/') {
                vec![]
            } else {
                vec![make("prompt", prompt)]
            }
        }
        "PostToolUse" | "PostToolUseFailure" | "AfterTool" => {
            let name = input["tool_name"].as_str().unwrap_or("tool");
            if name.contains("agentdeck_memory") {
                return vec![];
            }
            let response = &input["tool_response"];
            let exit = response["exit_code"]
                .as_i64()
                .or(response["exitCode"].as_i64());
            let failed = event == "PostToolUseFailure"
                || input["is_error"] == true
                || response["is_error"] == true
                || response["error"].is_object()
                || response["error"].as_str().is_some_and(|s| !s.is_empty())
                || exit.is_some_and(|code| code != 0);
            let command = tool_input["command"]
                .as_str()
                .or(tool_input["cmd"].as_str())
                .unwrap_or("");
            let verification = [
                " test",
                "pytest",
                "vitest",
                "playwright",
                "tsc",
                "check",
                "lint",
            ]
            .iter()
            .any(|term| command.to_lowercase().contains(term));
            let kind = if failed {
                "failure"
            } else if verification {
                "verification"
            } else if !files.is_empty() {
                "file"
            } else {
                "tool"
            };
            let status = if failed {
                "provider reported failure"
            } else if exit == Some(0) {
                "exit code 0"
            } else {
                "tool completed; test success not independently established"
            };
            let detail = input["error"]
                .as_str()
                .or(response["error"].as_str())
                .unwrap_or("");
            vec![make(
                kind,
                bounded(&format!("{name}: {command}; {status}. {detail}"), 1200),
            )]
        }
        "Stop" | "AfterAgent" | "SessionEnd" => {
            let answer = input["last_assistant_message"]
                .as_str()
                .or(input["prompt_response"].as_str())
                .unwrap_or("");
            let mut events = Vec::new();
            if !answer.trim().is_empty() {
                let mut answer_event = make(
                    "answer",
                    bounded(&crate::shared_memory::extract_handoff(answer), 1600),
                );
                answer_event.id.push_str("-answer");
                events.push(answer_event);
            }
            events.push(make(if event=="SessionEnd"{"session-end"}else{"turn-end"},"Pending: review the final answer and verify unresolved work; task completion is not inferred.".into()));
            events
        }
        "StopFailure" => vec![make(
            "failure",
            bounded(
                input["last_assistant_message"]
                    .as_str()
                    .unwrap_or("Provider turn failed"),
                1000,
            ),
        )],
        _ => vec![],
    }
}
#[derive(Serialize, Deserialize)]
struct HookContext {
    directory: PathBuf,
    project: String,
    session: String,
    provider: String,
}
fn command(executable: &str, context: &str) -> String {
    callback_command(executable, "--memory-hook", context)
}
pub(crate) fn callback_command(executable: &str, flag: &str, context: &str) -> String {
    #[cfg(windows)]
    {
        let script=format!("$ProgressPreference = 'SilentlyContinue'; $OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding = $OutputEncoding; $inputPayload = [Console]::In.ReadToEnd(); $inputPayload | & '{}' {flag} --context '{}'",executable.replace('\'',"''"),context);
        let utf16 = script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        format!(
            "powershell.exe -NoProfile -NonInteractive -EncodedCommand {}",
            STANDARD.encode(utf16)
        )
    }
    #[cfg(not(windows))]
    {
        format!(
            "'{}' {flag} --context '{}'",
            executable.replace('\'', "'\\''"),
            context
        )
    }
}
pub fn codex_rtk_override(definition: Value, args: &mut Vec<String>) -> Result<(), String> {
    // Codex combines hooks from active config layers itself. Copying user hooks
    // into session flags runs them twice and changes their native trust identity.
    merge_codex_rtk_override(definition, args)
}
fn merge_codex_rtk_override(definition: Value, args: &mut Vec<String>) -> Result<(), String> {
    let mut groups = Vec::new();
    // Retain an explicit per-process override instead of silently replacing it.
    for pair in args
        .windows(2)
        .filter(|p| p[0] == "-c" || p[0] == "--config")
    {
        if pair[1].starts_with("hooks.PreToolUse=") {
            let config: toml::Value =
                toml::from_str(&pair[1]).map_err(|_| "Cannot merge explicit RTK hooks")?;
            groups = serde_json::to_value(&config).map_err(|_| "Cannot merge RTK hooks")?["hooks"]
                ["PreToolUse"]
                .as_array()
                .cloned()
                .ok_or("Invalid RTK hook override")?;
        }
    }
    if !groups.iter().any(|group| {
        group["matcher"] == "^Bash$"
            && group["hooks"]
                .as_array()
                .is_some_and(|hooks| hooks.contains(&definition))
    }) {
        groups.push(json!({"matcher":"^Bash$","hooks":[definition]}));
    }
    let mut index = 0;
    while index + 1 < args.len() {
        if (args[index] == "-c" || args[index] == "--config")
            && args[index + 1].starts_with("hooks.PreToolUse=")
        {
            args.drain(index..index + 2);
        } else {
            index += 1;
        }
    }
    args.splice(
        0..0,
        [
            "-c".into(),
            format!("hooks.PreToolUse={}", toml_inline(&Value::Array(groups))?),
        ],
    );
    Ok(())
}
pub fn hook_definition(
    directory: &Path,
    project: &str,
    session: &str,
    provider: &str,
) -> Result<Value, String> {
    let context = STANDARD.encode(
        serde_json::to_vec(&HookContext {
            directory: directory.into(),
            project: project.into(),
            session: session.into(),
            provider: provider.into(),
        })
        .map_err(|e| e.to_string())?,
    );
    let executable = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    Ok(
        json!({"type":"command","command":command(&executable,&context),"timeout":if provider=="gemini"{5000}else{5}}),
    )
}
pub fn merge_hooks(settings: &mut Value, provider: &str, definition: Value) -> Result<(), String> {
    if settings["disableAllHooks"] == true || settings["hooksConfig"]["enabled"] == false {
        return Ok(());
    }
    let hooks = settings
        .as_object_mut()
        .ok_or("Settings must be an object")?
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("Hooks must be an object")?;
    let events: &[&str] = if provider == "gemini" {
        &["BeforeAgent", "AfterTool", "AfterAgent", "SessionEnd"]
    } else {
        &[
            "UserPromptSubmit",
            "PostToolUse",
            "PostToolUseFailure",
            "Stop",
            "StopFailure",
        ]
    };
    for event in events {
        let groups = hooks
            .entry(*event)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or("Hook groups must be arrays")?;
        if !groups.iter().any(|g| {
            g["hooks"]
                .as_array()
                .is_some_and(|hooks| hooks.iter().any(|h| h == &definition))
        }) {
            groups.push(json!({"hooks":[definition.clone()]}));
        }
    }
    Ok(())
}
pub fn claude_overlay(
    directory: &Path,
    project: &str,
    session: &str,
    args: &mut Vec<String>,
) -> Result<(), String> {
    let position = args
        .iter()
        .position(|arg| arg == "--settings" || arg.starts_with("--settings="));
    let mut settings = if let Some(position) = position {
        let value = args[position]
            .strip_prefix("--settings=")
            .or_else(|| args.get(position + 1).map(String::as_str))
            .ok_or("Missing Claude settings")?;
        if value.trim_start().starts_with('{') {
            serde_json::from_str(value).map_err(|e| format!("Cannot merge Claude settings: {e}"))?
        } else {
            let path = crate::util::resolve_path_from_workdir(project, value);
            let mut bytes = Vec::new();
            fs::File::open(path)
                .and_then(|file| file.take(256 * 1024 + 1).read_to_end(&mut bytes))
                .map_err(|e| e.to_string())?;
            if bytes.len() > 256 * 1024 {
                return Err("Claude settings exceed merge limit".into());
            }
            serde_json::from_slice(&bytes).map_err(|e| e.to_string())?
        }
    } else {
        json!({})
    };
    merge_hooks(
        &mut settings,
        "claude-code",
        hook_definition(directory, project, session, "claude-code")?,
    )?;
    let folder = directory.join("memory/mcp-config");
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let path = folder.join(format!("claude-capture-{}.json", uuid::Uuid::new_v4()));
    fs::write(
        &path,
        serde_json::to_vec(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let value = path.to_string_lossy().into_owned();
    if let Some(position) = position {
        if args[position].starts_with("--settings=") {
            args[position] = format!("--settings={value}");
        } else {
            args[position + 1] = value;
        }
    } else {
        args.extend(["--settings".into(), value]);
    }
    Ok(())
}
pub fn codex_overrides(
    directory: &Path,
    project: &str,
    session: &str,
    args: &mut Vec<String>,
) -> Result<(), String> {
    let definition = hook_definition(directory, project, session, "codex")?;
    // CLI overrides affect this child only; leave hook enablement/trust to native policy.
    // Preserve user-level inline definitions. Project layers remain under native trust checks.
    let mut stored = json!({});
    if let Some(home) = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(|home| PathBuf::from(home).join(".codex"))
        })
    {
        read_codex_inline(&home.join("config.toml"), &mut stored)?;
    }
    let hooks = stored.as_object_mut().ok_or("Invalid inline hooks")?;
    for event in ["UserPromptSubmit", "PostToolUse", "Stop"] {
        let groups = hooks
            .entry(event)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or("Invalid Codex hooks")?;
        groups.push(json!({"hooks":[definition.clone()]}));
        let value = toml_inline(&Value::Array(groups.clone()))?;
        args.splice(0..0, ["-c".into(), format!("hooks.{event}={value}")]);
    }
    Ok(())
}
fn read_codex_inline(path: &Path, out: &mut Value) -> Result<(), String> {
    let Ok(file) = fs::File::open(path) else {
        return Ok(());
    };
    let mut text = String::new();
    file.take(256 * 1024 + 1)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    if text.len() > 256 * 1024 {
        return Err("Codex settings exceed merge limit".into());
    }
    let config: toml::Table = toml::from_str(&text).map_err(|_| {
        "Cannot merge Codex inline hooks: invalid TOML; original settings were preserved."
            .to_owned()
    })?;
    if let Some(hooks) = config.get("hooks").and_then(toml::Value::as_table) {
        for (event, value) in hooks {
            if let Some(groups) = value.as_array() {
                let target = out
                    .as_object_mut()
                    .unwrap()
                    .entry(event)
                    .or_insert_with(|| json!([]))
                    .as_array_mut()
                    .ok_or("Invalid hook groups")?;
                for group in groups {
                    target.push(serde_json::to_value(group).map_err(|e| e.to_string())?);
                }
            }
        }
    }
    Ok(())
}
fn toml_inline(value: &Value) -> Result<String, String> {
    match value {
        Value::String(s) => Ok(json!(s).to_string()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Bool(b) => Ok(b.to_string()),
        Value::Array(v) => Ok(format!(
            "[{}]",
            v.iter()
                .map(toml_inline)
                .collect::<Result<Vec<_>, _>>()?
                .join(",")
        )),
        Value::Object(v) => Ok(format!(
            "{{{}}}",
            v.iter()
                .map(|(k, v)| Ok(format!("{}={}", json!(k), toml_inline(v)?)))
                .collect::<Result<Vec<_>, String>>()?
                .join(",")
        )),
        _ => Err("Null is not supported in hook settings".into()),
    }
}

pub fn stdio_entry() -> Option<i32> {
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).map(String::as_str) != Some("--memory-hook") {
        return None;
    }
    let run = || -> Result<(), String> {
        let encoded = args
            .iter()
            .position(|v| v == "--context")
            .and_then(|i| args.get(i + 1))
            .filter(|s| s.len() < 16000)
            .ok_or("Missing hook context")?;
        let context: HookContext =
            serde_json::from_slice(&STANDARD.decode(encoded).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if !context.directory.is_absolute() {
            return Err("Hook storage must be absolute".into());
        }
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(256 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 256 * 1024 {
            return Err("Hook payload exceeds limit".into());
        }
        let input: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let engine = Engine::open(&context.directory)?;
        let project = engine.register_project(&context.project, None)?;
        for event in normalize(&input) {
            engine.record_event(&project, &context.session, &context.provider, &event)?;
        }
        Ok(())
    };
    if let Err(error) = run() {
        eprintln!("Agentdeck memory capture: {error}");
    }
    // Capture cannot block an agent, grant permissions or inject hook instructions.
    println!("{{}}");
    Some(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rtk_override_merges_explicit_hooks_once_without_a_later_override_winning() {
        let existing =
            json!([{"matcher":"Bash","hooks":[{"type":"command","command":"existing"}]}]);
        let mut args = vec![
            "-c".into(),
            format!("hooks.PreToolUse={}", toml_inline(&existing).unwrap()),
            "app-server".into(),
        ];
        merge_codex_rtk_override(json!({"type":"command","command":"rtk-adapter"}), &mut args)
            .unwrap();
        assert_eq!(args.len(), 3);
        assert_eq!(args[2], "app-server");
        let config: toml::Value = toml::from_str(&args[1]).unwrap();
        let groups = serde_json::to_value(config).unwrap();
        assert_eq!(groups["hooks"]["PreToolUse"][0], existing[0]);
        assert_eq!(
            groups["hooks"]["PreToolUse"][1]["hooks"][0]["command"],
            "rtk-adapter"
        );
        let once = args.clone();
        merge_codex_rtk_override(json!({"type":"command","command":"rtk-adapter"}), &mut args)
            .unwrap();
        assert_eq!(
            args, once,
            "Preparing a launch twice must not duplicate hooks"
        );
    }
    #[test]
    fn tool_completion_is_not_assumed_test_success() {
        let event=normalize(&json!({"hook_event_name":"PostToolUse","tool_use_id":"id","tool_name":"Bash","tool_input":{"command":"cargo test"},"tool_response":"output without status"})).remove(0);
        assert_eq!(event.kind, "verification");
        assert!(event.summary.contains("not independently established"));
    }
    #[test]
    fn failures_and_file_paths_are_structured_without_bodies() {
        let events = normalize(
            &json!({"hook_event_name":"PostToolUseFailure","tool_name":"Write","tool_input":{"file_path":"src/auth.rs","content":"private body"},"error":"Permission denied"}),
        );
        assert_eq!(events[0].kind, "failure");
        assert_eq!(events[0].files, ["src/auth.rs"]);
        assert!(!events[0].summary.contains("private body"));
    }
    #[test]
    fn merging_respects_disabled_hooks_and_keeps_existing() {
        let definition = json!({"type":"command","command":"capture"});
        let mut disabled = json!({"disableAllHooks":true});
        merge_hooks(&mut disabled, "claude-code", definition.clone()).unwrap();
        assert!(disabled.get("hooks").is_none());
        let mut settings = json!({"permissions":{"deny":["Bash(*)"]},"hooks":{"Stop":[{"hooks":[{"command":"existing"}]}]}});
        merge_hooks(&mut settings, "claude-code", definition).unwrap();
        assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(settings["permissions"]["deny"][0], "Bash(*)");
    }
    #[test]
    fn hook_toml_handles_spaces_unicode_and_shell_symbols() {
        let value = json!([{"hooks":[{"type":"command","command":"a b '$ ` ç", "timeout":5}]}]);
        let parsed: toml::Table =
            toml::from_str(&format!("hooks.Stop={}", toml_inline(&value).unwrap())).unwrap();
        assert_eq!(
            serde_json::to_value(&parsed["hooks"]["Stop"]).unwrap(),
            value
        );
    }
    #[test]
    fn memory_echo_does_not_become_user_preference() {
        let events = normalize(
            &json!({"hook_event_name":"UserPromptSubmit","prompt":"<agentdeck_memory>prefiro npm</agentdeck_memory>\nCorrigir auth"}),
        );
        assert_eq!(events[0].summary, "Corrigir auth");
    }
}
