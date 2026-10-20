//! Native Codex delegation tool results complement session_meta lineage.
use super::*;

fn tool_name(name: &str) -> &str {
    name.rsplit('.').next().unwrap_or(name)
}

pub(super) fn record_invocation(agent: &mut ObservedAgent, call_id: &str, input: &Value) {
    let Some(event) = agent
        .events
        .iter_mut()
        .rev()
        .find(|event| event.id == call_id)
    else {
        return;
    };
    if tool_name(&event.title) == "spawn_agent" {
        event.kind = "delegation".into();
        event.delegated_role = input["agent_type"].as_str().map(str::to_string);
    }
}

fn record_status(
    agent: &mut ObservedAgent,
    call_id: &str,
    id: &str,
    status: &Value,
    at: Option<String>,
) {
    if !safe_id(id) {
        return;
    }
    let Some(status) = native_status(status) else {
        return;
    };
    let event_id = format!("{call_id}:{id}");
    let event = AgentEvent {
        id: event_id.clone(),
        kind: "agent_status".into(),
        title: "Agent status".into(),
        detail: String::new(),
        status: "completed".into(),
        timestamp: at,
        delegated_agent_id: Some(id.into()),
        delegated_role: None,
        delegated_name: None,
        delegated_status: Some(status.into()),
    };
    if let Some(index) = agent.events.iter().position(|event| event.id == event_id) {
        agent.events[index] = event;
    } else {
        agent.events.push(event);
    }
    while agent.events.len() > MAX_EVENTS {
        agent.events.remove(0);
        agent.truncated = true;
    }
}

/// Lifecycle events are also emitted when collaboration tools run through code mode.
pub(super) fn record_event(agent: &mut ObservedAgent, payload: &Value, at: Option<String>) {
    if payload["sender_thread_id"]
        .as_str()
        .is_some_and(|id| id != agent.id)
    {
        return;
    }
    let call_id = text(payload, "call_id");
    match payload["type"].as_str().unwrap_or_default() {
        "collab_agent_spawn_begin" | "collab_agent_spawn_end" => {
            if call_id.is_empty() {
                return;
            }
            push_tool(
                agent,
                call_id.clone(),
                "spawn_agent".into(),
                limited(&text(payload, "prompt"), 2000),
                at.clone(),
            );
            let ended = payload["type"] == "collab_agent_spawn_end";
            if let Some(event) = agent
                .events
                .iter_mut()
                .rev()
                .find(|event| event.id == call_id)
            {
                event.kind = "delegation".into();
                if ended {
                    event.status = if payload["new_thread_id"].is_string() {
                        "completed"
                    } else {
                        "failed"
                    }
                    .into();
                    event.timestamp = at;
                    event.delegated_agent_id = payload["new_thread_id"]
                        .as_str()
                        .filter(|id| safe_id(id))
                        .map(str::to_string);
                    event.delegated_name =
                        payload["new_agent_nickname"].as_str().map(str::to_string);
                    event.delegated_role = payload["new_agent_role"].as_str().map(str::to_string);
                    event.delegated_status = native_status(&payload["status"]).map(str::to_string);
                }
            }
        }
        "collab_waiting_end" => {
            if let Some(statuses) = payload["statuses"].as_object() {
                for (id, status) in statuses {
                    record_status(agent, &call_id, id, status, at.clone());
                }
            }
        }
        "collab_agent_interaction_end" | "collab_resume_end" | "collab_close_end" => {
            if let Some(id) = payload["receiver_thread_id"].as_str() {
                record_status(agent, &call_id, id, &payload["status"], at);
            }
        }
        "sub_agent_activity" => {
            if let Some(id) = payload["agent_thread_id"].as_str() {
                let status = match payload["kind"].as_str() {
                    Some("started" | "interacted") => "running",
                    Some("completed") => "completed",
                    Some("interrupted") => "interrupted",
                    _ => return,
                };
                record_status(
                    agent,
                    &text(payload, "event_id"),
                    id,
                    &Value::String(status.into()),
                    at,
                );
            }
        }
        _ => {}
    }
}

fn native_status(value: &Value) -> Option<&'static str> {
    let name = value
        .as_str()
        .or_else(|| value.as_object()?.keys().next().map(String::as_str))?;
    match name {
        "pending_init" | "pendingInit" => Some("starting"),
        "running" => Some("running"),
        "completed" => Some("done"),
        "errored" | "not_found" | "notFound" => Some("error"),
        "shutdown" | "interrupted" => Some("stopped"),
        _ => None,
    }
}

pub(super) fn record_result(
    agent: &mut ObservedAgent,
    call_id: &str,
    output: &Value,
    at: Option<String>,
) {
    let parsed = output
        .as_str()
        .and_then(|s| serde_json::from_str::<Value>(s).ok());
    let output = parsed.as_ref().unwrap_or(output);
    let Some(event) = agent
        .events
        .iter_mut()
        .rev()
        .find(|event| event.id == call_id)
    else {
        return;
    };
    match tool_name(&event.title) {
        "spawn_agent" => {
            event.delegated_agent_id = output["agent_id"]
                .as_str()
                .filter(|id| safe_id(id))
                .map(str::to_string);
            event.delegated_name = output["nickname"]
                .as_str()
                .or_else(|| output["agent_nickname"].as_str())
                .map(str::to_string);
            // A successful spawn acknowledges creation, not completion of its task.
            event.delegated_status = event.delegated_agent_id.as_ref().map(|_| "running".into());
        }
        "wait" | "wait_agent" => {
            if let Some(statuses) = output["status"].as_object() {
                for (id, status) in statuses {
                    record_status(agent, call_id, id, status, at.clone());
                }
            }
            while agent.events.len() > MAX_EVENTS {
                agent.events.remove(0);
                agent.truncated = true;
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_lifecycle_events_track_code_mode_delegation_and_do_not_reparent_receivers() {
        let mut agent = super::super::tests::agent();
        for payload in [
            json!({"type":"collab_agent_spawn_begin","call_id":"spawn","sender_thread_id":"root","prompt":"Review auth"}),
            json!({"type":"collab_agent_spawn_end","call_id":"spawn","sender_thread_id":"root","new_thread_id":"child","new_agent_nickname":"Ada","new_agent_role":"reviewer","prompt":"Review auth","status":"running"}),
            json!({"type":"collab_waiting_end","call_id":"wait","sender_thread_id":"root","statuses":{"child":{"completed":"All clear"}}}),
        ] {
            parse_record(
                &mut agent,
                &json!({"type":"event_msg","payload":payload}),
                "codex",
            );
        }
        assert_eq!(agent.events.len(), 2);
        assert_eq!(agent.events[0].kind, "delegation");
        assert_eq!(agent.events[0].delegated_name.as_deref(), Some("Ada"));
        assert_eq!(agent.events[0].status, "completed");
        assert_eq!(agent.events[1].kind, "agent_status");
        assert_eq!(agent.events[1].delegated_status.as_deref(), Some("done"));
        parse_record(
            &mut agent,
            &json!({"type":"event_msg","payload":{"type":"collab_agent_spawn_end","call_id":"inherited","sender_thread_id":"another-parent","new_thread_id":"unrelated","status":"running"}}),
            "codex",
        );
        assert_eq!(agent.events.len(), 2);
    }

    #[test]
    fn spawn_acknowledgement_is_not_child_completion_and_wait_supplies_status() {
        let mut agent = super::super::tests::agent();
        parse_record(
            &mut agent,
            &json!({"type":"response_item","payload":{"type":"function_call","call_id":"spawn","name":"functions.spawn_agent","arguments":"{\"message\":\"Review auth\",\"agent_type\":\"explorer\"}"}}),
            "codex",
        );
        parse_record(
            &mut agent,
            &json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"spawn","output":"{\"agent_id\":\"child\",\"nickname\":\"Ada\"}"}}),
            "codex",
        );
        assert_eq!(agent.events[0].delegated_agent_id.as_deref(), Some("child"));
        assert_eq!(agent.events[0].delegated_role.as_deref(), Some("explorer"));
        assert_eq!(agent.events[0].delegated_status.as_deref(), Some("running"));
        assert_eq!(agent.events[0].status, "completed");
        parse_record(
            &mut agent,
            &json!({"type":"response_item","payload":{"type":"function_call","call_id":"wait","name":"wait","arguments":"{\"ids\":[\"child\"]}"}}),
            "codex",
        );
        parse_record(
            &mut agent,
            &json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"wait","output":{"status":{"child":{"completed":"All clear"}},"timed_out":false}}}),
            "codex",
        );
        assert_eq!(
            agent.events.last().unwrap().delegated_status.as_deref(),
            Some("done")
        );
        assert_eq!(agent.events.last().unwrap().kind, "agent_status");
    }
}
