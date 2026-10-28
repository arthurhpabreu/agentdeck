//! Native live input: Codex App Server turn/steer and Claude streaming stdin.
use super::{build_input, ChatTurnRequest};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::Write,
    process::ChildStdin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, SyncSender, TrySendError},
        Arc, Mutex,
    },
};

const MAX_QUEUED_INPUT_BYTES: usize = 96 * 1024 * 1024;

// Never write to a potentially full provider pipe while holding LiveInput's
// mutex. The output worker also needs that mutex to drain provider responses.
// Keeping pipe IO on its own thread prevents a large steer and verbose tool
// output from blocking each other indefinitely.
struct PipeWriter {
    sender: SyncSender<Vec<u8>>,
    pending_bytes: Arc<AtomicUsize>,
    failure: Arc<Mutex<Option<String>>>,
}

impl PipeWriter {
    fn new(mut writer: impl Write + Send + 'static) -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(32);
        let pending_bytes = Arc::new(AtomicUsize::new(0));
        let failure = Arc::new(Mutex::new(None));
        let remaining = pending_bytes.clone();
        let failed = failure.clone();
        std::thread::spawn(move || {
            while let Ok(bytes) = receiver.recv() {
                let result = writer.write_all(&bytes).and_then(|_| writer.flush());
                remaining.fetch_sub(bytes.len(), Ordering::Relaxed);
                if let Err(error) = result {
                    if let Ok(mut failure) = failed.lock() {
                        *failure = Some(format!("Could not write to the provider: {error}. Delivery of pending messages is unconfirmed; check the native conversation before retrying."));
                    }
                    break;
                }
            }
        });
        Self {
            sender,
            pending_bytes,
            failure,
        }
    }
}

impl Write for PipeWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if let Some(error) = self.failure.lock().ok().and_then(|failure| failure.clone()) {
            return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, error));
        }
        self.pending_bytes
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |pending| {
                pending
                    .checked_add(bytes.len())
                    .filter(|total| *total <= MAX_QUEUED_INPUT_BYTES)
            })
            .map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::WouldBlock,
            "The provider input queue is full (96 MiB). Wait for pending messages before retrying.")
            })?;
        match self.sender.try_send(bytes.to_vec()) {
            Ok(()) => Ok(bytes.len()),
            Err(error) => {
                self.pending_bytes.fetch_sub(bytes.len(), Ordering::Relaxed);
                let (kind, message) = match error {
                    TrySendError::Full(_) => (
                        std::io::ErrorKind::WouldBlock,
                        "The provider input queue is full. Wait before retrying.",
                    ),
                    TrySendError::Disconnected(_) => (
                        std::io::ErrorKind::BrokenPipe,
                        "The provider input stream has closed.",
                    ),
                };
                Err(std::io::Error::new(kind, message))
            }
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(Clone)]
struct Message {
    id: String,
    input: Value,
    bytes: usize,
}
impl Message {
    fn new(id: &str, input: Value) -> Self {
        let bytes = input.to_string().len();
        Self {
            id: id.into(),
            input,
            bytes,
        }
    }
}
#[derive(Default)]
struct ClaudeMessage {
    accepted: bool,
    included_in_result: bool,
}
pub(super) struct LiveInput {
    writer: Option<Box<dyn Write + Send>>,
    codex: bool,
    thread: Option<String>,
    turn: Option<String>,
    completed_turn: Option<String>,
    initial_pending: bool,
    sequence: u64,
    queued: VecDeque<Message>,
    pending: HashMap<u64, Message>,
    claude_pending: usize,
    claude_initial_pending: bool,
    claude_messages: HashMap<String, ClaudeMessage>,
    started: bool,
    compacting: bool,
    transport_failure: Arc<Mutex<Option<String>>>,
    interactions: HashMap<String, Value>,
}
impl LiveInput {
    pub fn interaction_snapshot(&self) -> Vec<Value> {
        self.interactions.values().map(interaction_value).collect()
    }
    pub fn completion_drained(&self) -> bool {
        self.writer.is_none()
            && self.queued.is_empty()
            && self.pending.is_empty()
            && !self.initial_pending
            && (self.codex || self.claude_pending == 0)
    }
    pub fn abort(&mut self) -> Vec<(String, &'static str)> {
        self.writer.take();
        self.interactions.clear();
        let mut unconfirmed = Vec::new();
        for message in self.queued.drain(..) {
            unconfirmed.push((
                message.id,
                "This additional message was not sent. The conversation is preserved.",
            ));
        }
        for (_, message) in self.pending.drain() {
            unconfirmed.push((message.id, "The provider did not confirm this additional message. Check the native conversation before sending it again."));
        }
        for (id, message) in self.claude_messages.drain() {
            if !message.accepted {
                unconfirmed.push((id, "The provider did not confirm this additional message. Check the native conversation before sending it again."));
            }
        }
        unconfirmed
    }
    pub fn new(stdin: ChildStdin, codex: bool, compacting: bool) -> Self {
        let mut input = Self::with_buffered_writer(stdin, codex);
        input.compacting = compacting;
        input
    }
    fn with_buffered_writer(writer: impl Write + Send + 'static, codex: bool) -> Self {
        let writer = PipeWriter::new(writer);
        let failure = writer.failure.clone();
        let mut input = Self::with_writer(Box::new(writer), codex);
        input.transport_failure = failure;
        input
    }
    pub fn transport_error(&self) -> Option<String> {
        self.transport_failure
            .lock()
            .ok()
            .and_then(|failure| failure.clone())
    }
    fn with_writer(writer: Box<dyn Write + Send>, codex: bool) -> Self {
        Self {
            writer: Some(writer),
            codex,
            thread: None,
            turn: None,
            completed_turn: None,
            initial_pending: false,
            sequence: 100,
            queued: VecDeque::new(),
            pending: HashMap::new(),
            claude_pending: 1,
            claude_initial_pending: true,
            claude_messages: HashMap::new(),
            started: false,
            compacting: false,
            transport_failure: Arc::new(Mutex::new(None)),
            interactions: HashMap::new(),
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
    pub fn respond(&mut self, id: &str, response: &Value) -> Result<(), String> {
        let request = self
            .interactions
            .get(id)
            .ok_or("This request is no longer pending.")?;
        let method = request["method"].as_str().unwrap_or_default();
        if method.ends_with("/requestApproval") {
            if !matches!(
                response["decision"].as_str(),
                Some("accept" | "decline" | "cancel")
            ) {
                return Err("Invalid approval decision.".into());
            }
        } else {
            let answers = response["answers"]
                .as_object()
                .ok_or("Answers are required.")?;
            for question in request["params"]["questions"]
                .as_array()
                .ok_or("Invalid questions.")?
            {
                let answer = answers
                    .get(question["id"].as_str().unwrap_or_default())
                    .and_then(|value| value["answers"].as_array())
                    .ok_or("Answer each question.")?;
                if answer.is_empty()
                    || answer.iter().any(|value| {
                        value
                            .as_str()
                            .is_none_or(|text| text.trim().is_empty() || text.len() > 32_768)
                    })
                {
                    return Err("Invalid answer.".into());
                }
            }
        }
        if response.to_string().len() > 128 * 1024 {
            return Err("Response is too large.".into());
        }
        self.write(json!({"id":request["id"],"result":response}))?;
        self.interactions.remove(id);
        Ok(())
    }
    pub fn submit(&mut self, request: &ChatTurnRequest, id: &str) -> Result<&'static str, String> {
        if self.writer.is_none() {
            return Err("This response has already ended".into());
        }
        if self.queued.len() + self.pending.len() + self.claude_pending >= 24 {
            return Err("Too many additional messages in flight".into());
        }
        if !self.codex {
            let mut input: Value =
                serde_json::from_str(&build_input(request)?).map_err(|e| e.to_string())?;
            input["uuid"] = json!(id);
            if self.compacting {
                let message = Message::new(id, input);
                self.check_message_capacity(&message)?;
                self.queued.push_back(message);
                return Ok("queued");
            }
            self.write(input)?;
            self.claude_messages
                .insert(id.into(), ClaudeMessage::default());
            self.update_claude_pending();
            return Ok("queued");
        }
        let message = Message::new(id, codex_input(request)?);
        self.check_message_capacity(&message)?;
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
    fn check_message_capacity(&self, message: &Message) -> Result<(), String> {
        let pending: usize = self
            .queued
            .iter()
            .chain(self.pending.values())
            .map(|message| message.bytes)
            .sum();
        if pending.saturating_add(message.bytes) > MAX_QUEUED_INPUT_BYTES {
            return Err(
                "Additional messages exceed the 96 MiB input queue limit. Wait before retrying."
                    .into(),
            );
        }
        Ok(())
    }
    fn update_claude_pending(&mut self) {
        self.claude_pending = usize::from(self.claude_initial_pending) + self.claude_messages.len();
    }
    fn claude_result(&mut self, record: &Value) -> Vec<String> {
        // One native result may consume several stdin messages. Only explicit
        // UUIDs, or accepted messages covered by a later idle, drain followups.
        self.claude_initial_pending = false;
        let mut consumed = vec![];
        let explicit_ids =
            record["user_message_uuids"].is_array() || record["user_message_uuid"].is_string();
        if let Some(ids) = record["user_message_uuids"].as_array() {
            for id in ids.iter().filter_map(Value::as_str) {
                if let Some(message) = self.claude_messages.remove(id) {
                    if !message.accepted {
                        consumed.push(id.to_owned());
                    }
                }
            }
        } else if let Some(id) = record["user_message_uuid"].as_str() {
            if let Some(message) = self.claude_messages.remove(id) {
                if !message.accepted {
                    consumed.push(id.to_owned());
                }
            }
        }
        for message in self.claude_messages.values_mut() {
            message.included_in_result = message.accepted && !explicit_ids;
        }
        self.update_claude_pending();
        consumed
    }
    fn claude_idle(&mut self) {
        self.claude_messages
            .retain(|_, message| !message.included_in_result);
        self.update_claude_pending();
    }
    fn start_queued(&mut self) -> Result<(), String> {
        if self.compacting
            || self.turn.is_some()
            || self.initial_pending
            || !self.pending.is_empty()
        {
            return Ok(());
        }
        if let Some(message) = self.queued.pop_front() {
            self.sequence += 1;
            let rpc = self.sequence;
            if let Err(error) = self.write(json!({"id":rpc,"method":"turn/start","params":{"threadId":self.thread,"input":message.input}})) {
                self.queued.push_front(message);
                return Err(error);
            }
            self.pending.insert(rpc, message);
        } else if self.started {
            self.writer.take();
        }
        Ok(())
    }
}
pub(super) fn initial_input(request: &ChatTurnRequest) -> Result<String, String> {
    if request.runner_type == "claude-code"
        && request.compact_before_turn
        && request.provider_session_id.is_some()
    {
        let mut compact = request.clone();
        // Compaction is a separate native input, not receipt of the queued
        // coordination note. Reusing its UUID could deduplicate the real note.
        compact.coordination = false;
        compact.prompt = "/compact Preserve the user's objective, constraints, decisions, changed files, verification results, and unfinished work so the conversation can continue.".into();
        compact.attachments.clear();
        return build_input(&compact);
    }
    build_input(request)
}
pub(super) fn codex_input(request: &ChatTurnRequest) -> Result<Value, String> {
    let mut input = vec![json!({"type":"text","text":build_input(request)?})];
    for skill in &request.skills {
        input.push(json!({"type":"skill","name":skill.name,"path":skill.path}));
    }
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
    usage: Value,
    totals: Value,
    claude_totals: Value,
    claude_results: std::collections::HashSet<String>,
    claude_state: Option<String>,
    claude_result_ready: bool,
    claude_coordination_accepted: bool,
    claude_cleanup_current: bool,
    claude_tasks: std::collections::HashSet<String>,
    claude_all_tasks: std::collections::HashSet<String>,
    claude_background_tasks: std::collections::HashSet<String>,
    claude_terminal_tasks: VecDeque<(String, Option<String>)>,
    claude_task_runs: HashMap<String, Option<String>>,
    claude_ledger_supported: bool,
    claude_ledger_uncertain: bool,
    compacting: bool,
    compact_confirmed: bool,
    compact_turn: Option<String>,
    last_compaction_item: Option<String>,
    compact_result_id: Option<String>,
    phase: ProtocolPhase,
    progress_revision: u64,
    compact_items: std::collections::HashSet<(String, String)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ProtocolPhase {
    Initializing,
    LoadingThread,
    Compacting,
    StartingTurn,
    Running,
    Failed,
}

fn claude_task_ledger_supported(version: &str) -> bool {
    let parts: Vec<_> = version.split('.').map(str::parse::<u32>).collect();
    match parts.as_slice() {
        [Ok(major), Ok(minor), Ok(patch)] => (*major, *minor, *patch) >= (2, 1, 300),
        _ => false,
    }
}

impl LiveProtocol {
    pub fn new(request: &ChatTurnRequest) -> Self {
        Self {
            request: request.clone(),
            usage: json!({}),
            totals: json!({}),
            claude_totals: json!({}),
            claude_results: Default::default(),
            claude_state: None,
            claude_result_ready: false,
            claude_coordination_accepted: false,
            claude_cleanup_current: false,
            claude_tasks: Default::default(),
            claude_all_tasks: Default::default(),
            claude_background_tasks: Default::default(),
            claude_terminal_tasks: Default::default(),
            claude_task_runs: Default::default(),
            claude_ledger_supported: false,
            claude_ledger_uncertain: false,
            compacting: request.compact_before_turn && request.provider_session_id.is_some(),
            compact_confirmed: false,
            compact_turn: None,
            last_compaction_item: None,
            compact_result_id: None,
            phase: if request.runner_type == "codex"
                || (request.compact_before_turn && request.provider_session_id.is_some())
            {
                ProtocolPhase::Initializing
            } else {
                ProtocolPhase::StartingTurn
            },
            progress_revision: 0,
            compact_items: Default::default(),
        }
    }
    pub fn compacting(&self) -> bool {
        self.compacting
    }
    pub fn phase(&self) -> ProtocolPhase {
        self.phase
    }
    pub fn progress_revision(&self) -> u64 {
        self.progress_revision
    }
    pub fn completion_cleanup_ready(&self) -> bool {
        self.request.runner_type == "codex"
            || (self.claude_ledger_supported
                && !self.claude_ledger_uncertain
                && self.claude_state.as_deref() == Some("idle")
                && self.claude_result_ready
                && self.claude_cleanup_current
                && self.claude_all_tasks.is_empty()
                && self.claude_background_tasks.is_empty())
    }
    fn claude_task_event(&mut self, record: &Value) -> Option<String> {
        let Some(id) = record["task_id"].as_str().filter(|id| !id.is_empty()) else {
            self.claude_ledger_uncertain = true;
            return None;
        };
        let run = record["run_id"].as_str().filter(|run| !run.is_empty());
        if run.is_none() {
            // Older CLIs can still use the EOF fallback, but cannot prove that
            // a terminal task id was not resumed in another native run.
            self.claude_ledger_uncertain = true;
        }
        if let Some(previous) = self.claude_task_runs.get(id) {
            match (previous.as_deref(), run) {
                (Some(previous), Some(run)) if run < previous => return None,
                (Some(_), None) => {
                    self.claude_all_tasks.insert(id.into());
                    if matches!(
                        record["task_type"].as_str(),
                        Some("local_agent" | "local_workflow")
                    ) {
                        self.claude_tasks.insert(id.into());
                    }
                    return None;
                }
                (Some(previous), Some(run)) if run > previous => {
                    self.claude_tasks.remove(id);
                    self.claude_background_tasks.remove(id);
                }
                _ => {}
            }
        }
        let key = (id.to_owned(), run.map(str::to_owned));
        if self.claude_terminal_tasks.contains(&key) {
            if run.is_none() && record["subtype"] == "task_started" {
                self.claude_all_tasks.insert(id.into());
                if matches!(
                    record["task_type"].as_str(),
                    Some("local_agent" | "local_workflow")
                ) {
                    self.claude_tasks.insert(id.into());
                }
            }
            return None;
        }
        self.claude_task_runs.insert(id.into(), key.1);
        Some(id.into())
    }
    pub fn ingest(&mut self, line: &str, input: &mut LiveInput) -> Vec<String> {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            if !input.codex {
                self.claude_ledger_uncertain = true;
            }
            return vec![line.into()];
        };
        let mut out = vec![];
        input.compacting = self.compacting;
        let result = if input.codex {
            self.codex(&record, input, &mut out)
        } else {
            self.claude(record, input, &mut out)
        };
        if let Err(error) = result {
            out.push(json!({"type":"error","message":error}));
            input.writer.take();
            self.phase = ProtocolPhase::Failed;
        }
        out.into_iter().map(|v| v.to_string()).collect()
    }
    fn claude(
        &mut self,
        mut record: Value,
        input: &mut LiveInput,
        out: &mut Vec<Value>,
    ) -> Result<(), String> {
        let top_level = !crate::notification::completion::is_child_event(&record);
        let task_frame = record["type"] == "system"
            && record["subtype"].as_str().is_some_and(|subtype| {
                subtype.starts_with("task_") || subtype == "background_tasks_changed"
            });
        if top_level || task_frame {
            if matches!(record["type"].as_str(), Some("assistant" | "stream_event"))
                || (record["type"] == "system" && record["subtype"] == "api_retry")
            {
                self.claude_result_ready = false;
                if self.claude_state.is_some() {
                    self.claude_state = Some("running".into());
                }
            }
            if record["type"] == "system" {
                match record["subtype"].as_str() {
                    Some("init") if top_level => {
                        self.claude_ledger_supported = record["claude_code_version"]
                            .as_str()
                            .is_some_and(claude_task_ledger_supported);
                    }
                    Some("session_state_changed") if top_level => {
                        self.claude_state = record["state"].as_str().map(str::to_owned);
                        if !matches!(
                            self.claude_state.as_deref(),
                            Some("idle" | "running" | "requires_action")
                        ) {
                            self.claude_ledger_uncertain = true;
                        }
                        if self.claude_state.as_deref() != Some("idle") {
                            self.claude_result_ready = false;
                        }
                    }
                    Some("task_started") => {
                        let Some(id) = self.claude_task_event(&record) else {
                            out.push(record);
                            return Ok(());
                        };
                        self.claude_cleanup_current = false;
                        self.claude_all_tasks.insert(id.clone());
                        if record["task_type"].as_str().is_none() {
                            self.claude_ledger_uncertain = true;
                        }
                        // Shells/monitors may be permanent. Native idle decides
                        // their EOF; finite delegated agents must keep stdin.
                        if matches!(
                            record["task_type"].as_str(),
                            Some("local_agent" | "local_workflow")
                        ) {
                            self.claude_tasks.insert(id);
                        }
                    }
                    Some("task_notification" | "task_updated") => {
                        let notification = record["subtype"] == "task_notification";
                        let status = if notification {
                            &record["status"]
                        } else {
                            &record["patch"]["status"]
                        };
                        let terminal = matches!(
                            status.as_str(),
                            Some("completed" | "failed" | "stopped" | "killed")
                        );
                        if notification && !terminal {
                            self.claude_ledger_uncertain = true;
                        }
                        if let Some(id) = self.claude_task_event(&record) {
                            let deferring_agent = self.claude_tasks.contains(&id);
                            if terminal {
                                self.claude_all_tasks.remove(&id);
                                self.claude_background_tasks.remove(&id);
                                self.claude_tasks.remove(&id);
                                if self.claude_terminal_tasks.len() >= 1024 {
                                    if let Some((old_id, old_run)) =
                                        self.claude_terminal_tasks.pop_front()
                                    {
                                        if self.claude_task_runs.get(&old_id) == Some(&old_run)
                                            && !self.claude_all_tasks.contains(&old_id)
                                        {
                                            self.claude_task_runs.remove(&old_id);
                                        }
                                    }
                                }
                                self.claude_terminal_tasks
                                    .push_back((id, record["run_id"].as_str().map(str::to_owned)));
                            } else {
                                self.claude_all_tasks.insert(id);
                            }
                            // Agent completion can wake the parent for another
                            // turn. Shell activity must not withhold native EOF
                            // forever, but still revokes transport cleanup.
                            if terminal && deferring_agent {
                                self.claude_result_ready = false;
                            }
                            self.claude_cleanup_current = false;
                        }
                    }
                    Some("task_progress") => {
                        if let Some(id) = self.claude_task_event(&record) {
                            self.claude_all_tasks.insert(id);
                            self.claude_cleanup_current = false;
                        }
                    }
                    Some("background_tasks_changed") => {
                        if let Some(tasks) = record["tasks"].as_array() {
                            self.claude_background_tasks.clear();
                            for task in tasks {
                                if task["task_type"].as_str().is_none() {
                                    self.claude_ledger_uncertain = true;
                                }
                                if let Some(id) = self.claude_task_event(task) {
                                    self.claude_background_tasks.insert(id);
                                }
                            }
                            if !self.claude_background_tasks.is_empty() {
                                self.claude_cleanup_current = false;
                            }
                        } else {
                            self.claude_ledger_uncertain = true;
                        }
                    }
                    Some(subtype) if subtype.starts_with("task_") => {
                        self.claude_ledger_uncertain = true;
                        self.claude_result_ready = false;
                    }
                    _ => {}
                }
            }
        }
        if record["type"]
            .as_str()
            .is_some_and(|kind| kind.starts_with("task_"))
        {
            self.claude_ledger_uncertain = true;
            self.claude_result_ready = false;
        }
        if top_level
            && ((record["type"] == "system" && record["subtype"] == "init")
                || matches!(record["type"].as_str(), Some("assistant" | "stream_event")))
        {
            self.phase = if self.compacting {
                ProtocolPhase::Compacting
            } else {
                ProtocolPhase::Running
            };
        }
        if record["type"] == "result"
            && self.compact_result_id.as_deref() == record["uuid"].as_str()
            && self.compact_result_id.is_some()
        {
            return Ok(());
        }
        if self.compacting && top_level {
            if matches!(record["type"].as_str(), Some("stream_event" | "assistant"))
                || (record["type"] == "system" && record["subtype"] == "compact_boundary")
            {
                self.progress_revision += 1;
            }
            if record["type"] == "system" && record["subtype"] == "compact_boundary" {
                self.compact_confirmed = true;
                return Ok(());
            }
            if record["type"] == "result" {
                if record["is_error"] == true || !self.compact_confirmed {
                    return Err(format!("Context compaction was not confirmed. Your next request was not sent; the existing conversation is preserved. {}", record["result"].as_str().unwrap_or("Retry or adjust automatic compaction in the chat context settings.")));
                }
                self.compacting = false;
                self.phase = ProtocolPhase::Running;
                input.compacting = false;
                self.compact_result_id = record["uuid"].as_str().map(str::to_owned);
                for key in [
                    "input_tokens",
                    "output_tokens",
                    "cache_read_input_tokens",
                    "cache_creation_input_tokens",
                ] {
                    self.claude_totals[key] = json!(record["usage"][key].as_u64().unwrap_or(0));
                }
                out.push(json!({"type":"context_compacted","id":"before-turn","before_turn":true}));
                input.write_text(&build_input(&self.request)?)?;
                input.claude_initial_pending = true;
                input.claude_messages.clear();
                self.claude_result_ready = false;
                self.claude_cleanup_current = false;
                if self.claude_state.is_some() {
                    self.claude_state = Some("running".into());
                }
                while let Some(message) = input.queued.pop_front() {
                    if let Err(error) = input.write(message.input.clone()) {
                        input.queued.push_front(message);
                        return Err(error);
                    }
                    input
                        .claude_messages
                        .insert(message.id, ClaudeMessage::default());
                }
                input.update_claude_pending();
                out.push(json!({"type":"agentdeck.initial-delivered"}));
                return Ok(());
            }
            // Initialization binds the existing session, but compact output is not a user reply.
            if record["type"] == "system" {
                out.push(record);
            }
            return Ok(());
        }
        if top_level && self.request.coordination && !self.claude_coordination_accepted {
            let initial_id = self.request.turn_id.as_str();
            let echo = record["type"] == "user" && record["uuid"].as_str() == Some(initial_id);
            let result = record["type"] == "result"
                && (record["user_message_uuid"].as_str() == Some(initial_id)
                    || record["user_message_uuids"]
                        .as_array()
                        .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(initial_id))));
            if echo || result {
                self.claude_coordination_accepted = true;
                out.push(
                    json!({"type":"agentdeck.input","message_id":initial_id,"status":"accepted"}),
                );
            }
        }
        if record["type"] == "result" && top_level {
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
                self.claude_result_ready = true;
                self.claude_cleanup_current = true;
                for id in input.claude_result(&record) {
                    out.push(json!({"type":"agentdeck.input","message_id":id,"status":"accepted"}));
                }
            }
            record["usage"] = self.claude_totals.clone();
        }
        if record["type"] == "user" && top_level {
            if let Some(id) = record["uuid"].as_str() {
                if let Some(message) = input.claude_messages.get_mut(id) {
                    message.accepted = true;
                    out.push(json!({"type":"agentdeck.input","message_id":id,"status":"accepted"}));
                }
            }
        }
        if !self.claude_result_ready {
            self.claude_cleanup_current = false;
        }
        if self.claude_result_ready && self.claude_tasks.is_empty() {
            if self.claude_state.as_deref() == Some("idle") {
                input.claude_idle();
            }
            if matches!(self.claude_state.as_deref(), None | Some("idle"))
                && input.claude_pending == 0
                && input.queued.is_empty()
            {
                input.writer.take();
            }
        }
        out.push(record);
        if self.claude_state.as_deref() == Some("idle")
            && self.claude_result_ready
            && (!self.claude_all_tasks.is_empty() || !self.claude_background_tasks.is_empty())
        {
            out.push(json!({"type":"agentdeck.waiting-background"}));
        }
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
                self.phase = ProtocolPhase::LoadingThread;
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
                    // Loading the complete transcript can exceed the JSONL frame
                    // bound in large chats. Codex still restores its native context.
                    params["excludeTurns"] = json!(true);
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
                if self.compacting {
                    input.write(json!({"id":4,"method":"thread/compact/start","params":{"threadId":input.thread}}))?;
                    self.phase = ProtocolPhase::Compacting;
                } else {
                    self.start_initial(input)?;
                }
            } else if id == 4 {
                if !record["error"].is_null() {
                    return Err(format!("Context compaction could not start. Your next request was not sent; the existing conversation is preserved. {}", error_message(record)));
                }
                // This RPC acknowledges scheduling, not completion. Wait for turn/completed.
            } else if id == 3 {
                if !record["error"].is_null() {
                    return Err(error_message(record));
                }
                let turn = record["result"]["turn"]["id"]
                    .as_str()
                    .ok_or("Codex did not return an active turn ID")?;
                input.initial_pending = false;
                if input.completed_turn.as_deref() != Some(turn) {
                    input.turn = Some(turn.into());
                }
                input.started = true;
                self.phase = ProtocolPhase::Running;
                out.push(json!({"type":"agentdeck.initial-delivered","completed_turn":input.completed_turn.as_deref() == Some(turn)}));
                if input.turn.is_some() {
                    self.drain_steers(input)?;
                } else {
                    input.start_queued()?;
                    if !input.pending.is_empty() {
                        self.phase = ProtocolPhase::StartingTurn;
                    }
                }
            } else if let Some(message) = input.pending.remove(&id) {
                if record["error"].is_null() {
                    if let Some(turn) = record["result"]["turn"]["id"].as_str() {
                        if input.completed_turn.as_deref() != Some(turn) {
                            input.turn = Some(turn.into());
                            self.phase = ProtocolPhase::Running;
                            self.drain_steers(input)?;
                        }
                    }
                    out.push(json!({"type":"agentdeck.input","message_id":message.id,"status":"accepted","completed_turn":input.turn.is_none() && input.completed_turn.is_some()}));
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
                    if !input.pending.is_empty() {
                        self.phase = ProtocolPhase::StartingTurn;
                    }
                }
            }
            return Ok(());
        }
        if record.get("id").is_some() && record.get("method").is_some() {
            let method = record["method"].as_str().unwrap_or("");
            if matches!(
                method,
                "item/commandExecution/requestApproval"
                    | "item/fileChange/requestApproval"
                    | "item/tool/requestUserInput"
                    | "tool/requestUserInput"
            ) {
                let params = &record["params"];
                if params["threadId"]
                    .as_str()
                    .is_some_and(|id| input.thread.as_deref() != Some(id))
                    || params["turnId"]
                        .as_str()
                        .is_some_and(|id| input.turn.as_deref() != Some(id))
                {
                    input.write(json!({"id":record["id"],"error":{"code":-32600,"message":"Stale interaction"}}))?;
                    return Ok(());
                }
                let id = record["id"].to_string();
                if !input.interactions.contains_key(&id) {
                    if input.interactions.len() >= 32 || record.to_string().len() > 128 * 1024 {
                        return Err("Too many or oversized pending interactions.".into());
                    }
                    input.interactions.insert(id.clone(), record.clone());
                    out.push(json!({"type":"agentdeck.interaction","interaction":interaction_value(record)}));
                }
                return Ok(());
            }
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
        if self.compacting {
            match record["method"].as_str().unwrap_or("") {
                "thread/tokenUsage/updated" => {
                    let usage = &params["tokenUsage"]["last"];
                    let updated = json!({"input_tokens":usage["inputTokens"],"output_tokens":usage["outputTokens"],"cached_input_tokens":usage["cachedInputTokens"]});
                    if self.usage != updated {
                        self.progress_revision += 1;
                        self.usage = updated;
                    }
                    out.push(json!({"type":"agentdeck.context-window", "context_window":params["tokenUsage"]["modelContextWindow"]}));
                }
                "turn/started" => {
                    if params["turn"]["id"].is_string()
                        && self.compact_turn.as_deref() != params["turn"]["id"].as_str()
                    {
                        self.progress_revision += 1;
                    }
                    self.compact_turn = params["turn"]["id"].as_str().map(str::to_owned)
                }
                "item/started" | "item/completed"
                    if params["item"]["type"] == "contextCompaction" =>
                {
                    if let Some(id) = params["item"]["id"].as_str() {
                        if self.compact_items.len() < 128
                            && self.compact_items.insert((
                                id.to_owned(),
                                record["method"].as_str().unwrap_or_default().to_owned(),
                            ))
                        {
                            self.progress_revision += 1;
                        }
                    }
                    if record["method"] == "item/completed" {
                        self.compact_confirmed = true;
                    }
                }
                "thread/compacted" => {
                    if !self.compact_confirmed {
                        self.progress_revision += 1;
                    }
                    self.compact_confirmed = true;
                }
                "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta"
                    if params["delta"]
                        .as_str()
                        .is_some_and(|text| !text.is_empty()) =>
                {
                    self.progress_revision += 1
                }
                "turn/completed"
                    if self.compact_turn.as_deref() == params["turn"]["id"].as_str() =>
                {
                    if params["turn"]["status"] != "completed" || !self.compact_confirmed {
                        return Err("Context compaction did not complete. Your next request was not sent; the existing conversation is preserved. Retry or adjust automatic compaction in the chat context settings.".into());
                    }
                    self.compacting = false;
                    input.compacting = false;
                    self.last_compaction_item = Some("before-turn".into());
                    self.totals = sum_usage(&self.totals, &self.usage);
                    self.usage = json!({});
                    out.push(
                        json!({"type":"context_compacted","id":"before-turn","before_turn":true}),
                    );
                    self.start_initial(input)?;
                }
                "error" if params["willRetry"] == true => out.push(retry_warning(params)),
                "error" => return Err(error_message(&json!({"error":params["error"]}))),
                _ => {}
            }
            return Ok(());
        }
        match record["method"].as_str().unwrap_or("") {
            "serverRequest/resolved"=>{
                let id = params["requestId"].to_string();
                if input.interactions.remove(&id).is_some() { out.push(json!({"type":"agentdeck.interaction","resolved":id})); }
            }
            "turn/started"=>{input.turn=params["turn"]["id"].as_str().map(str::to_owned);input.started=true;self.phase=ProtocolPhase::Running;out.push(json!({"type":"turn.started"}));}
            "item/agentMessage/delta"=>{
                let id=params["itemId"].as_str().unwrap_or("message");
                // Send only the new text. Re-serializing the growing message on every
                // token causes quadratic work and floods the UI in long sessions.
                out.push(json!({"type":"item.updated","delta":true,"item":{"id":id,"type":"agent_message","text":params["delta"]}}));
            }
            "item/commandExecution/outputDelta"=>{
                out.push(json!({"type":"item.updated","delta":true,"item":{"id":params["itemId"],"type":"command_execution","aggregated_output":params["delta"]}}));
            }
            "item/reasoning/summaryTextDelta"|"item/reasoning/summaryPartAdded"|"item/reasoning/textDelta"=>{
                out.push(json!({"type":"item.updated","item":{"id":params["itemId"],"type":"reasoning"}}));
            }
            "item/started"|"item/completed"=>{
                if params["item"]["type"]=="userMessage" {return Ok(());}
                if params["item"]["type"]=="contextCompaction" {
                    self.last_compaction_item=params["item"]["id"].as_str().map(str::to_owned);
                    if record["method"]=="item/completed" {out.push(json!({"type":"context_compacted","id":self.last_compaction_item}));}
                    return Ok(());
                }
                out.push(json!({"type":if record["method"]=="item/started"{"item.started"}else{"item.completed"},"item":normalize_item(&params["item"])}));
            }
            "thread/tokenUsage/updated"=>{
                let usage=&params["tokenUsage"]["last"];
                self.usage=json!({"input_tokens":usage["inputTokens"],"output_tokens":usage["outputTokens"],"cached_input_tokens":usage["cachedInputTokens"]});
                out.push(json!({"type":"usage.updated","usage":sum_usage(&self.totals,&self.usage),"context_tokens":usage["inputTokens"].as_u64().unwrap_or(0)+usage["outputTokens"].as_u64().unwrap_or(0),"context_window":params["tokenUsage"]["modelContextWindow"]}));
            }
            "turn/completed"=>{
                input.interactions.clear();
                if params["turn"]["status"]=="failed" {out.push(json!({"type":"error","message":params["turn"]["error"]["message"].as_str().unwrap_or("Codex turn failed")}));}
                self.totals=sum_usage(&self.totals,&self.usage);self.usage=json!({});
                out.push(json!({"type":"turn.completed","status":params["turn"]["status"],"usage":self.totals}));
                if input.turn.as_deref()==params["turn"]["id"].as_str(){input.completed_turn=input.turn.take();}
                input.start_queued()?;
                if input.turn.is_none() && !input.pending.is_empty() {self.phase=ProtocolPhase::StartingTurn;}
            }
            "error" if params["willRetry"] == true => out.push(retry_warning(params)),
            "error"=>out.push(json!({"type":"error","message":params["error"]["message"].as_str().unwrap_or("Codex protocol error")})),
            "thread/compacted"=>out.push(json!({"type":"context_compacted","id":self.last_compaction_item.as_deref().unwrap_or("automatic")})),
            _=>{}
        }
        Ok(())
    }
    fn start_initial(&mut self, input: &mut LiveInput) -> Result<(), String> {
        input.write(json!({"id":3,"method":"turn/start","params":{"threadId":input.thread,"input":codex_input(&self.request)?}}))?;
        input.initial_pending = true;
        self.phase = ProtocolPhase::StartingTurn;
        Ok(())
    }
    fn drain_steers(&mut self, input: &mut LiveInput) -> Result<(), String> {
        while let Some(message) = input.queued.pop_front() {
            input.sequence += 1;
            let id = input.sequence;
            if let Err(error) = input.write(json!({"id":id,"method":"turn/steer","params":{"threadId":input.thread,"expectedTurnId":input.turn,"input":message.input}})) {
                input.queued.push_front(message);
                return Err(error);
            }
            input.pending.insert(id, message);
        }
        Ok(())
    }
}
fn interaction_value(record: &Value) -> Value {
    let method = record["method"].as_str().unwrap_or_default();
    let params = &record["params"];
    json!({"id":record["id"].to_string(),"kind":if method.ends_with("/requestApproval") {"approval"} else {"question"},"action":if method.contains("fileChange") {"fileChange"} else {"command"},"blocking":method.ends_with("/requestApproval") || params["isBlocking"] != false,"command":params["command"],"cwd":params["cwd"],"reason":params["reason"],"grantRoot":params["grantRoot"],"itemId":params["itemId"],"questions":params["questions"]})
}
fn retry_warning(params: &Value) -> Value {
    json!({"type":"agentdeck.warning", "status":"reconnecting", "message":params["error"]["message"].as_str().unwrap_or("Codex is retrying the connection. The conversation is preserved.")})
}
fn error_message(record: &Value) -> String {
    record["error"]["message"]
        .as_str()
        .unwrap_or("Codex rejected the request")
        .into()
}

#[cfg(test)]
#[path = "completion_live_tests.rs"]
mod completion_tests;
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
    #[test]
    fn approvals_remain_pending_until_the_user_decides_and_cannot_be_replayed() {
        for (method, decision) in [
            ("item/commandExecution/requestApproval", "accept"),
            ("item/fileChange/requestApproval", "cancel"),
        ] {
            let bytes = Arc::new(Mutex::new(Vec::new()));
            let req = super::super::tests::request("codex");
            let mut protocol = LiveProtocol::new(&req);
            let mut input = LiveInput::with_writer(Box::new(Sink(bytes.clone())), true);
            input.thread = Some("thread".into());
            input.turn = Some("turn".into());
            input.started = true;
            let request = json!({"id":77,"method":method,"params":{"threadId":"thread","turnId":"turn","command":"cargo test"}});
            let records = protocol.ingest(&request.to_string(), &mut input);
            assert!(records
                .iter()
                .any(|record| record.contains("agentdeck.interaction")));
            assert!(
                written(&bytes).is_empty(),
                "Never answer an approval automatically"
            );
            assert!(protocol.ingest(&request.to_string(), &mut input).is_empty());
            assert!(input
                .respond("77", &json!({"decision":"acceptForSession"}))
                .is_err());
            input.respond("77", &json!({"decision":decision})).unwrap();
            let sent: Value = serde_json::from_str(written(&bytes).trim()).unwrap();
            assert_eq!(sent, json!({"id":77,"result":{"decision":decision}}));
            assert!(input.respond("77", &json!({"decision":"accept"})).is_err());
        }
    }
    #[test]
    fn questions_preserve_blocking_intent_require_answers_and_expire_on_provider_resolution() {
        let req = super::super::tests::request("codex");
        let mut protocol = LiveProtocol::new(&req);
        let mut input = LiveInput::with_writer(Box::new(Vec::new()), true);
        input.thread = Some("thread".into());
        input.turn = Some("turn".into());
        input.started = true;
        let request = json!({"id":"q","method":"item/tool/requestUserInput","params":{"threadId":"thread","turnId":"turn","isBlocking":false,"questions":[{"id":"color","header":"Color","question":"Which color?"}]}});
        let records = protocol.ingest(&request.to_string(), &mut input);
        let event: Value = serde_json::from_str(&records[0]).unwrap();
        assert_eq!(event["interaction"]["blocking"], false);
        assert!(input.respond("\"q\"", &json!({"answers":{}})).is_err());
        let resolved = protocol.ingest(&json!({"method":"serverRequest/resolved","params":{"threadId":"thread","requestId":"q"}}).to_string(), &mut input);
        assert!(resolved.iter().any(|record| record.contains("resolved")));
        assert!(input
            .respond("\"q\"", &json!({"answers":{"color":{"answers":["Blue"]}}}))
            .is_err());
        let stale = protocol.ingest(&json!({"id":3,"method":"item/fileChange/requestApproval","params":{"threadId":"other","turnId":"turn"}}).to_string(), &mut input);
        assert!(stale.is_empty());
        assert!(input.interactions.is_empty());
    }
    #[test]
    fn claude_coordination_receipt_requires_its_native_input_uuid_and_is_idempotent() {
        let mut req = super::super::tests::request("claude-code");
        req.coordination = true;
        let initial: Value = serde_json::from_str(&initial_input(&req).unwrap()).unwrap();
        assert_eq!(initial["uuid"], req.turn_id);
        let mut ordinary = req.clone();
        ordinary.coordination = false;
        assert!(
            serde_json::from_str::<Value>(&initial_input(&ordinary).unwrap())
                .unwrap()
                .get("uuid")
                .is_none()
        );
        let mut compact = req.clone();
        compact.compact_before_turn = true;
        compact.provider_session_id = Some("native-session".into());
        assert!(
            serde_json::from_str::<Value>(&initial_input(&compact).unwrap())
                .unwrap()
                .get("uuid")
                .is_none()
        );
        let accepted = |records: &[String]| {
            records
                .iter()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter(|record| {
                    record["type"] == "agentdeck.input"
                        && record["message_id"] == req.turn_id
                        && record["status"] == "accepted"
                })
                .count()
        };
        for record in [
            json!({"type":"agentdeck.initial-delivered"}),
            json!({"type":"system","subtype":"init","session_id":"native-session"}),
            json!({"type":"assistant","message":{"content":[]}}),
            json!({"type":"user","uuid":"another-input"}),
            json!({"type":"user","uuid":req.turn_id,"parent_tool_use_id":"child-tool"}),
            json!({"type":"result","uuid":req.turn_id,"user_message_uuid":"another-input","usage":{}}),
        ] {
            let mut protocol = LiveProtocol::new(&req);
            let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
            assert_eq!(
                accepted(&protocol.ingest(&record.to_string(), &mut input)),
                0,
                "{record}"
            );
        }
        let mut protocol = LiveProtocol::new(&req);
        let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
        let echo=json!({"type":"user","uuid":req.turn_id,"session_id":"native-session","message":{"role":"user","content":[]}}).to_string();
        assert_eq!(accepted(&protocol.ingest(&echo, &mut input)), 1);
        assert_eq!(accepted(&protocol.ingest(&echo, &mut input)), 0);
        let result = json!({"type":"result","uuid":"native-result","user_message_uuids":[req.turn_id],"usage":{}});
        assert_eq!(
            accepted(&protocol.ingest(&result.to_string(), &mut input)),
            0
        );
    }

    #[test]
    fn claude_coordination_receipt_can_use_explicit_native_result_input_references() {
        for multiple in [false, true] {
            let mut req = super::super::tests::request("claude-code");
            req.coordination = true;
            let mut protocol = LiveProtocol::new(&req);
            let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
            let mut result = json!({"type":"result","uuid":"native-result","usage":{}});
            if multiple {
                result["user_message_uuids"] = json!(["other-input", req.turn_id]);
            } else {
                result["user_message_uuid"] = json!(req.turn_id);
            }
            let out = protocol.ingest(&result.to_string(), &mut input);
            let receipts = out
                .iter()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter(|record| {
                    record["type"] == "agentdeck.input"
                        && record["message_id"] == req.turn_id
                        && record["status"] == "accepted"
                })
                .count();
            assert_eq!(receipts, 1);
            assert!(!protocol
                .ingest(&result.to_string(), &mut input)
                .iter()
                .any(|line| line.contains("agentdeck.input")));
            req.coordination = false;
            let mut ordinary = LiveProtocol::new(&req);
            let mut ordinary_input = LiveInput::with_writer(Box::new(Vec::new()), false);
            assert!(!ordinary
                .ingest(&result.to_string(), &mut ordinary_input)
                .iter()
                .any(|line| line.contains("agentdeck.input")));
        }
    }

    #[test]
    fn successful_native_turn_closes_input_without_waiting_for_process_exit() {
        let req = super::super::tests::request("codex");
        let mut input = LiveInput::with_writer(Box::new(Vec::new()), true);
        input.thread = Some("thread".into());
        input.turn = Some("native-turn".into());
        input.started = true;
        let mut protocol = LiveProtocol::new(&req);
        let out = protocol.ingest(r#"{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"native-turn","status":"completed"}}}"#, &mut input);
        assert_eq!(
            serde_json::from_str::<Value>(&out[0]).unwrap()["type"],
            "turn.completed"
        );
        assert!(input.turn.is_none());
        assert!(input.writer.is_none());
        assert!(input.submit(&req, "too-late").is_err());
    }
    #[test]
    fn codex_live_deltas_keep_native_identity_and_only_send_new_text() {
        let req = super::super::tests::request("codex");
        let mut input = LiveInput::with_writer(Box::new(Vec::new()), true);
        input.thread = Some("thread".into());
        let mut protocol = LiveProtocol::new(&req);
        for (method, id, delta, item_type, field) in [
            (
                "item/agentMessage/delta",
                "message",
                "first ",
                "agent_message",
                "text",
            ),
            (
                "item/agentMessage/delta",
                "message",
                "second",
                "agent_message",
                "text",
            ),
            (
                "item/commandExecution/outputDelta",
                "command",
                "building\n",
                "command_execution",
                "aggregated_output",
            ),
        ] {
            let output = protocol.ingest(
                &json!({"method":method,"params":{"threadId":"thread","itemId":id,"delta":delta}})
                    .to_string(),
                &mut input,
            );
            let record: Value = serde_json::from_str(&output[0]).unwrap();
            assert_eq!(record["delta"], true);
            assert_eq!(record["item"]["id"], id);
            assert_eq!(record["item"]["type"], item_type);
            assert_eq!(record["item"][field], delta);
        }
        let unrelated = protocol.ingest(r#"{"method":"item/commandExecution/outputDelta","params":{"threadId":"other","itemId":"command","delta":"hidden"}}"#, &mut input);
        assert!(unrelated.is_empty());
    }

    #[test]
    fn codex_token_updates_and_reasoning_remain_live_activity() {
        let req = super::super::tests::request("codex");
        let mut input = LiveInput::with_writer(Box::new(Vec::new()), true);
        let mut protocol = LiveProtocol::new(&req);
        let usage = protocol.ingest(r#"{"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"last":{"inputTokens":100,"outputTokens":5}}}}"#, &mut input);
        assert_eq!(
            serde_json::from_str::<Value>(&usage[0]).unwrap()["type"],
            "usage.updated"
        );
        let reasoning = protocol.ingest(r#"{"method":"item/reasoning/textDelta","params":{"itemId":"thinking","delta":"private reasoning"}}"#, &mut input);
        let event: Value = serde_json::from_str(&reasoning[0]).unwrap();
        assert_eq!(event["item"]["type"], "reasoning");
        assert!(!reasoning[0].contains("private reasoning"));
        assert!(input.writer.is_some());
    }
    #[test]
    fn codex_skill_inputs_are_explicit_and_cannot_be_injected_by_frontend_paths() {
        let mut request = super::super::tests::request("codex");
        request.prompt = "Use $review for this task".into();
        request.skills = vec![crate::agent_catalog::SkillReference {
            name: "review".into(),
            path: "C:/Skills/review/SKILL.md".into(),
        }];
        let input = codex_input(&request).unwrap();
        assert_eq!(
            input[1],
            json!({"type":"skill", "name":"review", "path":"C:/Skills/review/SKILL.md"})
        );
        let deserialized: ChatTurnRequest = serde_json::from_value(json!({"sessionId":"session", "turnId":"turn", "runnerType":"codex", "workdir":"C:/Projects/test", "prompt":"Task", "skills":[{"name":"forged", "path":"C:/private.txt"}]})).unwrap();
        assert!(deserialized.skills.is_empty());
        assert_eq!(
            codex_input(&deserialized)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
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
    fn written(bytes: &Arc<Mutex<Vec<u8>>>) -> String {
        String::from_utf8(bytes.lock().unwrap().clone()).unwrap()
    }

    struct BlockedSink {
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }
    impl Write for BlockedSink {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let _ = self.started.send(());
            self.release
                .recv()
                .map_err(|_| std::io::ErrorKind::BrokenPipe)?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn blocked_stdin_does_not_block_large_additions_or_native_output() {
        let mut req = super::super::tests::request("codex");
        req.prompt = "ação 🦀\n".repeat(30_000);
        super::super::validate_request(&req).unwrap();
        let (started, writing) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let input = Arc::new(Mutex::new(LiveInput::with_buffered_writer(
            BlockedSink {
                started,
                release: released,
            },
            true,
        )));
        {
            let mut input = input.lock().unwrap();
            input.thread = Some("thread".into());
            input.turn = Some("native-turn".into());
            input.started = true;
        }
        let (done, completed) = mpsc::channel();
        let control = input.clone();
        std::thread::spawn(move || {
            let result = control
                .lock()
                .unwrap()
                .submit(&req, "large-addition")
                .map(str::to_owned);
            let _ = done.send(result);
        });
        // Always release the fake pipe before asserting so a failing test does
        // not strand a blocked writer or poison later tests.
        let result = completed.recv_timeout(std::time::Duration::from_secs(2));
        let pipe_started = writing.recv_timeout(std::time::Duration::from_secs(2));
        let mut protocol = LiveProtocol::new(&super::super::tests::request("codex"));
        let output = input.try_lock().map(|mut input| protocol.ingest(
            r#"{"method":"item/agentMessage/delta","params":{"threadId":"thread","itemId":"answer","delta":"still running"}}"#,
            &mut input,
        ));
        let _ = release.send(());
        assert_eq!(result.unwrap().unwrap(), "sending");
        assert!(pipe_started.is_ok());
        assert!(output
            .unwrap()
            .iter()
            .any(|line| line.contains("still running")));
    }

    #[test]
    fn large_unicode_steer_is_exact_and_only_delivered_on_provider_ack() {
        let mut req = super::super::tests::request("codex");
        req.prompt = "á🦀".repeat(super::super::MAX_PROMPT_BYTES / 6);
        super::super::validate_request(&req).unwrap();
        let bytes = Arc::new(Mutex::new(vec![]));
        let mut input = LiveInput::with_writer(Box::new(Sink(bytes.clone())), true);
        input.thread = Some("native-thread".into());
        input.turn = Some("native-turn".into());
        assert_eq!(input.submit(&req, "large-input").unwrap(), "sending");
        assert_eq!(input.pending.len(), 1);
        let record: Value = serde_json::from_str(written(&bytes).trim()).unwrap();
        assert_eq!(record["params"]["input"][0]["text"], req.prompt);
        assert_eq!(record["params"]["expectedTurnId"], "native-turn");
        let mut protocol = LiveProtocol::new(&req);
        let ack = protocol.ingest(
            r#"{"id":101,"result":{"turnId":"native-turn"}}"#,
            &mut input,
        );
        assert!(ack.iter().any(|line| line.contains("accepted")));
        assert!(input.pending.is_empty());
        req.prompt.push('🦀');
        let error = super::super::validate_request(&req).unwrap_err();
        assert!(error.contains(&req.prompt.len().to_string()));
        assert!(error.contains("2 MiB"));
    }

    #[test]
    fn completion_before_initial_ack_keeps_queued_input_and_never_resurrects_old_turn() {
        let req = super::super::tests::request("codex");
        let bytes = Arc::new(Mutex::new(vec![]));
        let mut input = LiveInput::with_writer(Box::new(Sink(bytes.clone())), true);
        let mut protocol = LiveProtocol::new(&req);
        protocol.ingest(r#"{"id":1,"result":{}}"#, &mut input);
        protocol.ingest(
            r#"{"id":2,"result":{"thread":{"id":"thread"}}}"#,
            &mut input,
        );
        input.submit(&req, "queued-addition").unwrap();
        protocol.ingest(
            r#"{"method":"turn/started","params":{"threadId":"thread","turn":{"id":"first"}}}"#,
            &mut input,
        );
        protocol.ingest(r#"{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"first","status":"completed"}}}"#, &mut input);
        assert!(input.initial_pending);
        assert!(input.writer.is_some());
        assert!(input.pending.is_empty());
        protocol.ingest(r#"{"id":3,"result":{"turn":{"id":"first"}}}"#, &mut input);
        assert!(input.turn.is_none());
        assert_eq!(protocol.phase(), ProtocolPhase::StartingTurn);
        assert!(input.queued.is_empty());
        let records: Vec<Value> = written(&bytes)
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            records
                .iter()
                .filter(|record| record["method"] == "turn/start")
                .count(),
            2
        );
        assert!(!records
            .iter()
            .any(|record| record["method"] == "turn/steer"));
    }

    #[test]
    fn late_native_acks_preserve_successful_completion_and_close_transport() {
        for initial in [false, true] {
            let req = super::super::tests::request("codex");
            let mut input = LiveInput::with_writer(Box::new(Vec::new()), true);
            let mut protocol = LiveProtocol::new(&req);
            let mut evidence = crate::notification::completion::CompletionEvidence::default();
            if initial {
                protocol.ingest(r#"{"id":1,"result":{}}"#, &mut input);
                protocol.ingest(
                    r#"{"id":2,"result":{"thread":{"id":"thread"}}}"#,
                    &mut input,
                );
            } else {
                input.thread = Some("thread".into());
                input.turn = Some("native-turn".into());
                input.started = true;
                input.submit(&req, "addition").unwrap();
            }
            protocol.ingest(r#"{"method":"turn/started","params":{"threadId":"thread","turn":{"id":"native-turn"}}}"#, &mut input);
            for line in protocol.ingest(r#"{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"native-turn","status":"completed"}}}"#, &mut input) {
                evidence.observe(&serde_json::from_str::<Value>(&line).unwrap());
            }
            assert!(!input.completion_drained());
            let ack = if initial {
                json!({"id":3,"result":{"turn":{"id":"native-turn"}}})
            } else {
                json!({"id":101,"result":{"turnId":"native-turn"}})
            };
            for line in protocol.ingest(&ack.to_string(), &mut input) {
                evidence.observe(&serde_json::from_str::<Value>(&line).unwrap());
            }
            assert!(input.turn.is_none());
            assert!(input.completion_drained());
            assert!(evidence.confirmed(true, input.completion_drained(), false));
        }
    }

    #[test]
    fn buffered_writer_failures_are_visible_without_more_provider_output() {
        struct BrokenSink;
        impl Write for BrokenSink {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut input = LiveInput::with_buffered_writer(BrokenSink, true);
        input.initialize().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while input.transport_error().is_none() && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert!(input.transport_error().unwrap().contains("unconfirmed"));
        assert!(input.initialize().is_err());
    }
    #[test]
    fn resuming_large_threads_excludes_turn_payloads_without_changing_the_native_id() {
        for resumed in [false, true] {
            let mut req = super::super::tests::request("codex");
            req.provider_session_id = resumed.then(|| "large-native-thread".into());
            let bytes = Arc::new(Mutex::new(vec![]));
            let mut input = LiveInput::with_writer(Box::new(Sink(bytes.clone())), true);
            let mut protocol = LiveProtocol::new(&req);
            protocol.ingest(r#"{"id":1,"result":{}}"#, &mut input);
            let text = written(&bytes);
            let rpc: Value = serde_json::from_str(text.lines().last().unwrap()).unwrap();
            if resumed {
                assert_eq!(rpc["method"], "thread/resume");
                assert_eq!(rpc["params"]["threadId"], "large-native-thread");
                assert_eq!(rpc["params"]["excludeTurns"], true);
            } else {
                assert!(rpc["params"].get("excludeTurns").is_none());
            }
            assert_eq!(protocol.phase(), ProtocolPhase::LoadingThread);
        }
    }

    #[test]
    fn claude_startup_and_compaction_have_separate_deadlines() {
        for compacting in [false, true] {
            let mut req = super::super::tests::request("claude-code");
            req.provider_session_id = Some("existing".into());
            req.compact_before_turn = compacting;
            let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
            let mut protocol = LiveProtocol::new(&req);
            assert_eq!(
                protocol.phase(),
                if compacting {
                    ProtocolPhase::Initializing
                } else {
                    ProtocolPhase::StartingTurn
                }
            );
            protocol.ingest(
                r#"{"type":"system","subtype":"init","model":"claude-main"}"#,
                &mut input,
            );
            assert_eq!(
                protocol.phase(),
                if compacting {
                    ProtocolPhase::Compacting
                } else {
                    ProtocolPhase::Running
                }
            );
        }
    }

    #[test]
    fn native_retry_never_replays_the_request_or_fails_an_active_turn() {
        let req = super::super::tests::request("codex");
        let bytes = Arc::new(Mutex::new(vec![]));
        let mut input = LiveInput::with_writer(Box::new(Sink(bytes.clone())), true);
        let mut protocol = LiveProtocol::new(&req);
        protocol.ingest(
            r#"{"id":2,"result":{"thread":{"id":"native-thread"}}}"#,
            &mut input,
        );
        assert_eq!(protocol.phase(), ProtocolPhase::StartingTurn);
        protocol.ingest(
            r#"{"id":3,"result":{"turn":{"id":"native-turn"}}}"#,
            &mut input,
        );
        let before = written(&bytes);
        let records = protocol.ingest(r#"{"method":"error","params":{"threadId":"native-thread","willRetry":true,"error":{"message":"Connection lost"}}}"#, &mut input);
        let mut parser = super::super::protocol::ChatParser::new("session".into(), "turn".into());
        let events = parser.parse("codex", &records[0]);
        assert_eq!(events[0].status.as_deref(), Some("reconnecting"));
        assert!(!parser.failed);
        assert_eq!(written(&bytes), before);
        assert_eq!(input.thread.as_deref(), Some("native-thread"));
        assert_eq!(input.turn.as_deref(), Some("native-turn"));
        assert!(input.writer.is_some());
        assert_eq!(protocol.phase(), ProtocolPhase::Running);
        let records = protocol.ingest(r#"{"method":"error","params":{"threadId":"native-thread","willRetry":false,"error":{"message":"Permanent connection failure"}}}"#, &mut input);
        parser.parse("codex", &records[0]);
        assert!(parser.failed);
    }

    #[test]
    fn retries_and_unrelated_notifications_do_not_count_as_compaction_progress() {
        let mut req = super::super::tests::request("codex");
        req.provider_session_id = Some("native-thread".into());
        req.compact_before_turn = true;
        let bytes = Arc::new(Mutex::new(vec![]));
        let mut input = LiveInput::with_writer(Box::new(Sink(bytes.clone())), true);
        let mut protocol = LiveProtocol::new(&req);
        protocol.ingest(
            r#"{"id":2,"result":{"thread":{"id":"native-thread"}}}"#,
            &mut input,
        );
        let initial = written(&bytes);
        let records = protocol.ingest(r#"{"method":"error","params":{"threadId":"native-thread","willRetry":true,"error":{"message":"Retrying"}}}"#, &mut input);
        assert!(records[0].contains("reconnecting"));
        assert_eq!(protocol.progress_revision(), 0);
        protocol.ingest(r#"{"method":"thread/tokenUsage/updated","params":{"threadId":"other-thread","tokenUsage":{"last":{"inputTokens":123}}}}"#, &mut input);
        protocol.ingest(
            r#"{"method":"mcpServer/statusUpdated","params":{"status":"starting"}}"#,
            &mut input,
        );
        assert_eq!(protocol.progress_revision(), 0);
        assert_eq!(written(&bytes), initial);
        assert_eq!(protocol.phase(), ProtocolPhase::Compacting);
        assert!(input.writer.is_some());
        protocol.ingest(r#"{"method":"item/reasoning/textDelta","params":{"threadId":"native-thread","itemId":"c","delta":"Working"}}"#, &mut input);
        assert_eq!(protocol.progress_revision(), 1);
        let usage = r#"{"method":"thread/tokenUsage/updated","params":{"threadId":"native-thread","tokenUsage":{"last":{"inputTokens":123}}}}"#;
        protocol.ingest(usage, &mut input);
        assert_eq!(protocol.progress_revision(), 2);
        protocol.ingest(usage, &mut input);
        assert_eq!(protocol.progress_revision(), 2);
    }

    #[test]
    fn context_updates_include_the_providers_actual_model_window() {
        let req = super::super::tests::request("codex");
        let mut input = LiveInput::with_writer(Box::new(Vec::new()), true);
        let mut protocol = LiveProtocol::new(&req);
        let records = protocol.ingest(r#"{"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"last":{"inputTokens":320000,"outputTokens":10000},"modelContextWindow":400000}}}"#, &mut input);
        let record: Value = serde_json::from_str(&records[0]).unwrap();
        assert_eq!(record["context_tokens"], 330000);
        assert_eq!(record["context_window"], 400000);
        let mut req = req;
        req.provider_session_id = Some("existing".into());
        req.compact_before_turn = true;
        let mut protocol = LiveProtocol::new(&req);
        let records = protocol.ingest(r#"{"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"last":{"inputTokens":320000,"outputTokens":10000},"modelContextWindow":400000}}}"#, &mut input);
        let record: Value = serde_json::from_str(&records[0]).unwrap();
        assert_eq!(record["type"], "agentdeck.context-window");
        assert_eq!(record["context_window"], 400000);
    }

    #[test]
    fn stopping_transport_distinguishes_unsent_and_unconfirmed_additional_input() {
        let req = super::super::tests::request("codex");
        let bytes = Arc::new(Mutex::new(vec![]));
        let mut input = LiveInput::with_writer(Box::new(Sink(bytes.clone())), true);
        input.submit(&req, "unsent").unwrap();
        input.thread = Some("native-thread".into());
        input.turn = Some("native-turn".into());
        input.submit(&req, "unconfirmed").unwrap();
        let before = written(&bytes);
        let results = input.abort();
        assert!(results
            .iter()
            .any(|(id, text)| id == "unsent" && text.contains("not sent")));
        assert!(results
            .iter()
            .any(|(id, text)| id == "unconfirmed" && text.contains("before sending it again")));
        assert_eq!(written(&bytes), before);
        assert!(input.writer.is_none());
        assert!(input.queued.is_empty());
        assert!(input.pending.is_empty());
        assert_eq!(input.thread.as_deref(), Some("native-thread"));
    }

    #[test]
    fn codex_compaction_waits_for_confirmed_idle_turn_before_sending_original_input() {
        let mut req = super::super::tests::request("codex");
        req.provider_session_id = Some("existing".into());
        req.compact_before_turn = true;
        let bytes = Arc::new(Mutex::new(vec![]));
        let mut input = LiveInput::with_writer(Box::new(Sink(bytes.clone())), true);
        let mut protocol = LiveProtocol::new(&req);
        protocol.ingest(r#"{"id":1,"result":{}}"#, &mut input);
        protocol.ingest(
            r#"{"id":2,"result":{"thread":{"id":"existing"}}}"#,
            &mut input,
        );
        assert!(written(&bytes).contains("thread/compact/start"));
        assert!(!written(&bytes).contains("turn/start"));
        protocol.ingest(r#"{"id":4,"result":{}}"#, &mut input);
        assert!(!written(&bytes).contains("turn/start"));
        let addition = super::super::tests::request("codex");
        assert_eq!(input.submit(&addition, "extra").unwrap(), "queued");
        protocol.ingest(
            r#"{"method":"turn/started","params":{"threadId":"existing","turn":{"id":"compact"}}}"#,
            &mut input,
        );
        protocol.ingest(r#"{"method":"item/completed","params":{"threadId":"existing","item":{"id":"c","type":"contextCompaction"}}}"#, &mut input);
        assert!(!written(&bytes).contains("turn/start"));
        let records=protocol.ingest(r#"{"method":"turn/completed","params":{"threadId":"existing","turn":{"id":"compact","status":"completed"}}}"#, &mut input);
        assert!(records
            .iter()
            .any(|r| r.contains("context_compacted") && r.contains("before_turn")));
        assert_eq!(
            written(&bytes).matches("\"method\":\"turn/start\"").count(),
            1
        );
        assert!(written(&bytes).contains("untrusted"));
        assert!(!protocol.compacting());
        protocol.ingest(r#"{"id":3,"result":{"turn":{"id":"actual"}}}"#, &mut input);
        assert!(written(&bytes).contains("turn/steer"));
    }
    #[test]
    fn codex_compaction_failures_do_not_deliver_or_reset_the_pending_request() {
        for failure in [
            r#"{"id":4,"error":{"message":"Method not found"}}"#,
            r#"{"method":"turn/completed","params":{"turn":{"id":"compact","status":"completed"}}}"#,
            r#"{"method":"turn/completed","params":{"turn":{"id":"compact","status":"failed"}}}"#,
        ] {
            let mut req = super::super::tests::request("codex");
            req.provider_session_id = Some("existing".into());
            req.compact_before_turn = true;
            let bytes = Arc::new(Mutex::new(vec![]));
            let mut input = LiveInput::with_writer(Box::new(Sink(bytes.clone())), true);
            let mut protocol = LiveProtocol::new(&req);
            protocol.ingest(
                r#"{"id":2,"result":{"thread":{"id":"existing"}}}"#,
                &mut input,
            );
            protocol.ingest(
                r#"{"method":"turn/started","params":{"turn":{"id":"compact"}}}"#,
                &mut input,
            );
            let records = protocol.ingest(failure, &mut input);
            assert!(records.iter().any(|r| r.contains("error")));
            assert!(!written(&bytes).contains("turn/start"));
            assert!(input.writer.is_none());
        }
    }
    #[test]
    fn fresh_threads_do_not_attempt_to_compact_empty_context() {
        for provider in ["codex", "claude-code"] {
            let mut req = super::super::tests::request(provider);
            req.compact_before_turn = true;
            assert!(!LiveProtocol::new(&req).compacting());
            assert_eq!(initial_input(&req).unwrap(), build_input(&req).unwrap());
        }
    }
    #[test]
    fn claude_compacts_without_attachments_and_delivers_actual_and_queued_inputs_after_boundary() {
        let mut req = super::super::tests::request("claude-code");
        req.provider_session_id = Some("existing".into());
        req.compact_before_turn = true;
        assert!(initial_input(&req).unwrap().contains("/compact"));
        assert!(!initial_input(&req).unwrap().contains("untrusted"));
        let bytes = Arc::new(Mutex::new(vec![]));
        let mut input = LiveInput::with_writer(Box::new(Sink(bytes.clone())), false);
        input.compacting = true;
        let mut protocol = LiveProtocol::new(&req);
        let mut extra = req.clone();
        extra.prompt = "Queued instruction".into();
        input.submit(&extra, "extra").unwrap();
        assert!(written(&bytes).is_empty());
        protocol.ingest(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Summary"}]}}"#,
            &mut input,
        );
        protocol.ingest(
            r#"{"type":"system","subtype":"compact_boundary"}"#,
            &mut input,
        );
        assert!(written(&bytes).is_empty());
        let events=protocol.ingest(r#"{"type":"result","uuid":"compact-result","is_error":false,"usage":{"input_tokens":100,"output_tokens":20}}"#,&mut input);
        assert!(events.iter().any(|r| r.contains("context_compacted")));
        assert!(written(&bytes).contains("untrusted"));
        assert!(written(&bytes).contains("Queued instruction"));
        assert_eq!(input.claude_pending, 2);
        let events=protocol.ingest(r#"{"type":"result","uuid":"actual-result","usage":{"input_tokens":30,"output_tokens":10}}"#,&mut input);
        assert!(events.iter().any(|r| r.contains("\"input_tokens\":130")));
        assert!(input.writer.is_some());
    }
    #[test]
    fn claude_success_without_compaction_boundary_is_not_confirmation() {
        let mut req = super::super::tests::request("claude-code");
        req.provider_session_id = Some("existing".into());
        req.compact_before_turn = true;
        let bytes = Arc::new(Mutex::new(vec![]));
        let mut input = LiveInput::with_writer(Box::new(Sink(bytes.clone())), false);
        let mut protocol = LiveProtocol::new(&req);
        let events = protocol.ingest(
            r#"{"type":"result","is_error":false,"result":"Not enough messages to compact."}"#,
            &mut input,
        );
        assert!(events.iter().any(|r| r.contains("not confirmed")));
        assert!(written(&bytes).is_empty());
        assert!(input.writer.is_none());
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
        assert_eq!(protocol.phase(), ProtocolPhase::StartingTurn);
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
        assert_eq!(protocol.phase(), ProtocolPhase::Running);
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
            &json!({"type":"result","uuid":"second","user_message_uuid":"addition","usage":{"input_tokens":20,"output_tokens":4}})
                .to_string(),
            &mut input,
        );
        assert!(input.writer.is_none());
        assert!(final_record
            .iter()
            .any(|line| line.contains("agentdeck.input")));
        let value: Value = serde_json::from_str(final_record.last().unwrap()).unwrap();
        assert_eq!(value["usage"]["input_tokens"], 30);
        assert_eq!(value["usage"]["output_tokens"], 7);
    }
}
