use super::*;
use serde_json::json;

#[test]
fn chat_notifies_once_after_success_and_allows_the_next_turn() {
    let mut state = CompletionRegistry::default();
    assert!(!state.chat_completed("session", "turn", "Implement the change", false));
    assert!(state.chat_completed("session", "turn", "Implement the change", true));
    assert!(!state.chat_completed("session", "turn", "Implement the change", true));
    assert!(state.chat_completed("session", "next-turn", "Review the change", true));
    assert!(state.chat_completed("other-session", "turn", "Another project", true));
    assert!(!state.chat_completed(
        "session",
        "compact-turn",
        "/compact preserve decisions",
        true
    ));
}

#[test]
fn terminal_startup_progress_duplicate_stop_and_cancel_are_silent() {
    let mut state = CompletionRegistry::default();
    state.reset("session");
    assert!(!state.terminal_completed("session", None, None));
    state.begin("session", Some("Implement the change"));
    assert!(state.terminal_completed("session", None, None));
    assert!(!state.terminal_completed("session", None, None));
    state.begin("session", Some("Second task"));
    state.stop("session");
    assert!(!state.terminal_completed("session", None, None));
    assert!(!state.terminal_completed("session", Some("cancelled-native-turn"), None));
    assert!(!state.terminal_completed(
        "session",
        Some("cancelled-native-turn"),
        Some("Second task")
    ));
    state.begin("session", Some("Third task"));
    assert!(state.terminal_completed("session", None, None));
    state.begin("session", Some(" /compact preserve decisions"));
    assert!(!state.terminal_completed("session", Some("compact-native-turn"), None));
    state.begin("session", Some("Continue"));
    assert!(state.terminal_completed("session", None, None));
    state.terminals.remove("session");
    assert!(!state.terminal_completed("session", Some("late-exit-hook"), None));
    state.reset("session");
    state.begin("session", Some("Resumed process"));
    assert!(state.terminal_completed("session", None, None));
}

#[test]
fn native_codex_turn_ids_deduplicate_terminal_input_outside_the_app_form() {
    let mut state = CompletionRegistry::default();
    state.reset("session");
    assert!(state.terminal_completed("session", Some("thread:turn-1"), None));
    assert!(!state.terminal_completed("session", Some("thread:turn-1"), None));
    assert!(state.terminal_completed("session", Some("thread:turn-2"), None));
    assert!(!state.terminal_completed("session", None, None));
    state.begin("session", Some("/compact"));
    assert!(!state.terminal_completed("session", Some("thread:compact"), Some("/compact")));
    assert!(state.terminal_completed(
        "session",
        Some("thread:after-compact"),
        Some("Continue working")
    ));
    assert!(!state.terminal_completed(
        "session",
        Some("thread:after-compact"),
        Some("Continue working")
    ));
}

#[test]
fn progress_tools_compaction_and_subagent_results_do_not_confirm_completion() {
    let mut evidence = CompletionEvidence::default();
    for record in [
        json!({"type":"item.completed","item":{"type":"command_execution","status":"completed"}}),
        json!({"type":"item.completed","item":{"type":"agent_message","text":"Intermediate update"}}),
        json!({"type":"context_compacted"}),
        json!({"type":"usage.updated"}),
        json!({"type":"result","is_error":false,"parent_tool_use_id":"child"}),
    ] {
        evidence.observe(&record);
        assert!(!evidence.confirmed(true, true, false), "{record}");
    }
    evidence.observe(&json!({"type":"result","is_error":false,"subtype":"success"}));
    assert!(evidence.confirmed(true, true, false));
    assert!(!evidence.confirmed(false, true, false));
    assert!(!evidence.confirmed(true, false, false));
    assert!(!evidence.confirmed(true, true, true));
    evidence.observe(&json!({"type":"agentdeck.input","status":"accepted"}));
    assert!(!evidence.confirmed(true, true, false));
    evidence.observe(&json!({"type":"result","is_error":false,"subtype":"success"}));
    assert!(evidence.confirmed(true, true, false));
}

#[test]
fn interrupted_and_failed_provider_boundaries_do_not_announce_success() {
    let mut evidence = CompletionEvidence::default();
    for status in ["interrupted", "failed", "cancelled", "inProgress", ""] {
        evidence.observe(&json!({"type":"turn.completed","status":status}));
        assert!(!evidence.confirmed(true, true, false));
    }
    evidence.observe(&json!({"type":"turn.completed","status":"completed"}));
    assert!(evidence.confirmed(true, true, false));
    evidence.observe(&json!({"type":"error","message":"late failure"}));
    assert!(!evidence.confirmed(true, true, false));
    evidence.observe(&json!({"type":"result","is_error":true}));
    assert!(!evidence.confirmed(true, true, false));
}

#[test]
fn completion_history_remains_bounded() {
    let mut state = CompletionRegistry::default();
    for turn in 0..2000 {
        assert!(state.chat_completed("session", &turn.to_string(), "Task", true));
    }
    assert_eq!(state.order.len(), 1024);
    assert_eq!(state.sent.len(), 1024);
    assert!(!state.chat_completed("session", "1999", "Task", true));
}
