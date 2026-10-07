//! Read-only, bounded inspection of provider-owned transcripts for the agent monitor.
//! Relationships are taken from native session metadata, never guessed from cwd.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_TRANSCRIPT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_EVENTS: usize = 60;
const MAX_AGENTS: usize = 64;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserveSession {
    session_id: String,
    provider: String,
    provider_session_id: Option<String>,
    workdir: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    id: String,
    kind: String,
    title: String,
    detail: String,
    status: String,
    timestamp: Option<String>,
    delegated_agent_id: Option<String>,
    delegated_role: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedAgent {
    id: String,
    session_id: String,
    parent_id: Option<String>,
    name: String,
    role: Option<String>,
    provider: String,
    task: String,
    last_message: String,
    status: String,
    updated_at: Option<u64>,
    model: Option<String>,
    events: Vec<AgentEvent>,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    session_id: String,
    agents: Vec<ObservedAgent>,
    available: bool,
    reason: Option<String>,
}

#[derive(Clone)]
struct IndexedSession {
    id: String,
    parent_id: Option<String>,
    name: Option<String>,
    role: Option<String>,
    path: PathBuf,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn provider_dir(variable: &str, fallback: &str) -> Option<PathBuf> {
    std::env::var_os(variable)
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(fallback)))
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 180
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn limited(value: &str, max: usize) -> String {
    let mut chars = value.chars();
    let mut result: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        result.push('…');
    }
    result
}

fn content_text(value: &Value) -> String {
    if let Some(string) = value.as_str() {
        return limited(string, 3000);
    }
    value
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| match block.get("type").and_then(Value::as_str) {
                    Some("text" | "input_text" | "output_text") => {
                        block.get("text").and_then(Value::as_str)
                    }
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .map(|s| limited(&s, 3000))
        .unwrap_or_default()
}

fn display_input(value: &Value) -> String {
    for key in [
        "description",
        "prompt",
        "command",
        "cmd",
        "file_path",
        "path",
        "query",
        "pattern",
        "message",
    ] {
        if let Some(value) = value.get(key).and_then(Value::as_str) {
            return limited(value, 2000);
        }
    }
    if let Some(value) = value.as_str() {
        return limited(value, 2000);
    }
    if value.is_null() {
        String::new()
    } else {
        limited(&value.to_string(), 2000)
    }
}

fn timestamp(value: &Value) -> Option<String> {
    value
        .get("timestamp")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn push_tool(
    agent: &mut ObservedAgent,
    id: String,
    name: String,
    detail: String,
    at: Option<String>,
) {
    agent.status = "running".into();
    agent.events.push(AgentEvent {
        id,
        kind: "tool".into(),
        title: name,
        detail,
        status: "running".into(),
        timestamp: at,
        delegated_agent_id: None,
        delegated_role: None,
    });
    if agent.events.len() > MAX_EVENTS {
        agent.events.remove(0);
        agent.truncated = true;
    }
}

fn finish_tool(agent: &mut ObservedAgent, id: &str, failed: bool) {
    if let Some(event) = agent.events.iter_mut().rev().find(|event| event.id == id) {
        event.status = if failed { "failed" } else { "completed" }.into();
    }
    if failed {
        agent.status = "error".into();
    }
}

fn parse_record(agent: &mut ObservedAgent, record: &Value, provider: &str) {
    let at = timestamp(record);
    if provider == "claude-code" {
        let message = &record["message"];
        if let Some(model) = message.get("model").and_then(Value::as_str) {
            agent.model = Some(model.into());
        }
        let record_type = text(record, "type");
        if record_type == "user" && record.get("isMeta").and_then(Value::as_bool) != Some(true) {
            let task = content_text(&message["content"]);
            if !task.is_empty() {
                agent.task = task;
                agent.status = "running".into();
            }
        }
        if record_type == "assistant" {
            let answer = content_text(&message["content"]);
            if !answer.is_empty() {
                agent.last_message = answer;
            }
            if message["stop_reason"] == "end_turn" {
                agent.status = "done".into();
            }
        }
        if let Some(blocks) = message["content"].as_array() {
            for block in blocks {
                match block["type"].as_str().unwrap_or_default() {
                    "tool_use" => {
                        push_tool(
                            agent,
                            text(block, "id"),
                            text(block, "name"),
                            display_input(&block["input"]),
                            at.clone(),
                        );
                        if let Some(event) = agent.events.last_mut() {
                            event.delegated_role =
                                block["input"]["subagent_type"].as_str().map(str::to_string);
                        }
                    }
                    "tool_result" => {
                        let tool_id = text(block, "tool_use_id");
                        finish_tool(
                            agent,
                            &tool_id,
                            block["is_error"].as_bool().unwrap_or(false),
                        );
                        if let Some(child_id) = record["toolUseResult"]["agentId"].as_str() {
                            if let Some(event) = agent.events.iter_mut().rev().find(|event| {
                                event.id == tool_id
                                    && matches!(event.title.as_str(), "Task" | "Agent")
                            }) {
                                event.delegated_agent_id = Some(child_id.to_string());
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        return;
    }
    let payload = &record["payload"];
    if record["type"] == "turn_context" {
        if let Some(model) = payload.get("model").and_then(Value::as_str) {
            agent.model = Some(model.into());
        }
    }
    if record["type"] == "event_msg" {
        match payload["type"].as_str().unwrap_or_default() {
            "user_message" => {
                agent.task = limited(&text(payload, "message"), 3000);
                agent.status = "running".into();
            }
            "agent_message" => {
                agent.last_message = limited(&text(payload, "message"), 3000);
            }
            "task_started" | "turn_started" => agent.status = "running".into(),
            "task_complete" | "task_completed" | "turn_complete" | "turn_completed" => {
                agent.status = "done".into()
            }
            "turn_aborted" => agent.status = "stopped".into(),
            _ => {}
        }
    }
    if record["type"] != "response_item" {
        return;
    }
    match payload["type"].as_str().unwrap_or_default() {
        "message" => {
            let message = content_text(&payload["content"]);
            if payload["role"] == "user" && !message.is_empty() {
                agent.task = message;
            } else if payload["role"] == "assistant" && !message.is_empty() {
                agent.last_message = message;
            }
        }
        "function_call" | "custom_tool_call" => {
            let input = payload
                .get("arguments")
                .or_else(|| payload.get("input"))
                .unwrap_or(&Value::Null);
            let parsed = input
                .as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok());
            push_tool(
                agent,
                text(payload, "call_id"),
                text(payload, "name"),
                display_input(parsed.as_ref().unwrap_or(input)),
                at,
            );
        }
        "function_call_output" | "custom_tool_call_output" => {
            let output = payload.get("output").unwrap_or(&Value::Null);
            let failed = output
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            finish_tool(agent, &text(payload, "call_id"), failed);
        }
        _ => {}
    }
}

fn read_agent(
    entry: &IndexedSession,
    request: &ObserveSession,
    parent_id: Option<String>,
) -> Option<ObservedAgent> {
    let mut file = File::open(&entry.path).ok()?;
    let metadata = file.metadata().ok()?;
    let truncated = metadata.len() > MAX_TRANSCRIPT_BYTES;
    if truncated {
        file.seek(SeekFrom::End(-(MAX_TRANSCRIPT_BYTES as i64)))
            .ok()?;
    }
    let mut reader = BufReader::new(file.take(MAX_TRANSCRIPT_BYTES));
    if truncated {
        let mut partial = String::new();
        let _ = reader.read_line(&mut partial);
    }
    let mut agent = ObservedAgent {
        id: entry.id.clone(),
        session_id: request.session_id.clone(),
        parent_id,
        name: entry.name.clone().unwrap_or_else(|| {
            if entry.id == request.provider_session_id.as_deref().unwrap_or_default() {
                "Main agent".into()
            } else {
                format!("Agent {}", limited(&entry.id, 12))
            }
        }),
        role: entry.role.clone(),
        provider: request.provider.clone(),
        task: String::new(),
        last_message: String::new(),
        status: "unknown".into(),
        updated_at: metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|t| t.as_millis() as u64),
        model: None,
        events: Vec::new(),
        truncated,
    };
    for line in reader.lines().map_while(Result::ok) {
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            parse_record(&mut agent, &value, &request.provider);
        }
    }
    Some(agent)
}

fn parse_codex_header(value: &Value, path: PathBuf) -> Option<IndexedSession> {
    if value["type"] != "session_meta" {
        return None;
    }
    let payload = &value["payload"];
    let id = payload.get("id")?.as_str()?.to_string();
    let spawn = &payload["source"]["subagent"]["thread_spawn"];
    let parent_id = spawn
        .get("parent_thread_id")
        .or_else(|| payload["source"]["subagent"].get("parent_thread_id"))
        .or_else(|| payload.get("parent_thread_id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(IndexedSession {
        id,
        parent_id,
        path,
        name: spawn
            .get("agent_nickname")
            .or_else(|| payload.get("agent_nickname"))
            .and_then(Value::as_str)
            .map(str::to_string),
        role: spawn
            .get("agent_role")
            .or_else(|| payload.get("agent_role"))
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn transcript_files(
    dir: &Path,
    depth: usize,
    remaining: &mut usize,
    files: &mut Vec<(SystemTime, PathBuf)>,
) {
    if depth == 0 || *remaining == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    // Date-named paths visited newest first; symlinks are not traversed.
    let mut paths: Vec<_> = entries.flatten().take(*remaining).collect();
    paths.sort_by_key(|entry| std::cmp::Reverse(entry.file_name()));
    for entry in paths {
        if *remaining == 0 {
            break;
        }
        *remaining -= 1;
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            transcript_files(&entry.path(), depth - 1, remaining, files);
        } else if kind.is_file() && entry.path().extension().is_some_and(|ext| ext == "jsonl") {
            files.push((
                entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(UNIX_EPOCH),
                entry.path(),
            ));
        }
    }
}

type IndexCache = Option<(Instant, PathBuf, Vec<IndexedSession>)>;
static CODEX_INDEX: OnceLock<Mutex<IndexCache>> = OnceLock::new();
fn codex_index(home: &Path) -> Vec<IndexedSession> {
    let mut cache = CODEX_INDEX
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some((at, previous_home, entries)) = cache.as_ref() {
        if previous_home == home && at.elapsed() < Duration::from_secs(12) {
            return entries.clone();
        }
    }
    let mut files = Vec::new();
    let mut remaining = 2000;
    transcript_files(&home.join("sessions"), 5, &mut remaining, &mut files);
    transcript_files(
        &home.join("archived_sessions"),
        2,
        &mut remaining,
        &mut files,
    );
    files.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
    let entries: Vec<_> = files
        .into_iter()
        .take(600)
        .filter_map(|(_, path)| {
            let file = File::open(&path).ok()?;
            let mut line = String::new();
            BufReader::new(file.take(16384)).read_line(&mut line).ok()?;
            parse_codex_header(&serde_json::from_str::<Value>(&line).ok()?, path)
        })
        .collect();
    *cache = Some((Instant::now(), home.to_path_buf(), entries.clone()));
    entries
}

fn claude_entries(home: &Path, request: &ObserveSession, id: &str) -> Vec<IndexedSession> {
    let projects = home.join("projects");
    let encoded: String = request
        .workdir
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let expected = projects.join(encoded).join(format!("{id}.jsonl"));
    let root_path = if expected.is_file() {
        Some(expected)
    } else {
        fs::read_dir(&projects)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .take(512)
            .map(|entry| entry.path().join(format!("{id}.jsonl")))
            .find(|path| path.is_file())
    };
    let Some(path) = root_path else {
        return Vec::new();
    };
    let subagents = path
        .parent()
        .unwrap_or(&projects)
        .join(id)
        .join("subagents");
    let mut entries = vec![IndexedSession {
        id: id.into(),
        parent_id: None,
        name: None,
        role: None,
        path,
    }];
    if let Ok(children) = fs::read_dir(subagents) {
        for child in children.flatten().take(MAX_AGENTS - 1) {
            let path = child.path();
            if path.extension().is_none_or(|ext| ext != "jsonl") {
                continue;
            }
            let Some(child_id) = path
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.strip_prefix("agent-"))
            else {
                continue;
            };
            entries.push(IndexedSession {
                id: child_id.into(),
                parent_id: Some(id.into()),
                name: None,
                role: None,
                path,
            });
        }
    }
    entries
}

fn descendants(entries: &[IndexedSession], root_id: &str) -> Vec<IndexedSession> {
    let mut included = HashSet::from([root_id.to_string()]);
    let mut selected = entries
        .iter()
        .filter(|entry| entry.id == root_id)
        .cloned()
        .collect::<Vec<_>>();
    loop {
        let mut added = false;
        for entry in entries {
            if selected.len() >= MAX_AGENTS {
                return selected;
            }
            if !included.contains(&entry.id)
                && entry
                    .parent_id
                    .as_ref()
                    .is_some_and(|parent| included.contains(parent))
            {
                included.insert(entry.id.clone());
                selected.push(entry.clone());
                added = true;
            }
        }
        if !added {
            return selected;
        }
    }
}

fn observe(requests: Vec<ObserveSession>) -> Vec<Observation> {
    let codex_home = provider_dir("CODEX_HOME", ".codex");
    let claude_home = provider_dir("CLAUDE_CONFIG_DIR", ".claude");
    let codex = if requests
        .iter()
        .any(|r| r.provider == "codex" && r.provider_session_id.is_some())
    {
        codex_home
            .as_ref()
            .map(|home| codex_index(home))
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let mut reads: HashMap<PathBuf, ObservedAgent> = HashMap::new();
    requests
        .into_iter()
        .take(64)
        .map(|request| {
            let Some(id) = request
                .provider_session_id
                .as_deref()
                .filter(|id| safe_id(id))
            else {
                return Observation {
                    session_id: request.session_id,
                    agents: Vec::new(),
                    available: false,
                    reason: Some("unbound".into()),
                };
            };
            let entries = match request.provider.as_str() {
                "codex" => descendants(&codex, id),
                "claude-code" => claude_home
                    .as_ref()
                    .map(|home| claude_entries(home, &request, id))
                    .unwrap_or_default(),
                _ => Vec::new(),
            };
            let mut agents = Vec::new();
            for entry in entries {
                let agent = reads
                    .get(&entry.path)
                    .cloned()
                    .or_else(|| read_agent(&entry, &request, entry.parent_id.clone()));
                if let Some(mut agent) = agent {
                    agent.session_id = request.session_id.clone();
                    reads.insert(entry.path.clone(), agent.clone());
                    agents.push(agent);
                }
            }
            // Claude links the invocation to the transcript agent ID in toolUseResult.
            // This supplies real names/roles and nested relationships when recorded.
            let delegated: HashMap<_, _> = agents
                .iter()
                .flat_map(|agent| {
                    agent.events.iter().filter_map(|event| {
                        event.delegated_agent_id.as_ref().map(|id| {
                            (
                                id.clone(),
                                (
                                    agent.id.clone(),
                                    limited(&event.detail, 100),
                                    event.delegated_role.clone(),
                                ),
                            )
                        })
                    })
                })
                .collect();
            for agent in &mut agents {
                if let Some((parent_id, name, role)) = delegated.get(&agent.id) {
                    if parent_id != &agent.id {
                        agent.parent_id = Some(parent_id.clone());
                        if !name.is_empty() {
                            agent.name = name.clone();
                        }
                        if role.is_some() {
                            agent.role = role.clone();
                        }
                    }
                }
            }
            let available = !agents.is_empty();
            Observation {
                session_id: request.session_id,
                agents,
                available,
                reason: if available {
                    None
                } else {
                    Some("not_found".into())
                },
            }
        })
        .collect()
}

#[tauri::command]
pub async fn observe_agent_sessions(
    sessions: Vec<ObserveSession>,
) -> Result<Vec<Observation>, String> {
    tauri::async_runtime::spawn_blocking(move || observe(sessions))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn agent() -> ObservedAgent {
        ObservedAgent {
            id: "root".into(),
            session_id: "ui".into(),
            parent_id: None,
            name: "Root".into(),
            role: None,
            provider: "codex".into(),
            task: String::new(),
            last_message: String::new(),
            status: "unknown".into(),
            updated_at: None,
            model: None,
            events: vec![],
            truncated: false,
        }
    }

    #[test]
    fn relationships_come_from_explicit_native_metadata() {
        let root = IndexedSession {
            id: "root".into(),
            parent_id: None,
            name: None,
            role: None,
            path: PathBuf::new(),
        };
        let child = parse_codex_header(&json!({"type":"session_meta","payload":{"id":"child","source":{"subagent":{"thread_spawn":{"parent_thread_id":"root","agent_nickname":"Ada","agent_role":"reviewer"}}}}}), PathBuf::new()).unwrap();
        let grandchild = IndexedSession {
            id: "grandchild".into(),
            parent_id: Some("child".into()),
            ..root.clone()
        };
        let unrelated = IndexedSession {
            id: "unrelated".into(),
            ..root.clone()
        };
        let selected = descendants(&[grandchild, child, unrelated, root], "root");
        assert_eq!(selected.len(), 3);
        assert_eq!(
            selected
                .iter()
                .find(|entry| entry.id == "child")
                .unwrap()
                .name
                .as_deref(),
            Some("Ada")
        );
        assert!(!selected.iter().any(|entry| entry.id == "unrelated"));
    }

    #[test]
    fn codex_tools_are_updated_by_call_id_and_turn_completion() {
        let mut result = agent();
        parse_record(
            &mut result,
            &json!({"type":"response_item","payload":{"type":"function_call","call_id":"a","name":"exec_command","arguments":"{\"cmd\":\"cargo test\"}"}}),
            "codex",
        );
        parse_record(
            &mut result,
            &json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"a","output":"ok"}}),
            "codex",
        );
        parse_record(
            &mut result,
            &json!({"type":"event_msg","payload":{"type":"task_complete"}}),
            "codex",
        );
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].detail, "cargo test");
        assert_eq!(result.events[0].status, "completed");
        assert_eq!(result.status, "done");
    }

    #[test]
    fn claude_separates_visible_text_and_tools_without_reasoning() {
        let mut result = agent();
        parse_record(
            &mut result,
            &json!({"type":"assistant","message":{"model":"sonnet","content":[{"type":"thinking","thinking":"private"},{"type":"text","text":"Reviewing files"},{"type":"tool_use","id":"read","name":"Read","input":{"file_path":"src/main.ts"}}]}}),
            "claude-code",
        );
        parse_record(
            &mut result,
            &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"read","is_error":true,"content":"failure"}]}}),
            "claude-code",
        );
        assert_eq!(result.last_message, "Reviewing files");
        assert_eq!(result.events[0].detail, "src/main.ts");
        assert_eq!(result.events[0].status, "failed");
        assert!(result.task.is_empty());
    }

    #[test]
    fn claude_delegation_uses_native_tool_result_id() {
        let mut result = agent();
        parse_record(
            &mut result,
            &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"delegate","name":"Agent","input":{"description":"Audit authentication","subagent_type":"security-reviewer","prompt":"Check the implementation"}}]}}),
            "claude-code",
        );
        parse_record(
            &mut result,
            &json!({"type":"user","toolUseResult":{"agentId":"child-123"},"message":{"content":[{"type":"tool_result","tool_use_id":"delegate","content":"Done"}]}}),
            "claude-code",
        );
        assert_eq!(
            result.events[0].delegated_agent_id.as_deref(),
            Some("child-123")
        );
        assert_eq!(
            result.events[0].delegated_role.as_deref(),
            Some("security-reviewer")
        );
        assert_eq!(result.events[0].detail, "Audit authentication");
    }

    #[test]
    fn invalid_ids_cannot_escape_provider_directories() {
        assert!(!safe_id("../../secret"));
        assert!(!safe_id("C:\\secret"));
        assert!(!safe_id(""));
        assert!(safe_id("01993cdd-6678-abc"));
    }

    #[test]
    fn history_is_bounded_and_unicode_safe() {
        let mut result = agent();
        for number in 0..100 {
            push_tool(
                &mut result,
                number.to_string(),
                "Read".into(),
                "path".into(),
                None,
            );
        }
        assert_eq!(result.events.len(), MAX_EVENTS);
        assert!(result.truncated);
        assert_eq!(limited("ação 🦀 teste", 6), "ação 🦀…");
    }
}
