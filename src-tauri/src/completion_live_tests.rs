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
            &json!({"type":"result","uuid":"last","is_error":false,"subtype":"success","user_message_uuid":"additional-input"})
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

#[test]
fn claude_background_work_survives_the_first_result_and_stdin_eof_until_process_exit() {
    let request = super::super::tests::request("claude-code");
    let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
    let mut protocol = LiveProtocol::new(&request);
    let mut evidence = CompletionEvidence::default();
    let mut shutdown = super::super::CompletionShutdown::default();

    observe(&mut evidence, protocol.ingest(
        &json!({"type":"system","subtype":"task_started","task_id":"render","task_type":"local_bash","is_backgrounded":true}).to_string(),
        &mut input,
    ));
    observe(&mut evidence, protocol.ingest(
        &json!({"type":"result","uuid":"intermediate","is_error":false,"subtype":"success","result":"The render is running in the background; I will inspect it when it finishes.","usage":{"input_tokens":10,"output_tokens":3}}).to_string(),
        &mut input,
    ));
    // EOF is intentional: Claude natively waits for background work after EOF.
    assert!(input.completion_drained());
    let confirmed = evidence.confirmed(true, input.completion_drained(), protocol.compacting());
    assert!(confirmed);
    for seconds in [0, 9, 10, 30, 600, 3600] {
        assert!(!shutdown.observe(
            "claude-code",
            confirmed && protocol.completion_cleanup_ready(),
            std::time::Duration::from_secs(seconds)
        ));
        assert!(!shutdown.successful_exit(false, false, false));
    }

    // Native notifications and the follow-up answer must still be consumed;
    // the host never submits a synthetic continuation prompt.
    observe(&mut evidence, protocol.ingest(
        &json!({"type":"system","subtype":"task_notification","task_id":"render","status":"completed","summary":"Render finished"}).to_string(),
        &mut input,
    ));
    let answer = protocol.ingest(
        &json!({"type":"assistant","message":{"id":"review","content":[{"type":"text","text":"I inspected the rendered frames."}]}}).to_string(),
        &mut input,
    );
    let mut parser = super::super::protocol::ChatParser::new("session".into(), "turn".into());
    assert!(answer
        .iter()
        .flat_map(|line| parser.parse("claude-code", line))
        .any(|event| event.kind == "text"
            && event.text.as_deref() == Some("I inspected the rendered frames.")));
    let final_records = protocol.ingest(
        &json!({"type":"result","uuid":"final","is_error":false,"subtype":"success","usage":{"input_tokens":20,"output_tokens":4}}).to_string(),
        &mut input,
    );
    let result: Value = serde_json::from_str(&final_records[0]).unwrap();
    assert_eq!(result["usage"]["input_tokens"], 30);
    assert_eq!(result["usage"]["output_tokens"], 7);
    observe(&mut evidence, final_records);
    assert!(!shutdown.successful_exit(false, false, false));
    assert!(shutdown.successful_exit(true, false, false));
    assert!(!shutdown.successful_exit(true, true, false));
    assert!(!shutdown.successful_exit(true, false, true));
    assert!(evidence.confirmed(true, input.completion_drained(), false));
}

fn claude_frame(protocol: &mut LiveProtocol, input: &mut LiveInput, record: Value) -> Vec<String> {
    protocol.ingest(&record.to_string(), input)
}

fn claude_state(protocol: &mut LiveProtocol, input: &mut LiveInput, state: &str) {
    claude_frame(
        protocol,
        input,
        json!({"type":"system","subtype":"session_state_changed","state":state}),
    );
}

#[test]
fn claude_coalesced_result_drains_explicit_input_uuids_once_and_waits_for_native_idle() {
    let request = super::super::tests::request("claude-code");
    let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
    let mut protocol = LiveProtocol::new(&request);
    claude_state(&mut protocol, &mut input, "running");
    input.submit(&request, "first-extra").unwrap();
    input.submit(&request, "second-extra").unwrap();
    let result = json!({"type":"result","uuid":"merged","is_error":false,"subtype":"success","user_message_uuids":["first-extra","second-extra"],"usage":{"input_tokens":12,"output_tokens":4}});
    let records = claude_frame(&mut protocol, &mut input, result.clone());
    assert_eq!(
        records
            .iter()
            .filter(|line| line.contains("agentdeck.input"))
            .count(),
        2
    );
    assert_eq!(input.claude_pending, 0);
    assert!(
        input.writer.is_some(),
        "a result is only a turn boundary while the session is running"
    );
    let duplicate = claude_frame(&mut protocol, &mut input, result);
    assert!(!duplicate
        .iter()
        .any(|line| line.contains("agentdeck.input")));
    assert_eq!(protocol.claude_totals["input_tokens"], 12);
    claude_state(&mut protocol, &mut input, "idle");
    assert!(input.completion_drained());
}

#[test]
fn claude_idle_drains_accepted_coalesced_inputs_but_preserves_inputs_after_the_result() {
    let request = super::super::tests::request("claude-code");
    let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
    let mut protocol = LiveProtocol::new(&request);
    claude_state(&mut protocol, &mut input, "running");
    for id in ["accepted-first", "accepted-second"] {
        input.submit(&request, id).unwrap();
        claude_frame(
            &mut protocol,
            &mut input,
            json!({"type":"user","uuid":id,"message":{"role":"user","content":"extra"}}),
        );
    }
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"result","uuid":"merged","is_error":false}),
    );
    input.submit(&request, "later-unacknowledged").unwrap();
    input.submit(&request, "later-accepted").unwrap();
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"user","uuid":"later-accepted","message":{"role":"user","content":"later"}}),
    );
    claude_state(&mut protocol, &mut input, "idle");
    assert_eq!(input.claude_pending, 2);
    assert!(input.writer.is_some());
    assert!(input.claude_messages.contains_key("later-unacknowledged"));
    assert!(input.claude_messages.contains_key("later-accepted"));
    // A replay of the old result cannot take a newer snapshot or drain new input.
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"result","uuid":"merged","is_error":false}),
    );
    assert_eq!(input.claude_pending, 2);
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"result","uuid":"later","is_error":false,"user_message_uuids":["later-unacknowledged","later-accepted"]}),
    );
    assert!(input.completion_drained());
}

#[test]
fn claude_agent_completion_waits_for_parent_continuation_and_final_idle() {
    let request = super::super::tests::request("claude-code");
    let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
    let mut protocol = LiveProtocol::new(&request);
    claude_state(&mut protocol, &mut input, "running");
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"system","subtype":"task_started","task_id":"review","task_type":"local_agent"}),
    );
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"result","uuid":"intermediate","is_error":false}),
    );
    claude_state(&mut protocol, &mut input, "idle");
    assert!(
        input.writer.is_some(),
        "a tracked agent must retain its control channel"
    );
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"system","subtype":"task_notification","task_id":"review","status":"completed"}),
    );
    claude_state(&mut protocol, &mut input, "idle");
    assert!(
        input.writer.is_some(),
        "notification may schedule a parent continuation"
    );
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"assistant","message":{"content":[{"type":"text","text":"Reviewing the delegated findings"}]}}),
    );
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"result","uuid":"child","parent_tool_use_id":"review","is_error":false}),
    );
    assert!(input.writer.is_some());
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"result","uuid":"final","is_error":false}),
    );
    assert!(input.writer.is_some());
    claude_state(&mut protocol, &mut input, "idle");
    assert!(input.completion_drained());
}

#[test]
fn claude_retry_and_requires_action_do_not_close_streaming_input() {
    let request = super::super::tests::request("claude-code");
    let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
    let mut protocol = LiveProtocol::new(&request);
    claude_state(&mut protocol, &mut input, "running");
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"result","uuid":"intermediate","is_error":false}),
    );
    claude_state(&mut protocol, &mut input, "requires_action");
    assert!(input.writer.is_some());
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"system","subtype":"api_retry","attempt":1}),
    );
    claude_state(&mut protocol, &mut input, "idle");
    assert!(
        input.writer.is_some(),
        "idle cannot reuse completion from before a retry"
    );
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"result","uuid":"final","is_error":false}),
    );
    assert!(input.completion_drained());
}

#[test]
fn claude_compaction_idle_does_not_consume_actual_or_queued_request() {
    let mut request = super::super::tests::request("claude-code");
    request.compact_before_turn = true;
    request.provider_session_id = Some("existing".into());
    let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
    input.compacting = true;
    let mut protocol = LiveProtocol::new(&request);
    input.submit(&request, "queued-extra").unwrap();
    claude_state(&mut protocol, &mut input, "running");
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"system","subtype":"compact_boundary"}),
    );
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"result","uuid":"compact","is_error":false}),
    );
    claude_state(&mut protocol, &mut input, "idle");
    assert_eq!(input.claude_pending, 2);
    assert!(input.writer.is_some());
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"result","uuid":"answer","is_error":false,"user_message_uuids":["queued-extra"]}),
    );
    assert!(input.completion_drained());
}

#[test]
fn claude_idle_preserves_accepted_input_excluded_from_explicit_result_uuids() {
    let request = super::super::tests::request("claude-code");
    let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
    let mut protocol = LiveProtocol::new(&request);
    claude_state(&mut protocol, &mut input, "running");
    for id in ["included", "excluded"] {
        input.submit(&request, id).unwrap();
        claude_frame(
            &mut protocol,
            &mut input,
            json!({"type":"user","uuid":id,"message":{"role":"user","content":"extra"}}),
        );
    }
    let records = claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"result","uuid":"partial","is_error":false,"user_message_uuids":["included"]}),
    );
    assert!(
        !records.iter().any(|line| line.contains("agentdeck.input")),
        "already accepted input is not acknowledged twice"
    );
    claude_state(&mut protocol, &mut input, "idle");
    assert_eq!(input.claude_pending, 1);
    assert!(input.claude_messages.contains_key("excluded"));
    assert!(input.writer.is_some());
}

#[test]
fn claude_terminal_task_patch_requires_another_result_before_idle_closes_input() {
    for terminal in ["completed", "failed", "stopped", "killed"] {
        let request = super::super::tests::request("claude-code");
        let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
        let mut protocol = LiveProtocol::new(&request);
        claude_state(&mut protocol, &mut input, "running");
        claude_frame(
            &mut protocol,
            &mut input,
            json!({"type":"system","subtype":"task_started","task_id":"agent","task_type":"local_workflow"}),
        );
        claude_frame(
            &mut protocol,
            &mut input,
            json!({"type":"result","uuid":"intermediate","is_error":false}),
        );
        claude_frame(
            &mut protocol,
            &mut input,
            json!({"type":"system","subtype":"task_updated","task_id":"agent","patch":{"status":terminal}}),
        );
        claude_state(&mut protocol, &mut input, "idle");
        assert!(protocol.claude_tasks.is_empty());
        assert!(input.writer.is_some());
        claude_frame(
            &mut protocol,
            &mut input,
            json!({"type":"result","uuid":"final","is_error":false}),
        );
        assert!(input.completion_drained());
    }
}

fn claude_init(protocol: &mut LiveProtocol, input: &mut LiveInput, version: &str) {
    claude_frame(
        protocol,
        input,
        json!({"type":"system","subtype":"init","claude_code_version":version}),
    );
    claude_state(protocol, input, "running");
}

#[test]
fn claude_idle_with_no_native_tasks_cleans_only_a_retained_transport_after_grace() {
    let request = super::super::tests::request("claude-code");
    let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
    let mut protocol = LiveProtocol::new(&request);
    let mut shutdown = super::super::CompletionShutdown::default();
    claude_init(&mut protocol, &mut input, "2.1.300");
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"result","uuid":"final","is_error":false,"result":"Posso apagar?"}),
    );
    assert!(!input.completion_drained());
    assert!(!protocol.completion_cleanup_ready());
    claude_state(&mut protocol, &mut input, "idle");
    assert!(input.completion_drained());
    assert!(protocol.completion_cleanup_ready());
    for seconds in [0, 9] {
        assert!(!shutdown.observe(
            "claude-code",
            protocol.completion_cleanup_ready(),
            std::time::Duration::from_secs(seconds)
        ));
    }
    assert!(shutdown.observe(
        "claude-code",
        protocol.completion_cleanup_ready(),
        std::time::Duration::from_secs(10)
    ));
    assert!(shutdown.successful_exit(false, false, false));
    // A new native turn revokes proof; even a delayed idle cannot reuse its result.
    claude_state(&mut protocol, &mut input, "running");
    claude_state(&mut protocol, &mut input, "idle");
    assert!(!protocol.completion_cleanup_ready());
    assert!(!shutdown.observe(
        "claude-code",
        protocol.completion_cleanup_ready(),
        std::time::Duration::from_secs(20)
    ));
    assert!(!shutdown.successful_exit(false, false, false));
}

#[test]
fn claude_real_background_tasks_survive_idle_and_arbitrarily_long_transport_grace() {
    for task_type in [
        "local_bash",
        "local_agent",
        "local_workflow",
        "future_task_type",
    ] {
        let request = super::super::tests::request("claude-code");
        let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
        let mut protocol = LiveProtocol::new(&request);
        let mut shutdown = super::super::CompletionShutdown::default();
        claude_init(&mut protocol, &mut input, "2.1.300");
        claude_frame(
            &mut protocol,
            &mut input,
            json!({"type":"system","subtype":"task_started","task_id":"background","run_id":"run-a","task_type":task_type,"is_backgrounded":true,"owned_by_subagent":true}),
        );
        claude_frame(
            &mut protocol,
            &mut input,
            json!({"type":"result","uuid":"answer","is_error":false}),
        );
        let records = claude_frame(
            &mut protocol,
            &mut input,
            json!({"type":"system","subtype":"session_state_changed","state":"idle"}),
        );
        let mut parser = super::super::protocol::ChatParser::new("session".into(), "turn".into());
        assert!(records
            .iter()
            .flat_map(|line| parser.parse("claude-code", line))
            .any(|event| event.kind == "status"
                && event.status.as_deref() == Some("waiting-background")));
        assert!(!protocol.completion_cleanup_ready());
        for seconds in [0, 10, 600, 3600] {
            assert!(!shutdown.observe(
                "claude-code",
                protocol.completion_cleanup_ready(),
                std::time::Duration::from_secs(seconds)
            ));
        }
        claude_frame(
            &mut protocol,
            &mut input,
            json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}),
        );
        assert!(
            !protocol.completion_cleanup_ready(),
            "empty background snapshot must not erase the lifecycle ledger"
        );
    }
}

#[test]
fn claude_unknown_versions_or_ambiguous_task_frames_never_authorize_transport_cleanup() {
    for (version, frame) in [
        (
            "2.1.299",
            json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}),
        ),
        (
            "unknown",
            json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}),
        ),
        (
            "2.1.300",
            json!({"type":"system","subtype":"background_tasks_changed","tasks":null}),
        ),
        (
            "2.1.300",
            json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"missing-type"}]}),
        ),
        (
            "2.1.300",
            json!({"type":"system","subtype":"task_started","task_type":"local_bash"}),
        ),
        (
            "2.1.300",
            json!({"type":"system","subtype":"task_unknown_activity","task_id":"future"}),
        ),
        (
            "2.1.300",
            json!({"type":"system","subtype":"task_progress","task_id":"unregistered"}),
        ),
    ] {
        let request = super::super::tests::request("claude-code");
        let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
        let mut protocol = LiveProtocol::new(&request);
        claude_init(&mut protocol, &mut input, version);
        claude_frame(&mut protocol, &mut input, frame);
        claude_frame(
            &mut protocol,
            &mut input,
            json!({"type":"result","uuid":"answer","is_error":false}),
        );
        claude_state(&mut protocol, &mut input, "idle");
        assert!(!protocol.completion_cleanup_ready());
    }
}

#[test]
fn claude_terminal_task_replays_cannot_reopen_the_native_lifecycle_ledger() {
    let request = super::super::tests::request("claude-code");
    let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
    let mut protocol = LiveProtocol::new(&request);
    claude_init(&mut protocol, &mut input, "2.1.300");
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"system","subtype":"task_started","task_id":"bash","run_id":"run-a","task_type":"local_bash"}),
    );
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"system","subtype":"task_updated","task_id":"bash","run_id":"run-a","patch":{"status":"completed"}}),
    );
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"result","uuid":"answer","is_error":false}),
    );
    claude_state(&mut protocol, &mut input, "idle");
    assert!(protocol.completion_cleanup_ready());
    for frame in [
        json!({"type":"system","subtype":"task_progress","task_id":"bash","run_id":"run-a"}),
        json!({"type":"system","subtype":"task_updated","task_id":"bash","run_id":"run-a","patch":{"status":"running"}}),
        json!({"type":"system","subtype":"task_started","task_id":"bash","run_id":"run-a","task_type":"local_bash"}),
        json!({"type":"system","subtype":"task_notification","task_id":"bash","run_id":"run-a","status":"completed"}),
        json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"bash","run_id":"run-a","task_type":"local_bash"}]}),
    ] {
        claude_frame(&mut protocol, &mut input, frame);
        assert!(protocol.completion_cleanup_ready());
        assert!(protocol.claude_all_tasks.is_empty());
    }
}

#[test]
fn claude_resumed_task_generation_cannot_be_erased_by_terminal_replays() {
    for task_type in ["local_bash", "local_agent"] {
        for resumed_run in [Some("run-b"), None] {
            let request = super::super::tests::request("claude-code");
            let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
            let mut protocol = LiveProtocol::new(&request);
            claude_init(&mut protocol, &mut input, "2.1.300");
            claude_frame(
                &mut protocol,
                &mut input,
                json!({"type":"system","subtype":"task_started","task_id":"resumable","run_id":"run-a","task_type":task_type}),
            );
            claude_frame(
                &mut protocol,
                &mut input,
                json!({"type":"system","subtype":"task_notification","task_id":"resumable","run_id":"run-a","status":"completed"}),
            );
            claude_frame(
                &mut protocol,
                &mut input,
                json!({"type":"system","subtype":"task_started","task_id":"resumable","run_id":resumed_run,"task_type":task_type}),
            );
            for stale in [
                json!({"type":"system","subtype":"task_notification","task_id":"resumable","run_id":"run-a","status":"completed"}),
                json!({"type":"system","subtype":"task_updated","task_id":"resumable","run_id":"run-a","patch":{"status":"killed"}}),
            ] {
                claude_frame(&mut protocol, &mut input, stale);
            }
            claude_frame(
                &mut protocol,
                &mut input,
                json!({"type":"result","uuid":"answer","is_error":false}),
            );
            claude_state(&mut protocol, &mut input, "idle");
            assert!(protocol.claude_all_tasks.contains("resumable"));
            assert!(!protocol.completion_cleanup_ready());
            if task_type == "local_agent" {
                assert!(input.writer.is_some());
            }
        }
    }
}

#[test]
fn claude_malformed_task_notification_does_not_complete_a_live_native_task() {
    for status in [Value::Null, json!("running"), json!("future_terminal")] {
        let request = super::super::tests::request("claude-code");
        let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
        let mut protocol = LiveProtocol::new(&request);
        claude_init(&mut protocol, &mut input, "2.1.300");
        claude_frame(
            &mut protocol,
            &mut input,
            json!({"type":"system","subtype":"task_started","task_id":"shell","run_id":"run-a","task_type":"local_bash"}),
        );
        claude_frame(
            &mut protocol,
            &mut input,
            json!({"type":"system","subtype":"task_notification","task_id":"shell","run_id":"run-a","status":status}),
        );
        claude_frame(
            &mut protocol,
            &mut input,
            json!({"type":"result","uuid":"answer","is_error":false}),
        );
        claude_state(&mut protocol, &mut input, "idle");
        assert!(protocol.claude_all_tasks.contains("shell"));
        assert!(!protocol.completion_cleanup_ready());
    }
}

#[test]
fn claude_shell_progress_after_the_answer_allows_idle_eof_without_authorizing_cleanup() {
    let request = super::super::tests::request("claude-code");
    let mut input = LiveInput::with_writer(Box::new(Vec::new()), false);
    let mut protocol = LiveProtocol::new(&request);
    claude_init(&mut protocol, &mut input, "2.1.300");
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"system","subtype":"task_started","task_id":"dev-server","run_id":"run-a","task_type":"local_bash","is_backgrounded":true}),
    );
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"result","uuid":"answer","is_error":false}),
    );
    for progress in [
        json!({"type":"system","subtype":"task_progress","task_id":"dev-server","run_id":"run-a"}),
        json!({"type":"system","subtype":"task_updated","task_id":"dev-server","run_id":"run-a","patch":{"status":"running"}}),
        json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"dev-server","run_id":"run-a","task_type":"local_bash"}]}),
    ] {
        claude_frame(&mut protocol, &mut input, progress);
        assert!(input.writer.is_some());
        assert!(!protocol.completion_cleanup_ready());
    }
    let records = claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"system","subtype":"session_state_changed","state":"idle"}),
    );
    assert!(
        input.completion_drained(),
        "permanent background shells need EOF to let native post-turn handling begin"
    );
    assert!(!protocol.completion_cleanup_ready());
    assert!(records
        .iter()
        .any(|line| line.contains("agentdeck.waiting-background")));
    // Shell completion alone still cannot revive transport cleanup's old proof.
    claude_frame(
        &mut protocol,
        &mut input,
        json!({"type":"system","subtype":"task_notification","task_id":"dev-server","run_id":"run-a","status":"completed"}),
    );
    assert!(!protocol.completion_cleanup_ready());
}
