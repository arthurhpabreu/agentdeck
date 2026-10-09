//! Completion notifications are driven by provider boundaries, never terminal text.
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

#[derive(Default)]
struct TerminalTurn {
    generation: u64,
    running: bool,
    blocked: bool,
    compacting: bool,
}

#[derive(Default)]
struct CompletionRegistry {
    terminals: HashMap<String, TerminalTurn>,
    sent: HashSet<String>,
    order: VecDeque<String>,
    next_generation: u64,
}

fn is_compaction(prompt: &str) -> bool {
    prompt
        .split_whitespace()
        .next()
        .is_some_and(|word| word.eq_ignore_ascii_case("/compact"))
}

impl CompletionRegistry {
    fn remember(&mut self, key: String) -> bool {
        if !self.sent.insert(key.clone()) {
            return false;
        }
        self.order.push_back(key);
        while self.order.len() > 1024 {
            if let Some(oldest) = self.order.pop_front() {
                self.sent.remove(&oldest);
            }
        }
        true
    }

    fn reset(&mut self, session: &str) {
        // Session IDs are unique. Keeping only active/recent terminals bounds memory.
        if self.terminals.len() >= 256 && !self.terminals.contains_key(session) {
            if let Some(idle) = self
                .terminals
                .iter()
                .find(|(_, turn)| !turn.running)
                .map(|(id, _)| id.clone())
            {
                self.terminals.remove(&idle);
            }
        }
        self.terminals
            .insert(session.into(), TerminalTurn::default());
    }

    fn begin(&mut self, session: &str, prompt: Option<&str>) {
        self.next_generation += 1;
        let turn = self.terminals.entry(session.into()).or_default();
        turn.generation = self.next_generation;
        turn.running = true;
        turn.blocked = false;
        turn.compacting = prompt.is_some_and(is_compaction);
    }

    fn stop(&mut self, session: &str) {
        if let Some(turn) = self.terminals.get_mut(session) {
            turn.running = false;
            turn.blocked = true;
        }
    }

    fn terminal_completed(
        &mut self,
        session: &str,
        provider_turn: Option<&str>,
        prompt: Option<&str>,
    ) -> bool {
        let Some(turn) = self.terminals.get_mut(session) else {
            return false;
        };
        // Codex notify includes the submitted prompt. This re-arms direct TUI
        // input after /compact even without a UserPromptSubmit bridge.
        if provider_turn.is_some() && prompt.is_some_and(|value| !value.trim().is_empty()) {
            turn.compacting = prompt.is_some_and(is_compaction);
        }
        // Windows Codex's notify callback supplies a native turn ID even when
        // the prompt was entered directly in its TUI, outside our input form.
        if turn.blocked || turn.compacting || (!turn.running && provider_turn.is_none()) {
            return false;
        }
        let key = provider_turn
            .map(|id| format!("pty:{session}:turn:{id}"))
            .unwrap_or_else(|| format!("pty:{session}:generation:{}", turn.generation));
        turn.running = false;
        self.remember(key)
    }

    fn chat_completed(&mut self, session: &str, turn: &str, prompt: &str, confirmed: bool) -> bool {
        confirmed && !is_compaction(prompt) && self.remember(format!("chat:{session}:{turn}"))
    }
}

static REGISTRY: OnceLock<Mutex<CompletionRegistry>> = OnceLock::new();
fn registry() -> &'static Mutex<CompletionRegistry> {
    REGISTRY.get_or_init(Default::default)
}

pub(crate) fn reset_terminal(session: &str, prompt: Option<&str>) {
    if let Ok(mut state) = registry().lock() {
        state.reset(session);
        if let Some(prompt) = prompt.filter(|prompt| !prompt.trim().is_empty()) {
            state.begin(session, Some(prompt));
        }
    }
}
pub(crate) fn begin_terminal(session: &str, prompt: Option<&str>) {
    if let Ok(mut state) = registry().lock() {
        state.begin(session, prompt);
    }
}
pub(crate) fn stop_terminal(session: &str) {
    if let Ok(mut state) = registry().lock() {
        state.stop(session);
    }
}
pub(crate) fn forget_terminal(session: &str) {
    if let Ok(mut state) = registry().lock() {
        state.terminals.remove(session);
    }
}

fn show_completion(app: &tauri::AppHandle, session: &str) {
    let locale = crate::i18n::current_locale(&app.state::<crate::i18n::LocaleState>());
    let body = match locale {
        crate::i18n::AppLocale::PtBr => {
            "Resposta concluída. O agente está aguardando sua próxima mensagem."
        }
        crate::i18n::AppLocale::EsEs => {
            "Respuesta completada. El agente espera tu siguiente mensaje."
        }
        crate::i18n::AppLocale::EnUs => {
            "Response complete. The agent is waiting for your next message."
        }
    };
    let _ = super::send_notification_with_callback(
        app.clone(),
        "Agentdeck".into(),
        body.into(),
        None,
        Some(true),
        Some(session.into()),
    );
    crate::telegram_notifications::dispatch_completion(app, body);
}

pub(crate) fn terminal_completed(
    app: &tauri::AppHandle,
    session: &str,
    turn: Option<&str>,
    prompt: Option<&str>,
) {
    if !crate::integration_control::notifications_and_hooks_enabled(app)
        || crate::chat::is_session_running(app, session)
    {
        return;
    }
    let notify = registry()
        .lock()
        .map(|mut state| state.terminal_completed(session, turn, prompt))
        .unwrap_or(false);
    if notify {
        show_completion(app, session);
    }
}

pub(crate) fn chat_completed(
    app: &tauri::AppHandle,
    session: &str,
    turn: &str,
    prompt: &str,
    confirmed: bool,
) {
    if !crate::integration_control::notifications_and_hooks_enabled(app) {
        return;
    }
    let notify = registry()
        .lock()
        .map(|mut state| state.chat_completed(session, turn, prompt, confirmed))
        .unwrap_or(false);
    if notify {
        show_completion(app, session);
    }
}

/// Only top-level, successful provider results establish completion evidence.
#[derive(Default)]
pub(crate) struct CompletionEvidence {
    confirmed: bool,
}
impl CompletionEvidence {
    pub(crate) fn observe(&mut self, record: &Value) {
        if is_child_event(record) {
            return;
        }
        match record["type"].as_str().unwrap_or("") {
            "turn.started"
            | "agentdeck.initial-delivered"
            | "agentdeck.input"
            | "error"
            | "turn.failed" => self.confirmed = false,
            "turn.completed" => self.confirmed = record["status"] == "completed",
            "result" => {
                self.confirmed = record["is_error"] == false
                    && record["subtype"]
                        .as_str()
                        .is_none_or(|value| value == "success")
            }
            _ => {}
        }
    }
    pub(crate) fn confirmed(
        &self,
        successful_exit: bool,
        input_drained: bool,
        compacting: bool,
    ) -> bool {
        self.confirmed && successful_exit && input_drained && !compacting
    }
}

pub(crate) fn is_child_event(record: &Value) -> bool {
    [
        "parent_tool_use_id",
        "parentThreadId",
        "parent_thread_id",
        "parent_session_id",
        "agent_id",
        "subagent_id",
    ]
    .iter()
    .any(|field| {
        record[*field]
            .as_str()
            .is_some_and(|value| !value.trim().is_empty())
    }) || record["is_subagent"] == true
}

#[cfg(test)]
#[path = "completion_notification_tests.rs"]
mod tests;
