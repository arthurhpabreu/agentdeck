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
    sequence: u64,
    pub failed: bool,
    saw_text: bool,
    context_input: u64,
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

impl ChatParser {
    pub fn new(session_id: String, turn_id: String) -> Self {
        Self {
            session_id,
            turn_id,
            provider_session_id: None,
            message_ids: HashMap::new(),
            text_blocks: HashMap::new(),
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
                event.parent_id =
                    string(item, "parent_tool_call_id").or_else(|| string(item, "parent_id"));
                event.status = Some(
                    match item["status"].as_str() {
                        Some("failed" | "errored") => "failed",
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
                        "command_execution" => format!(
                            "{}{}{}",
                            item["command"].as_str().unwrap_or(""),
                            if item["aggregated_output"]
                                .as_str()
                                .is_some_and(|s| !s.is_empty())
                            {
                                "\n"
                            } else {
                                ""
                            },
                            item["aggregated_output"].as_str().unwrap_or("")
                        ),
                        "web_search" => item["query"].as_str().unwrap_or("").to_owned(),
                        "file_change" => content_text(&item["changes"]),
                        "todo_list" => content_text(&item["items"]),
                        _ => content_text(item),
                    };
                    event.text = Some(bounded_text(&detail, 32_768));
                }
                events.push(event);
            }
            "turn.completed" => {
                let mut event = self.event("status");
                event.usage = record.get("usage").cloned();
                event.context_tokens = record["context_tokens"].as_u64();
                event.status = Some("finishing".into());
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
                        let mut event = self.event("tool");
                        event.item_id = string(block, "id");
                        event.title = string(block, "name");
                        event.parent_id = parent;
                        event.status = Some("running".into());
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
                            "tool_use" => {
                                let mut event = self.event("tool");
                                event.item_id = string(block, "id");
                                event.title = string(block, "name");
                                event.text = Some(content_text(&block["input"]));
                                event.status = Some("running".into());
                                event
                            }
                            "tool_result" => {
                                let mut event = self.event("tool");
                                event.item_id = string(block, "tool_use_id");
                                event.text = Some(content_text(&block["content"]));
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
        let events = parser.parse(
            "codex",
            r#"{"type":"turn.failed","error":{"message":"Authentication required"}}"#,
        );
        assert_eq!(events[0].text.as_deref(), Some("Authentication required"));
        assert!(parser.failed);
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
