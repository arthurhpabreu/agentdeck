//! Normalizes the official CLI JSONL protocols without leaking raw protocol records into chat.
use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEvent {
    pub session_id: String,
    pub turn_id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub delta: bool,
}

pub struct ChatParser {
    session_id: String,
    turn_id: String,
    provider_session_id: Option<String>,
    message_ids: HashMap<String, String>,
    text_blocks: HashMap<String, Vec<(u64, bool)>>,
    tool_blocks: HashMap<(String, u64), ToolInput>,
    sequence: u64,
    pub failed: bool,
    saw_text: bool,
    context_input: u64,
}

struct ToolInput {
    id: Option<String>,
    title: Option<String>,
    json: String,
    depth: usize,
    in_string: bool,
    escaped: bool,
    discarded: bool,
}

impl ToolInput {
    fn append(&mut self, fragment: &str) -> Option<Value> {
        if self.discarded {
            return None;
        }
        if self.json.len() + fragment.len() > 512 * 1024 {
            self.json.clear();
            self.discarded = true;
            return None;
        }
        self.json.push_str(fragment);
        // Scan each byte once and parse only a complete object. Retrying a full
        // JSON parse for every token makes large streamed edits quadratic too.
        for byte in fragment.bytes() {
            if self.in_string {
                if self.escaped {
                    self.escaped = false;
                } else if byte == b'\\' {
                    self.escaped = true;
                } else if byte == b'"' {
                    self.in_string = false;
                }
            } else {
                match byte {
                    b'"' => self.in_string = true,
                    b'{' | b'[' => self.depth += 1,
                    b'}' | b']' => self.depth = self.depth.saturating_sub(1),
                    _ => {}
                }
            }
        }
        if self.depth == 0 && !self.in_string {
            let input = serde_json::from_str::<Value>(&self.json).ok()?;
            self.json.clear();
            self.discarded = true;
            Some(input)
        } else {
            None
        }
    }
}

fn string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

pub fn bounded_text(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[output truncated]", &text[..end])
}

fn content_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return bounded_text(text, 32_768);
    }
    if let Some(blocks) = value.as_array() {
        let texts = blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .map(|text| bounded_text(text, 16_384))
            .collect::<Vec<_>>()
            .join("\n");
        return if texts.is_empty() {
            bounded_text(&value.to_string(), 32_768)
        } else {
            bounded_text(&texts, 32_768)
        };
    }
    if value.is_null() {
        return String::new();
    }
    bounded_text(&value.to_string(), 32_768)
}

fn output_text(value: &Value) -> String {
    let text = if let Some(text) = value.as_str() {
        text.to_owned()
    } else if let Some(blocks) = value.as_array() {
        let text = blocks
            .iter()
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if text.is_empty() {
            value.to_string()
        } else {
            text
        }
    } else if value.is_null() {
        String::new()
    } else {
        value.to_string()
    };
    // Keep the latest output: test results and command failures usually come last.
    if text.len() <= 32_768 {
        return text;
    }
    let mut start = text.len() - 32_768;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("[earlier output omitted]\n{}", &text[start..])
}

impl ChatParser {
    pub fn new(session_id: String, turn_id: String) -> Self {
        Self {
            session_id,
            turn_id,
            provider_session_id: None,
            message_ids: HashMap::new(),
            text_blocks: HashMap::new(),
            tool_blocks: HashMap::new(),
            sequence: 0,
            failed: false,
            saw_text: false,
            context_input: 0,
        }
    }

    pub fn event(&self, kind: &str) -> ChatEvent {
        ChatEvent {
            session_id: self.session_id.clone(),
            turn_id: self.turn_id.clone(),
            kind: kind.to_owned(),
            ..Default::default()
        }
    }

    pub fn message(&self, kind: &str, text: &str) -> ChatEvent {
        let mut event = self.event(kind);
        event.text = Some(bounded_text(text, 65_536));
        event
    }

    fn permission_required(&self) -> ChatEvent {
        let mut event = self.message(
            "tool",
            "Some tools need permission. Continue in the native terminal to approve them.",
        );
        event.item_id = Some("permission-required".into());
        event.title = Some("Permission required".into());
        event.status = Some("blocked".into());
        event
    }

    fn tool_input(&self, id: Option<String>, title: Option<String>, input: &Value) -> ChatEvent {
        let mut event = self.event("tool");
        event.item_id = id;
        event.title = title;
        event.status = Some("running".into());
        event.command = string(input, "command")
            .or_else(|| string(input, "cmd"))
            .map(|text| bounded_text(&text, 32_768));
        event.cwd = string(input, "cwd").or_else(|| string(input, "workdir"));
        if event.command.is_none() && !input.is_null() && input != &serde_json::json!({}) {
            event.text = Some(content_text(input));
        }
        event
    }

    fn bind(&mut self, id: Option<String>, events: &mut Vec<ChatEvent>) {
        if let Some(id) = id.filter(|id| !id.is_empty()) {
            if self.provider_session_id.as_ref() != Some(&id) {
                self.provider_session_id = Some(id.clone());
                let mut event = self.event("session");
                event.provider_session_id = Some(id);
                events.push(event);
            }
        }
    }

    pub fn parse(&mut self, provider: &str, line: &str) -> Vec<ChatEvent> {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            // A CLI version mismatch or authentication error must never leave an empty panel.
            return if line.trim().is_empty() {
                Vec::new()
            } else {
                vec![self.message("status", line)]
            };
        };
        if provider == "codex" {
            self.codex(&record)
        } else {
            self.claude(&record)
        }
    }

    fn codex(&mut self, record: &Value) -> Vec<ChatEvent> {
        let mut events = Vec::new();
        match record["type"].as_str().unwrap_or("") {
            "context_compacted" => {
                let mut event = self.event("compaction");
                event.item_id = Some(format!(
                    "{}:{}",
                    self.turn_id,
                    record["id"].as_str().unwrap_or("automatic")
                ));
                event.status = Some(
                    if record["before_turn"] == true {
                        "before-turn"
                    } else {
                        "automatic"
                    }
                    .into(),
                );
                events.push(event);
            }
            "agentdeck.model" => {
                let mut event = self.event("status");
                event.model = string(record, "model");
                events.push(event);
            }
            "thread.started" => self.bind(string(record, "thread_id"), &mut events),
            "turn.started" => {
                let mut event = self.event("status");
                event.status = Some("running".into());
                events.push(event);
            }
            "item.started" | "item.updated" | "item.completed" => {
                let item = &record["item"];
                let item_type = item["type"].as_str().unwrap_or("activity");
                let completed = record["type"] == "item.completed";
                let mut event = self.event(if item_type == "agent_message" {
                    "text"
                } else if item_type == "reasoning" {
                    "status"
                } else {
                    "tool"
                });
                event.item_id = string(item, "id");
                event.delta = record["delta"] == true;
                event.parent_id =
                    string(item, "parent_tool_call_id").or_else(|| string(item, "parent_id"));
                event.status = Some(
                    match item["status"].as_str() {
                        Some("failed" | "errored") => "failed",
                        Some("declined") => "blocked",
                        _ if item_type == "command_execution"
                            && item["exit_code"].as_i64().is_some_and(|code| code != 0) =>
                        {
                            "failed"
                        }
                        _ if completed => "completed",
                        _ => "running",
                    }
                    .into(),
                );
                if item_type == "agent_message" {
                    event.text = string(item, "text");
                    self.saw_text |= event.text.as_ref().is_some_and(|text| !text.is_empty());
                } else if item_type == "reasoning" {
                    event.status = Some("reasoning".into());
                    event.text = Some("Thinking…".into());
                } else {
                    event.title = Some(match item_type {
                        "command_execution" => "Terminal".into(),
                        "file_change" => "Files".into(),
                        "web_search" => "Web search".into(),
                        "todo_list" => "Plan".into(),
                        "mcp_tool_call" => format!(
                            "{} · {}",
                            item["server"].as_str().unwrap_or("MCP"),
                            item["tool"].as_str().unwrap_or("tool")
                        ),
                        "collab_agent_tool_call" => format!(
                            "Agent · {}",
                            item["tool"].as_str().unwrap_or("collaboration")
                        ),
                        _ => item_type.replace('_', " "),
                    });
                    let detail = match item_type {
                        "command_execution" => {
                            event.command =
                                string(item, "command").map(|text| bounded_text(&text, 32_768));
                            event.output = item
                                .get("aggregated_output")
                                .filter(|value| value.is_string())
                                .map(output_text);
                            event.cwd = string(item, "cwd");
                            event.exit_code = item["exit_code"].as_i64();
                            String::new()
                        }
                        "web_search" => item["query"].as_str().unwrap_or("").to_owned(),
                        "file_change" => content_text(&item["changes"]),
                        "todo_list" => content_text(&item["items"]),
                        _ => content_text(item),
                    };
                    if item_type != "command_execution" {
                        event.text = Some(bounded_text(&detail, 32_768));
                    }
                }
                events.push(event);
            }
            "turn.completed" | "usage.updated" => {
                let mut event = self.event("status");
                event.usage = record.get("usage").cloned();
                event.context_tokens = record["context_tokens"].as_u64();
                event.status = Some(
                    if record["type"] == "usage.updated" {
                        "running"
                    } else {
                        "finishing"
                    }
                    .into(),
                );
                events.push(event);
            }
            "turn.failed" | "error" => {
                self.failed = true;
                let text = record["error"]["message"]
                    .as_str()
                    .or_else(|| record["message"].as_str())
                    .unwrap_or("Codex could not complete this turn.");
                events.push(self.message("error", text));
            }
            _ => {}
        }
        events
    }

    fn claude(&mut self, record: &Value) -> Vec<ChatEvent> {
        if record["type"] == "context_compacted" {
            return self.codex(record);
        }
        let mut events = Vec::new();
        self.bind(string(record, "session_id"), &mut events);
        let parent = string(record, "parent_tool_use_id");
        if parent.is_none() {
            if record["type"] == "system" && record["subtype"] == "compact_boundary" {
                let mut event = self.event("compaction");
                event.item_id = Some(format!(
                    "{}:{}",
                    self.turn_id,
                    record["uuid"].as_str().unwrap_or("automatic")
                ));
                event.status = Some("automatic".into());
                events.push(event);
            }
            let usage = match record["type"].as_str() {
                Some("assistant") => Some(&record["message"]["usage"]),
                Some("stream_event") if record["event"]["type"] == "message_start" => {
                    Some(&record["event"]["message"]["usage"])
                }
                Some("stream_event") if record["event"]["type"] == "message_delta" => {
                    Some(&record["event"]["usage"])
                }
                _ => None,
            };
            if let Some(usage) =
                usage.filter(|u| u["input_tokens"].is_u64() || u["output_tokens"].is_u64())
            {
                if let Some(input) = usage["input_tokens"].as_u64() {
                    self.context_input = input
                        + usage["cache_read_input_tokens"].as_u64().unwrap_or(0)
                        + usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                }
                let mut event = self.event("status");
                event.status = Some("running".into());
                event.context_tokens =
                    Some(self.context_input + usage["output_tokens"].as_u64().unwrap_or(0));
                events.push(event);
            }
        }
        if parent.is_none() {
            let model = match record["type"].as_str() {
                Some("system") if record["subtype"] == "init" => string(record, "model"),
                Some("assistant") => string(&record["message"], "model"),
                Some("stream_event") if record["event"]["type"] == "message_start" => {
                    string(&record["event"]["message"], "model")
                }
                _ => None,
            };
            if let Some(model) =
                model.filter(|value| value.len() <= 200 && !value.chars().any(char::is_control))
            {
                let mut event = self.event("status");
                event.model = Some(model);
                events.push(event);
            }
        }
        let stream_key = parent.as_deref().unwrap_or("main").to_owned();
        match record["type"].as_str().unwrap_or("") {
            "tool_progress" => {
                let mut event = self.event("tool");
                event.item_id = string(record, "tool_use_id");
                event.title = string(record, "tool_name");
                event.parent_id = parent;
                event.status = Some("running".into());
                event.elapsed_seconds = record["elapsed_time_seconds"]
                    .as_f64()
                    .filter(|value| value.is_finite() && *value >= 0.0);
                events.push(event);
            }
            "tool_use_summary" => {
                if let Some(summary) =
                    string(record, "summary").filter(|text| !text.trim().is_empty())
                {
                    let mut event = self.message("status", &summary);
                    event.status = Some("running".into());
                    event.parent_id = parent;
                    events.push(event);
                }
            }
            "system" => {
                let subtype = record["subtype"].as_str().unwrap_or("");
                let mut event = self.event("status");
                event.status = Some("running".into());
                event.text = match subtype {
                    "init" => Some(format!(
                        "Claude Code · {}",
                        record["model"].as_str().unwrap_or("connected")
                    )),
                    "api_retry" => Some(format!(
                        "Retrying connection ({})…",
                        record["attempt"].as_u64().unwrap_or(1)
                    )),
                    "permission_denied" => {
                        events.push(self.permission_required());
                        event.status = Some("blocked".into());
                        Some("Permission required. Continue in the native terminal to approve this action.".into())
                    }
                    _ => string(record, "message"),
                };
                if event.text.is_some() {
                    events.push(event);
                }
            }
            "stream_event" => {
                let raw = &record["event"];
                let index = raw["index"].as_u64().unwrap_or(0);
                match raw["type"].as_str().unwrap_or("") {
                    "message_start" => {
                        self.sequence += 1;
                        let id = string(&raw["message"], "id")
                            .unwrap_or_else(|| format!("message-{}", self.sequence));
                        self.tool_blocks.retain(|(key, _), _| key != &stream_key);
                        self.message_ids.insert(stream_key, id);
                    }
                    "content_block_delta" if raw["delta"]["type"] == "text_delta" => {
                        let id = self
                            .message_ids
                            .get(&stream_key)
                            .cloned()
                            .unwrap_or_else(|| format!("message-{}", self.sequence));
                        let blocks = self.text_blocks.entry(id.clone()).or_default();
                        if !blocks.iter().any(|(block_index, _)| *block_index == index) {
                            blocks.push((index, false));
                        }
                        let mut event = self.event("text");
                        event.item_id = Some(format!("{id}:{index}"));
                        event.text = string(&raw["delta"], "text");
                        event.parent_id = parent;
                        event.delta = true;
                        self.saw_text |= event.text.as_ref().is_some_and(|text| !text.is_empty());
                        events.push(event);
                    }
                    "content_block_start" if raw["content_block"]["type"] == "tool_use" => {
                        let block = &raw["content_block"];
                        let id = string(block, "id");
                        let title = string(block, "name");
                        self.tool_blocks.insert(
                            (stream_key, index),
                            ToolInput {
                                id: id.clone(),
                                title: title.clone(),
                                json: String::new(),
                                depth: 0,
                                in_string: false,
                                escaped: false,
                                discarded: false,
                            },
                        );
                        let mut event = self.tool_input(id, title, &block["input"]);
                        event.parent_id = parent;
                        events.push(event);
                    }
                    "content_block_delta" if raw["delta"]["type"] == "input_json_delta" => {
                        if let Some(tool) = self.tool_blocks.get_mut(&(stream_key, index)) {
                            // Tool arguments stream as JSON fragments. Never display a partial
                            // protocol record, and bound retained input for long editing tasks.
                            if let Some(fragment) = raw["delta"]["partial_json"].as_str() {
                                if let Some(input) = tool.append(fragment) {
                                    let id = tool.id.clone();
                                    let title = tool.title.clone();
                                    let mut event = self.tool_input(id, title, &input);
                                    event.parent_id = parent;
                                    events.push(event);
                                }
                            }
                        }
                    }
                    "content_block_stop" => {
                        self.tool_blocks.remove(&(stream_key, index));
                    }
                    "content_block_start" if raw["content_block"]["type"] == "thinking" => {
                        let mut event = self.event("status");
                        event.status = Some("reasoning".into());
                        events.push(event);
                    }
                    "content_block_delta" if raw["delta"]["type"] == "thinking_delta" => {
                        let mut event = self.event("status");
                        event.status = Some("reasoning".into());
                        events.push(event);
                    }
                    _ => {}
                }
            }
            "assistant" | "user" => {
                let message = &record["message"];
                let message_id = string(message, "id")
                    .or_else(|| self.message_ids.get(&stream_key).cloned())
                    .unwrap_or_else(|| {
                        self.sequence += 1;
                        format!("message-{}", self.sequence)
                    });
                if let Some(blocks) = message["content"].as_array() {
                    for (index, block) in blocks.iter().enumerate() {
                        let kind = block["type"].as_str().unwrap_or("");
                        let mut event = match kind {
                            "text" if record["type"] == "assistant" => {
                                let mut event = self.event("text");
                                // Claude can emit one complete assistant record per block. Its
                                // content array then starts at zero even when the stream index
                                // follows a thinking/tool block. Keep the original stream identity.
                                let stream_index = self
                                    .text_blocks
                                    .get_mut(&message_id)
                                    .and_then(|blocks| {
                                        blocks.iter_mut().find(|(_, finalized)| !*finalized)
                                    })
                                    .map(|(block_index, finalized)| {
                                        *finalized = true;
                                        *block_index as usize
                                    })
                                    .unwrap_or(index);
                                event.item_id = Some(format!("{message_id}:{stream_index}"));
                                event.text = string(block, "text");
                                self.saw_text |=
                                    event.text.as_ref().is_some_and(|text| !text.is_empty());
                                event
                            }
                            "tool_use" => self.tool_input(
                                string(block, "id"),
                                string(block, "name"),
                                &block["input"],
                            ),
                            "tool_result" => {
                                let mut event = self.event("tool");
                                event.item_id = string(block, "tool_use_id");
                                event.output = Some(output_text(&block["content"]));
                                event.exit_code = block["exit_code"]
                                    .as_i64()
                                    .or_else(|| record["tool_use_result"]["exit_code"].as_i64());
                                event.status = Some(
                                    if block["is_error"] == true {
                                        "failed"
                                    } else {
                                        "completed"
                                    }
                                    .into(),
                                );
                                event
                            }
                            _ => continue,
                        };
                        event.parent_id = parent.clone();
                        events.push(event);
                    }
                }
            }
            "result" => {
                let is_error = record["is_error"].as_bool().unwrap_or(false);
                if is_error {
                    self.failed = true;
                    let text = string(record, "result")
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| content_text(&record["errors"]));
                    events.push(self.message(
                        "error",
                        if text.is_empty() {
                            "Claude Code could not complete this turn."
                        } else {
                            &text
                        },
                    ));
                } else if !self.saw_text {
                    if let Some(text) = string(record, "result").filter(|text| !text.is_empty()) {
                        let mut event = self.message("text", &text);
                        event.item_id = Some("result".into());
                        events.push(event);
                    }
                }
                if record["permission_denials"]
                    .as_array()
                    .is_some_and(|items| !items.is_empty())
                {
                    events.push(self.permission_required());
                    let mut event = self.message("status", "Some tools need permission. Continue in the native terminal to approve them.");
                    event.status = Some("blocked".into());
                    events.push(event);
                }
                let mut event = self.event("status");
                event.status = Some("finishing".into());
                event.usage = record.get("usage").cloned();
                events.push(event);
            }
            _ => {}
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reasoning_is_not_an_accumulating_diagnostic() {
        let mut parser = parser();
        let events = parser.parse(
            "codex",
            r#"{"type":"item.updated","item":{"id":"r","type":"reasoning"}}"#,
        );
        assert_eq!(events[0].status.as_deref(), Some("reasoning"));
    }
    #[test]
    fn context_tokens_are_latest_model_context_not_accumulated_billing() {
        let mut parser = parser();
        let events=parser.parse("codex",r#"{"type":"turn.completed","usage":{"input_tokens":900000,"output_tokens":200000},"context_tokens":12000}"#);
        assert_eq!(events[0].context_tokens, Some(12000));
        let events=parser.parse("claude-code",r#"{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":1000,"cache_creation_input_tokens":20}}}}"#);
        assert_eq!(events[0].context_tokens, Some(1120));
        let events=parser.parse("claude-code",r#"{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":200}}}"#);
        assert_eq!(events[0].context_tokens, Some(1320));
        let events=parser.parse("claude-code",r#"{"type":"assistant","parent_tool_use_id":"child","message":{"usage":{"input_tokens":99999,"output_tokens":99999},"content":[]}}"#);
        assert!(events.iter().all(|e| e.context_tokens.is_none()));
    }
    #[test]
    fn main_model_identity_is_reported_without_subagent_override() {
        let mut parser = ChatParser::new("s".into(), "t".into());
        let events = parser.parse(
            "claude-code",
            r#"{"type":"system","subtype":"init","model":"claude-opus-5-5"}"#,
        );
        assert!(events
            .iter()
            .any(|event| event.model.as_deref() == Some("claude-opus-5-5")));
        let events = parser.parse("claude-code", r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"main","model":"claude-sonnet-5-5"}}}"#);
        assert!(events
            .iter()
            .any(|event| event.model.as_deref() == Some("claude-sonnet-5-5")));
        let events = parser.parse("claude-code", r#"{"type":"assistant","parent_tool_use_id":"child","message":{"model":"claude-haiku-4-5","content":[]}}"#);
        assert!(events.iter().all(|event| event.model.is_none()));
    }

    fn parser() -> ChatParser {
        ChatParser::new("session".into(), "turn".into())
    }

    #[test]
    fn codex_session_and_message_are_normalized() {
        let mut parser = parser();
        let events = parser.parse(
            "codex",
            r#"{"type":"thread.started","thread_id":"native-id"}"#,
        );
        assert_eq!(events[0].provider_session_id.as_deref(), Some("native-id"));
        let events = parser.parse(
            "codex",
            r#"{"type":"item.completed","item":{"id":"a","type":"agent_message","text":"Olá"}}"#,
        );
        assert_eq!(events[0].text.as_deref(), Some("Olá"));
        assert!(!events[0].delta);
        assert_eq!(events[0].item_id.as_deref(), Some("a"));
    }

    #[test]
    fn claude_partial_and_complete_share_identity() {
        let mut parser = parser();
        parser.parse(
            "claude-code",
            r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}"#,
        );
        let partial = parser.parse("claude-code", r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Ol"}}}"#);
        let complete = parser.parse("claude-code", r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Olá"}]}}"#);
        assert_eq!(partial[0].item_id, complete[0].item_id);
        assert!(partial[0].delta);
        assert!(!complete[0].delta);
        let result = parser.parse(
            "claude-code",
            r#"{"type":"result","result":"Olá","is_error":false}"#,
        );
        assert!(result.iter().all(|event| event.kind != "text"));
    }

    #[test]
    fn subagent_streams_keep_their_parent_and_do_not_overwrite_main() {
        let mut parser = parser();
        parser.parse(
            "claude-code",
            r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"main"}}}"#,
        );
        parser.parse("claude-code", r#"{"type":"stream_event","parent_tool_use_id":"agent1","event":{"type":"message_start","message":{"id":"sub"}}}"#);
        let sub = parser.parse("claude-code", r#"{"type":"stream_event","parent_tool_use_id":"agent1","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Sub"}}}"#);
        let main = parser.parse("claude-code", r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Main"}}}"#);
        assert_eq!(sub[0].item_id.as_deref(), Some("sub:0"));
        assert_eq!(sub[0].parent_id.as_deref(), Some("agent1"));
        assert_eq!(main[0].item_id.as_deref(), Some("main:0"));
    }

    #[test]
    fn claude_final_block_keeps_stream_index_after_thinking() {
        let mut parser = parser();
        parser.parse(
            "claude-code",
            r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}"#,
        );
        let partial = parser.parse("claude-code", r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"AGENT"}}}"#);
        let complete = parser.parse("claude-code", r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"AGENTDECK_OK"}]}}"#);
        assert_eq!(partial[0].item_id.as_deref(), Some("m1:1"));
        assert_eq!(partial[0].item_id, complete[0].item_id);
    }

    #[test]
    fn tool_results_update_the_original_tool_and_errors_remain_visible() {
        let mut parser = parser();
        let events = parser.parse("claude-code", r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","is_error":true,"content":"denied"}]}}"#);
        assert_eq!(events[0].item_id.as_deref(), Some("tool1"));
        assert_eq!(events[0].status.as_deref(), Some("failed"));
        assert_eq!(events[0].output.as_deref(), Some("denied"));
        let events = parser.parse(
            "codex",
            r#"{"type":"turn.failed","error":{"message":"Authentication required"}}"#,
        );
        assert_eq!(events[0].text.as_deref(), Some("Authentication required"));
        assert!(parser.failed);
    }

    #[test]
    fn claude_streams_tool_command_without_replacing_it_with_output() {
        let mut parser = parser();
        let start = parser.parse("claude-code", r#"{"type":"stream_event","event":{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"bash1","name":"Bash","input":{}}}}"#);
        assert_eq!(start[0].item_id.as_deref(), Some("bash1"));
        assert!(start[0].command.is_none());
        let partial = parser.parse("claude-code", r#"{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"cargo "}}}"#);
        assert!(partial.is_empty());
        let ready = parser.parse("claude-code", r#"{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"test\",\"cwd\":\"/project\"}"}}}"#);
        assert_eq!(ready[0].item_id.as_deref(), Some("bash1"));
        assert_eq!(ready[0].command.as_deref(), Some("cargo test"));
        assert_eq!(ready[0].cwd.as_deref(), Some("/project"));
        assert!(ready[0].output.is_none());
        let result = parser.parse("claude-code", r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"bash1","content":"tests passed"}]}}"#);
        assert_eq!(result[0].output.as_deref(), Some("tests passed"));
        assert!(result[0].command.is_none());
        assert!(result[0].text.is_none());
    }

    #[test]
    fn claude_parallel_tool_inputs_keep_distinct_parent_identity() {
        let mut parser = parser();
        for (parent, id) in [(None, "main-tool"), (Some("agent"), "child-tool")] {
            parser.parse("claude-code", &serde_json::json!({"type":"stream_event","parent_tool_use_id":parent,"event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":id,"name":"Bash"}}}).to_string());
        }
        let child = parser.parse("claude-code", r#"{"type":"stream_event","parent_tool_use_id":"agent","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"pwd\"}"}}}"#);
        let main = parser.parse("claude-code", r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"git status\"}"}}}"#);
        assert_eq!(child[0].item_id.as_deref(), Some("child-tool"));
        assert_eq!(child[0].parent_id.as_deref(), Some("agent"));
        assert_eq!(main[0].item_id.as_deref(), Some("main-tool"));
        assert_eq!(main[0].command.as_deref(), Some("git status"));
    }

    #[test]
    fn streamed_tool_json_handles_fragmented_escapes_and_nested_input() {
        let mut parser = parser();
        parser.parse("claude-code", r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"bash1","name":"Bash"}}}"#);
        let command = "echo \"}\"; path C:\\project\\test";
        let json = serde_json::json!({"command":command,"extra":{"values":["}","á"]}}).to_string();
        let mut events = Vec::new();
        for character in json.chars() {
            events.extend(parser.parse("claude-code", &serde_json::json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":character.to_string()}}}).to_string()));
        }
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].command.as_deref(), Some(command));
        assert!(parser
            .tool_blocks
            .get(&("main".into(), 0))
            .unwrap()
            .json
            .is_empty());
    }

    #[test]
    fn claude_tool_progress_updates_original_tool_without_displacing_command() {
        let mut parser = parser();
        let progress = parser.parse("claude-code", r#"{"type":"tool_progress","tool_use_id":"bash1","tool_name":"Bash","parent_tool_use_id":"agent1","elapsed_time_seconds":25}"#);
        assert_eq!(progress[0].item_id.as_deref(), Some("bash1"));
        assert_eq!(progress[0].parent_id.as_deref(), Some("agent1"));
        assert_eq!(progress[0].status.as_deref(), Some("running"));
        assert_eq!(progress[0].elapsed_seconds, Some(25.0));
        assert!(progress[0].text.is_none());
        assert!(progress[0].command.is_none());
        assert!(progress[0].output.is_none());
        let summary = parser.parse("claude-code", r#"{"type":"tool_use_summary","summary":"Checked the project files","preceding_tool_use_ids":["bash1"]}"#);
        assert_eq!(
            summary[0].text.as_deref(),
            Some("Checked the project files")
        );
    }

    #[test]
    fn codex_output_deltas_and_exit_code_have_separate_fields() {
        let mut parser = parser();
        let start = parser.parse("codex", r#"{"type":"item.started","item":{"id":"cmd","type":"command_execution","command":"cargo test","cwd":"/project"}}"#);
        assert_eq!(start[0].command.as_deref(), Some("cargo test"));
        let delta = parser.parse("codex", r#"{"type":"item.updated","delta":true,"item":{"id":"cmd","type":"command_execution","aggregated_output":"running tests\n"}}"#);
        assert!(delta[0].delta);
        assert_eq!(delta[0].output.as_deref(), Some("running tests\n"));
        assert!(delta[0].command.is_none());
        let end = parser.parse("codex", r#"{"type":"item.completed","item":{"id":"cmd","type":"command_execution","command":"cargo test","aggregated_output":"tests passed","exit_code":0}}"#);
        assert!(!end[0].delta);
        assert_eq!(end[0].command.as_deref(), Some("cargo test"));
        assert_eq!(end[0].output.as_deref(), Some("tests passed"));
        assert_eq!(serde_json::to_value(&end[0]).unwrap()["exitCode"], 0);
        let failed = parser.parse("codex", r#"{"type":"item.completed","item":{"id":"cmd2","type":"command_execution","exit_code":1}}"#);
        assert_eq!(failed[0].status.as_deref(), Some("failed"));
    }

    #[test]
    fn large_terminal_results_keep_latest_lines_and_unicode_boundaries() {
        let text = format!("{}\nFINAL ERROR", "á".repeat(20_000));
        let output = output_text(&Value::String(text));
        assert!(output.starts_with("[earlier output omitted]\n"));
        assert!(output.ends_with("FINAL ERROR"));
        assert!(output.len() <= 32_768 + "[earlier output omitted]\n".len());
    }

    #[test]
    fn codex_usage_update_does_not_pretend_the_turn_finished() {
        let mut parser = parser();
        let event = parser.parse(
            "codex",
            r#"{"type":"usage.updated","usage":{"input_tokens":100},"context_tokens":120}"#,
        );
        assert_eq!(event[0].status.as_deref(), Some("running"));
        assert_eq!(event[0].context_tokens, Some(120));
    }

    #[test]
    fn file_changes_and_permission_denials_remain_visible() {
        let mut parser = parser();
        let events = parser.parse("codex", r#"{"type":"item.completed","item":{"id":"a","type":"file_change","changes":[{"path":"src/app.ts","kind":"update"}]}}"#);
        assert!(events[0].text.as_ref().unwrap().contains("src/app.ts"));
        let events = parser.parse(
            "claude-code",
            r#"{"type":"result","is_error":false,"permission_denials":[{"tool_name":"Bash"}]}"#,
        );
        assert!(events
            .iter()
            .any(|event| event.status.as_deref() == Some("blocked")
                && event.text.as_ref().unwrap().contains("native terminal")));
    }

    #[test]
    fn invalid_protocol_and_unicode_truncation_are_safe() {
        let events = parser().parse("codex", "Please log in");
        assert_eq!(events[0].kind, "status");
        assert_eq!(bounded_text("ééé", 3), "é\n[output truncated]");
    }
}
