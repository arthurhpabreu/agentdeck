use super::*;
use crate::notification::completion::CompletionEvidence;

fn observe(evidence: &mut CompletionEvidence, records: Vec<String>) {
    for line in records {
        evidence.observe(&serde_json::from_str::<Value>(&line).unwrap());
    }
}

#[test]
fn codex_protocol_only_confirms_a_successful_top_level_completion() {
    for status in ["completed", "interrupted", "failed"] {
        let request = super::super::tests::request("codex");
        let mut input = LiveInput::with_writer(Box::new(Vec::new()), true);
        input.thread = Some("main-thread".into());
        input.turn = Some("main-turn".into());
        input.started = true;
        let mut protocol = LiveProtocol::new(&request);
        let mut evidence = CompletionEvidence::default();
        observe(&mut evidence, protocol.ingest(
            &json!({"method":"turn/completed","params":{"threadId":"child-thread","turn":{"id":"child-turn","status":"completed"}}}).to_string(),
            &mut input,
        ));
        assert!(!evidence.confirmed(true, input.completion_drained(), protocol.compacting()));
        observe(&mut evidence, protocol.ingest(
            &json!({"method":"item/completed","params":{"threadId":"main-thread","item":{"id":"tool","type":"commandExecution","status":"completed","command":"cargo test"}}}).to_string(),
            &mut input,
        ));
        assert!(!evidence.confirmed(true, input.completion_drained(), protocol.compacting()));
        observe(&mut evidence, protocol.ingest(
            &json!({"method":"turn/completed","params":{"threadId":"main-thread","turn":{"id":"main-turn","status":status}}}).to_string(),
            &mut input,
        ));
        assert!(input.completion_drained());
        assert_eq!(
            evidence.confirmed(true, input.completion_drained(), protocol.compacting()),
            status == "completed"
        );
    }
}

#[test]
fn claude_notifications_wait_for_additional_messages_and_ignore_child_results() {
    let request = super::super::tests::request("claude-code");
    let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
    let mut protocol = LiveProtocol::new(&request);
    let mut evidence = CompletionEvidence::default();
    input.submit(&request, "additional-input").unwrap();
    observe(&mut evidence, protocol.ingest(
        &json!({"type":"result","uuid":"child","parent_tool_use_id":"tool","is_error":false,"subtype":"success"}).to_string(),
        &mut input,
    ));
    assert_eq!(input.claude_pending, 2);
    assert!(!evidence.confirmed(true, input.completion_drained(), false));
    let first =
        json!({"type":"result","uuid":"first","is_error":false,"subtype":"success"}).to_string();
    observe(&mut evidence, protocol.ingest(&first, &mut input));
    observe(&mut evidence, protocol.ingest(&first, &mut input));
    assert_eq!(input.claude_pending, 1);
    assert!(!evidence.confirmed(true, input.completion_drained(), false));
    observe(
        &mut evidence,
        protocol.ingest(
            &json!({"type":"result","uuid":"last","is_error":false,"subtype":"success"})
                .to_string(),
            &mut input,
        ),
    );
    assert!(evidence.confirmed(true, input.completion_drained(), false));
}

#[test]
fn successful_compaction_is_silent_until_the_actual_answer_finishes() {
    let mut request = super::super::tests::request("claude-code");
    request.compact_before_turn = true;
    request.provider_session_id = Some("existing".into());
    let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
    input.compacting = true;
    let mut protocol = LiveProtocol::new(&request);
    let mut evidence = CompletionEvidence::default();
    observe(
        &mut evidence,
        protocol.ingest(
            &json!({"type":"system","subtype":"compact_boundary"}).to_string(),
            &mut input,
        ),
    );
    observe(
        &mut evidence,
        protocol.ingest(
            &json!({"type":"result","uuid":"compact","is_error":false,"subtype":"success"})
                .to_string(),
            &mut input,
        ),
    );
    assert!(!protocol.compacting());
    assert!(!evidence.confirmed(true, input.completion_drained(), protocol.compacting()));
    observe(
        &mut evidence,
        protocol.ingest(
            &json!({"type":"result","uuid":"answer","is_error":false,"subtype":"success"})
                .to_string(),
            &mut input,
        ),
    );
    assert!(evidence.confirmed(true, input.completion_drained(), protocol.compacting()));
}
