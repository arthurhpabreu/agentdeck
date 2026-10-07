//! Native live input: Codex App Server turn/steer and Claude streaming stdin.
use super::{build_input, ChatTurnRequest};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::Write,
    process::ChildStdin,
};

#[derive(Clone)]
struct Message {
    id: String,
    input: Value,
}
pub(super) struct LiveInput {
    writer: Option<Box<dyn Write + Send>>,
    codex: bool,
    thread: Option<String>,
    turn: Option<String>,
    sequence: u64,
    queued: VecDeque<Message>,
    pending: HashMap<u64, Message>,
    claude_pending: usize,
    started: bool,
}
impl LiveInput {
    pub fn new(stdin: ChildStdin, codex: bool) -> Self {
        Self::with_writer(Box::new(stdin), codex)
    }
    fn with_writer(writer: Box<dyn Write + Send>, codex: bool) -> Self {
        Self {
            writer: Some(writer),
            codex,
            thread: None,
            turn: None,
            sequence: 100,
            queued: VecDeque::new(),
            pending: HashMap::new(),
            claude_pending: 1,
            started: false,
        }
    }
    pub fn write_text(&mut self, text: &str) -> Result<(), String> {
        let writer = self
            .writer
            .as_mut()
            .ok_or("This response has already ended")?;
        writer
            .write_all(text.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|e| e.to_string())
    }
    fn write(&mut self, value: Value) -> Result<(), String> {
        self.write_text(&(value.to_string() + "\n"))
    }
    pub fn initialize(&mut self) -> Result<(), String> {
        self.write(json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"agentdeck","version":env!("CARGO_PKG_VERSION")}}}))
    }
    pub fn submit(&mut self, request: &ChatTurnRequest, id: &str) -> Result<&'static str, String> {
        if self.writer.is_none() {
            return Err("This response has already ended".into());
        }
        if self.queued.len() + self.pending.len() + self.claude_pending > 24 {
            return Err("Too many additional messages in flight".into());
        }
        if !self.codex {
            let mut input: Value =
                serde_json::from_str(&build_input(request)?).map_err(|e| e.to_string())?;
            input["uuid"] = json!(id);
            self.write(input)?;
            self.claude_pending += 1;
            return Ok("queued");
        }
        let message = Message {
            id: id.into(),
            input: codex_input(request)?,
        };
        if let (Some(thread), Some(turn)) = (self.thread.clone(), self.turn.clone()) {
            self.sequence += 1;
            let rpc = self.sequence;
            self.write(json!({"id":rpc,"method":"turn/steer","params":{"threadId":thread,"expectedTurnId":turn,"input":message.input}}))?;
            self.pending.insert(rpc, message);
            Ok("sending")
        } else {
            self.queued.push_back(message);
            Ok("queued")
        }
    }
    fn start_queued(&mut self) -> Result<(), String> {
        if self.turn.is_some() || !self.pending.is_empty() {
            return Ok(());
        }
        if let Some(message) = self.queued.pop_front() {
            self.sequence += 1;
            let rpc = self.sequence;
            self.write(json!({"id":rpc,"method":"turn/start","params":{"threadId":self.thread,"input":message.input}}))?;
            self.pending.insert(rpc, message);
        } else if self.started {
            self.writer.take();
        }
        Ok(())
    }
}
pub(super) fn codex_input(request: &ChatTurnRequest) -> Result<Value, String> {
    let mut input = vec![json!({"type":"text","text":build_input(request)?})];
    for file in request
        .attachments
        .iter()
        .filter(|f| f.mime_type.starts_with("image/"))
    {
        input.push(json!({"type":"localImage","path":file.path}));
    }
    Ok(Value::Array(input))
}
pub(super) struct LiveProtocol {
    request: ChatTurnRequest,
    text: HashMap<String, String>,
    usage: Value,
    totals: Value,
    claude_totals: Value,
    claude_results: std::collections::HashSet<String>,
}
impl LiveProtocol {
    pub fn new(request: &ChatTurnRequest) -> Self {
        Self {
            request: request.clone(),
            text: HashMap::new(),
            usage: json!({}),
            totals: json!({}),
            claude_totals: json!({}),
            claude_results: Default::default(),
        }
    }
    pub fn ingest(&mut self, line: &str, input: &mut LiveInput) -> Vec<String> {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            return vec![line.into()];
        };
        let mut out = vec![];
        let result = if input.codex {
            self.codex(&record, input, &mut out)
        } else {
            self.claude(record, input, &mut out)
        };
        if let Err(error) = result {
            out.push(json!({"type":"error","message":error}));
            input.writer.take();
        }
        out.into_iter().map(|v| v.to_string()).collect()
    }
    fn claude(
        &mut self,
        mut record: Value,
        input: &mut LiveInput,
        out: &mut Vec<Value>,
    ) -> Result<(), String> {
        if record["type"] == "result" && record["parent_tool_use_id"].is_null() {
            let id = record["uuid"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| record.to_string());
            if self.claude_results.insert(id) {
                for key in [
                    "input_tokens",
                    "output_tokens",
                    "cache_read_input_tokens",
                    "cache_creation_input_tokens",
                ] {
                    self.claude_totals[key] = json!(
                        self.claude_totals[key].as_u64().unwrap_or(0)
                            + record["usage"][key].as_u64().unwrap_or(0)
                    );
                }
                input.claude_pending = input.claude_pending.saturating_sub(1);
                if input.claude_pending == 0 {
                    input.writer.take();
                }
            }
            record["usage"] = self.claude_totals.clone();
        }
        if record["type"] == "user" {
            if let Some(id) = record["uuid"].as_str() {
                out.push(json!({"type":"agentdeck.input","message_id":id,"status":"accepted"}));
            }
        }
        out.push(record);
        Ok(())
    }
    fn codex(
        &mut self,
        record: &Value,
        input: &mut LiveInput,
        out: &mut Vec<Value>,
    ) -> Result<(), String> {
        if let Some(id) = record["id"]
            .as_u64()
            .filter(|_| record.get("method").is_none())
        {
            if id == 1 {
                if !record["error"].is_null() {
                    return Err(error_message(record));
                }
                input.write(json!({"method":"initialized"}))?;
                let mut params = json!({"cwd":self.request.workdir});
                // Apply the chosen permissions to resumed threads as well as new ones.
                if self.request.mode.as_deref() == Some("plan") {
                    params["sandbox"] = json!("read-only");
                } else if self.request.full_access {
                    params["sandbox"] = json!("danger-full-access");
                    params["approvalPolicy"] = json!("never");
                }
                if let Some(model) = &self.request.model {
                    params["model"] = json!(model);
                }
                if let Some(thread) = &self.request.provider_session_id {
                    params["threadId"] = json!(thread);
                }
                input.write(json!({"id":2,"method":if self.request.provider_session_id.is_some(){"thread/resume"}else{"thread/start"},"params":params}))?;
            } else if id == 2 {
                if !record["error"].is_null() {
                    return Err(error_message(record));
                }
                input.thread = record["result"]["thread"]["id"].as_str().map(str::to_owned);
                if input.thread.is_none() {
                    return Err("Codex did not return a conversation ID".into());
                }
                out.push(json!({"type":"thread.started","thread_id":input.thread}));
                let mut status =
                    json!({"type":"agentdeck.model","model":record["result"]["model"]});
                if status["model"].is_null() {
                    status["model"] = json!(self.request.model);
                }
                out.push(status);
                input.write(json!({"id":3,"method":"turn/start","params":{"threadId":input.thread,"input":codex_input(&self.request)?}}))?;
            } else if id == 3 {
                if !record["error"].is_null() {
                    return Err(error_message(record));
                }
                input.turn = record["result"]["turn"]["id"].as_str().map(str::to_owned);
                input.started = true;
                if input.turn.is_none() {
                    return Err("Codex did not return an active turn ID".into());
                }
                out.push(json!({"type":"agentdeck.initial-delivered"}));
                self.drain_steers(input)?;
            } else if let Some(message) = input.pending.remove(&id) {
                if record["error"].is_null() {
                    if let Some(turn) = record["result"]["turn"]["id"].as_str() {
                        input.turn = Some(turn.into());
                        self.drain_steers(input)?;
                    }
                    out.push(json!({"type":"agentdeck.input","message_id":message.id,"status":"accepted"}));
                } else {
                    let error = error_message(record);
                    let lower = error.to_lowercase();
                    if lower.contains("active turn")
                        || lower.contains("turn id")
                        || lower.contains("mismatch")
                    {
                        input.queued.push_back(message);
                    } else {
                        out.push(json!({"type":"agentdeck.input","message_id":message.id,"status":"failed","error":error}));
                    }
                }
                if input.turn.is_none() {
                    input.start_queued()?;
                }
            }
            return Ok(());
        }
        if record.get("id").is_some() && record.get("method").is_some() {
            let method = record["method"].as_str().unwrap_or("");
            let result = match method {
                "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                    json!({"decision":"cancel"})
                }
                "item/permissions/requestApproval" => json!({"permissions":{},"scope":"turn"}),
                "mcpServer/elicitation/request" => json!({"action":"cancel","content":null}),
                "item/tool/requestUserInput" | "tool/requestUserInput" => json!({"answers":{}}),
                _ => {
                    input.write(json!({"id":record["id"],"error":{"code":-32601,"message":"Unsupported client request"}}))?;
                    return Ok(());
                }
            };
            input.write(json!({"id":record["id"],"result":result}))?;
            out.push(json!({"type":"error","message":"This action requires native permission or user input. Check the access setting or continue in the native terminal."}));
            return Ok(());
        }
        let params = &record["params"];
        if let Some(thread) = params["threadId"].as_str() {
            if input.thread.as_deref().is_some_and(|t| t != thread) {
                return Ok(());
            }
        }
        match record["method"].as_str().unwrap_or("") {
            "turn/started"=>{input.turn=params["turn"]["id"].as_str().map(str::to_owned);input.started=true;out.push(json!({"type":"turn.started"}));}
            "item/agentMessage/delta"=>{
                let id=params["itemId"].as_str().unwrap_or("message");
                let text=self.text.entry(id.into()).or_default();text.push_str(params["delta"].as_str().unwrap_or(""));
                if text.len()>512*1024 { *text=super::bounded_text(text,512*1024); }
                out.push(json!({"type":"item.updated","item":{"id":id,"type":"agent_message","text":text}}));
            }
            "item/started"|"item/completed"=>{
                if params["item"]["type"]=="userMessage" {return Ok(());}
                out.push(json!({"type":if record["method"]=="item/started"{"item.started"}else{"item.completed"},"item":normalize_item(&params["item"])}));
            }
            "thread/tokenUsage/updated"=>{
                let usage=&params["tokenUsage"]["last"];
                self.usage=json!({"input_tokens":usage["inputTokens"],"output_tokens":usage["outputTokens"],"cached_input_tokens":usage["cachedInputTokens"]});
                out.push(json!({"type":"turn.completed","usage":sum_usage(&self.totals,&self.usage)}));
            }
            "turn/completed"=>{
                if params["turn"]["status"]=="failed" {out.push(json!({"type":"error","message":params["turn"]["error"]["message"].as_str().unwrap_or("Codex turn failed")}));}
                self.totals=sum_usage(&self.totals,&self.usage);self.usage=json!({});
                out.push(json!({"type":"turn.completed","usage":self.totals}));
                if input.turn.as_deref()==params["turn"]["id"].as_str(){input.turn=None;}
                input.start_queued()?;
            }
            "error"=>out.push(json!({"type":"error","message":params["error"]["message"].as_str().unwrap_or("Codex protocol error")})),
            "thread/compacted"=>out.push(json!({"type":"context_compacted"})),
            _=>{}
        }
        Ok(())
    }
    fn drain_steers(&mut self, input: &mut LiveInput) -> Result<(), String> {
        while let Some(message) = input.queued.pop_front() {
            input.sequence += 1;
            let id = input.sequence;
            input.write(json!({"id":id,"method":"turn/steer","params":{"threadId":input.thread,"expectedTurnId":input.turn,"input":message.input}}))?;
            input.pending.insert(id, message);
        }
        Ok(())
    }
}
fn error_message(record: &Value) -> String {
    record["error"]["message"]
        .as_str()
        .unwrap_or("Codex rejected the request")
        .into()
}
fn sum_usage(a: &Value, b: &Value) -> Value {
    let mut out = json!({});
    for key in ["input_tokens", "output_tokens", "cached_input_tokens"] {
        if a[key].is_number() || b[key].is_number() {
            out[key] = json!(a[key].as_u64().unwrap_or(0) + b[key].as_u64().unwrap_or(0));
        }
    }
    out
}
pub(super) fn normalize_item(item: &Value) -> Value {
    let mut out = item.clone();
    out["type"] = json!(match item["type"].as_str().unwrap_or("") {
        "agentMessage" => "agent_message",
        "commandExecution" => "command_execution",
        "fileChange" => "file_change",
        "webSearch" => "web_search",
        "mcpToolCall" => "mcp_tool_call",
        "collabAgentToolCall" => "collab_agent_tool_call",
        v => v,
    });
    if let Some(value) = item.get("aggregatedOutput") {
        out["aggregated_output"] = value.clone();
    }
    if let Some(value) = item.get("exitCode") {
        out["exit_code"] = value.clone();
    }
    if let Some(value) = item.get("parentThreadId") {
        out["parent_id"] = value.clone();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    struct Sink(Arc<Mutex<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    #[test]
    fn new_and_resumed_threads_apply_full_access_and_plan_overrides() {
        for resumed in [false, true] {
            for plan in [false, true] {
                let mut req = super::super::tests::request("codex");
                req.full_access = true;
                req.mode = Some(if plan { "plan" } else { "code" }.into());
                req.provider_session_id = resumed.then(|| "existing-thread".into());
                let bytes = Arc::new(Mutex::new(vec![]));
                let mut input = LiveInput::with_writer(Box::new(Sink(bytes.clone())), true);
                let mut protocol = LiveProtocol::new(&req);
                protocol.ingest(&json!({"id":1,"result":{}}).to_string(), &mut input);
                let written = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
                let request: Value = serde_json::from_str(written.lines().last().unwrap()).unwrap();
                assert_eq!(
                    request["method"],
                    if resumed {
                        "thread/resume"
                    } else {
                        "thread/start"
                    }
                );
                assert_eq!(
                    request["params"]["sandbox"],
                    if plan {
                        "read-only"
                    } else {
                        "danger-full-access"
                    }
                );
                if !plan {
                    assert_eq!(request["params"]["approvalPolicy"], "never");
                }
            }
        }
    }
    #[test]
    fn codex_steers_with_native_turn_id_and_recovers_completion_race() {
        let mut req = super::super::tests::request("codex");
        req.prompt = "Original objective".into();
        let bytes = Arc::new(Mutex::new(vec![]));
        let mut input = LiveInput::with_writer(Box::new(Sink(bytes.clone())), true);
        let mut protocol = LiveProtocol::new(&req);
        input.initialize().unwrap();
        protocol.ingest(&json!({"id":1,"result":{}}).to_string(), &mut input);
        protocol.ingest(
            &json!({"id":2,"result":{"thread":{"id":"native-thread"}}}).to_string(),
            &mut input,
        );
        req.prompt = "Also test Portuguese".into();
        assert_eq!(input.submit(&req, "addition").unwrap(), "queued");
        protocol.ingest(
            &json!({"id":3,"result":{"turn":{"id":"native-turn"}}}).to_string(),
            &mut input,
        );
        let written = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
        assert!(written.contains("turn/steer"));
        assert!(written.contains("expectedTurnId\":\"native-turn"));
        assert!(written.contains("Also test Portuguese"));
        protocol.ingest(&json!({"method":"turn/completed","params":{"threadId":"native-thread","turn":{"id":"native-turn","status":"completed"}}}).to_string(),&mut input);
        assert!(input.writer.is_some());
        protocol.ingest(
            &json!({"id":101,"error":{"message":"No active turn"}}).to_string(),
            &mut input,
        );
        assert!(String::from_utf8(bytes.lock().unwrap().clone())
            .unwrap()
            .contains("\"id\":102,\"method\":\"turn/start\""));
        let ack = protocol.ingest(
            &json!({"id":102,"result":{"turn":{"id":"next-turn"}}}).to_string(),
            &mut input,
        );
        assert!(ack.iter().any(|line| line.contains("accepted")));
        protocol.ingest(&json!({"method":"turn/completed","params":{"threadId":"native-thread","turn":{"id":"next-turn","status":"completed"}}}).to_string(),&mut input);
        assert!(input.writer.is_none());
    }
    #[test]
    fn claude_keeps_input_open_for_queued_messages_and_accumulates_usage_once() {
        let req = super::super::tests::request("claude-code");
        let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
        let mut protocol = LiveProtocol::new(&req);
        input.submit(&req, "addition").unwrap();
        let result =
            json!({"type":"result","uuid":"first","usage":{"input_tokens":10,"output_tokens":3}})
                .to_string();
        protocol.ingest(&result, &mut input);
        protocol.ingest(&result, &mut input);
        assert!(input.writer.is_some());
        let final_record = protocol.ingest(
            &json!({"type":"result","uuid":"second","usage":{"input_tokens":20,"output_tokens":4}})
                .to_string(),
            &mut input,
        );
        assert!(input.writer.is_none());
        let value: Value = serde_json::from_str(&final_record[0]).unwrap();
        assert_eq!(value["usage"]["input_tokens"], 30);
        assert_eq!(value["usage"]["output_tokens"], 7);
    }
}
