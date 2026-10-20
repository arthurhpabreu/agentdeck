//! Gemini CLI's native chats/<main-session>/<agent-id>.jsonl layout establishes
//! membership; toolCalls[].agentId establishes names and exact nested parents.
use super::*;

pub(super) fn parse_header(value: &Value, path: PathBuf) -> Option<IndexedSession> {
    let id = value["sessionId"].as_str()?.to_string();
    if !safe_id(&id) || !value["projectHash"].is_string() {
        return None;
    }
    let parent_id = if value["kind"] == "subagent" {
        path.parent()?
            .file_name()?
            .to_str()
            .filter(|id| safe_id(id) && *id != "chats")
            .map(str::to_string)
    } else {
        None
    };
    Some(IndexedSession {
        id,
        parent_id,
        name: None,
        role: None,
        path,
    })
}

pub(super) fn index(home: &Path, requests: &[ObserveSession]) -> Vec<IndexedSession> {
    let roots: Vec<_> = requests
        .iter()
        .filter(|r| r.provider == "gemini")
        .filter_map(|r| r.provider_session_id.as_deref())
        .filter(|id| safe_id(id))
        .collect();
    if roots.is_empty() {
        return Vec::new();
    }
    let mut files = Vec::new();
    let mut remaining = 2000;
    transcript_files(&home.join("tmp"), 5, &mut remaining, &mut files, true);
    files.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
    let mut seen = HashSet::new();
    files
        .into_iter()
        .take(600)
        .filter_map(|(_, path)| {
            let file = File::open(&path).ok()?;
            let legacy = path.extension().is_some_and(|ext| ext == "json");
            let value = if legacy {
                // Older releases stored one JSON object. Only read candidates whose
                // native filename matches this request, and keep the same byte cap.
                let filename = path.file_stem()?.to_str()?;
                if !roots.iter().any(|id| {
                    filename.ends_with(&id[..id.len().min(8)])
                        || path
                            .parent()
                            .and_then(|p| p.file_name())
                            .and_then(|s| s.to_str())
                            == Some(*id)
                }) || file.metadata().ok()?.len() > MAX_TRANSCRIPT_BYTES
                {
                    return None;
                }
                serde_json::from_reader(file.take(MAX_TRANSCRIPT_BYTES)).ok()?
            } else {
                let mut line = String::new();
                BufReader::new(file.take(16384)).read_line(&mut line).ok()?;
                serde_json::from_str(&line).ok()?
            };
            let entry = parse_header(&value, path)?;
            seen.insert(entry.id.clone()).then_some(entry)
        })
        .collect()
}

fn visible_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return limited(text, 3000);
    }
    value
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|part| part["thought"] != true)
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .map(|text| limited(&text, 3000))
        .unwrap_or_default()
}

pub(super) fn parse_legacy(agent: &mut ObservedAgent, value: &Value) {
    if let Some(messages) = value["messages"].as_array() {
        for record in messages {
            parse_record(agent, record);
        }
    }
}

pub(super) fn parse_record(agent: &mut ObservedAgent, record: &Value) {
    match record["type"].as_str().unwrap_or_default() {
        "user" => {
            let task = visible_text(&record["content"]);
            if !task.is_empty() {
                agent.task = task;
                agent.status = "running".into();
            }
        }
        "gemini" => {
            if let Some(model) = record["model"].as_str() {
                agent.model = Some(model.into());
            }
            let answer = visible_text(&record["content"]);
            if !answer.is_empty() {
                agent.last_message = answer;
                agent.status = if agent.parent_id.is_some() {
                    "running"
                } else {
                    "done"
                }
                .into();
            }
            if let Some(calls) = record["toolCalls"].as_array() {
                for call in calls {
                    let id = text(call, "id");
                    if id.is_empty() {
                        continue;
                    }
                    let existing = agent.events.iter().position(|event| event.id == id);
                    let status = match call["resultDisplay"]["state"]
                        .as_str()
                        .or_else(|| call["status"].as_str())
                        .unwrap_or_default()
                    {
                        "success" | "completed" => "completed",
                        "error" | "failed" => "failed",
                        "cancelled" | "canceled" => "stopped",
                        _ => "running",
                    };
                    let child = call["agentId"].as_str().filter(|id| safe_id(id));
                    let progress = &call["resultDisplay"];
                    let event = AgentEvent {
                        id,
                        kind: if child.is_some() {
                            "delegation"
                        } else {
                            "tool"
                        }
                        .into(),
                        title: text(call, "name"),
                        detail: display_input(&call["args"]),
                        status: status.into(),
                        timestamp: timestamp(call).or_else(|| timestamp(record)),
                        delegated_agent_id: child.map(str::to_string),
                        delegated_role: child.map(|_| text(call, "name")),
                        delegated_name: progress["agentName"].as_str().map(str::to_string),
                        delegated_status: child.map(|_| {
                            match status {
                                "completed" => "done",
                                "failed" => "error",
                                "stopped" => "stopped",
                                _ => "running",
                            }
                            .into()
                        }),
                    };
                    if let Some(index) = existing {
                        agent.events[index] = event;
                    } else {
                        agent.events.push(event);
                    }
                    if status == "running" {
                        agent.status = "running".into();
                    } else if status == "failed" {
                        agent.status = "error".into();
                    } else if agent.status != "error" {
                        agent.status = "running".into();
                    }
                    if call["name"] == "complete_task" && status == "completed" {
                        agent.status = "done".into();
                        if let Some(result) = call["args"]["result"].as_str() {
                            agent.last_message = limited(result, 3000);
                        }
                    }
                    while agent.events.len() > MAX_EVENTS {
                        agent.events.remove(0);
                        agent.truncated = true;
                    }
                }
            }
        }
        "error" => agent.status = "error".into(),
        _ => {}
    }
    if let Some(messages) = record["$set"]["messages"].as_array() {
        agent.events.clear();
        agent.task.clear();
        agent.last_message.clear();
        agent.status = "unknown".into();
        for message in messages {
            parse_record(agent, message);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn jsonl_and_legacy_transcripts_are_discovered_by_native_ids_and_read_without_reasoning() {
        let directory =
            std::env::temp_dir().join(format!("agentdeck-gemini-observe-{}", uuid::Uuid::new_v4()));
        let chats = directory.join("tmp/hash/chats");
        fs::create_dir_all(chats.join("root-jsonl")).unwrap();
        let request = ObserveSession {
            session_id: "ui".into(),
            provider: "gemini".into(),
            provider_session_id: Some("root-jsonl".into()),
            workdir: "shared-project".into(),
        };
        let legacy = ObserveSession {
            provider_session_id: Some("legacy01-native".into()),
            ..request.clone()
        };
        fs::write(
            chats.join("session-root.jsonl"),
            format!(
                "{}\n{}\n",
                json!({"sessionId":"root-jsonl","projectHash":"hash"}),
                json!({"id":"u","type":"user","content":[{"text":"Review auth"}]})
            ),
        )
        .unwrap();
        fs::write(chats.join("root-jsonl/child.jsonl"), format!("{}\n{}\n", json!({"sessionId":"child","projectHash":"hash","kind":"subagent"}), json!({"id":"a","type":"gemini","thoughts":[{"text":"private"}],"model":"gemini-test","toolCalls":[{"id":"done","name":"complete_task","args":{"result":"All clear"},"status":"success"}]}))).unwrap();
        fs::write(chats.join("session-old-legacy01.json"), serde_json::to_vec_pretty(&json!({"sessionId":"legacy01-native","projectHash":"hash","messages":[{"id":"old","type":"gemini","content":"Legacy answer"}]})).unwrap()).unwrap();
        fs::write(
            chats.join("session-unrelated.jsonl"),
            format!(
                "{}\n",
                json!({"sessionId":"unrelated","projectHash":"hash","cwd":"shared-project"})
            ),
        )
        .unwrap();
        let indexed = index(&directory, &[request.clone(), legacy.clone()]);
        let members = descendants(&indexed, "root-jsonl");
        assert_eq!(members.len(), 2);
        let child = members.iter().find(|entry| entry.id == "child").unwrap();
        let observed = read_agent(child, &request, child.parent_id.clone()).unwrap();
        assert_eq!(observed.status, "done");
        assert_eq!(observed.last_message, "All clear");
        let old = indexed
            .iter()
            .find(|entry| entry.id == "legacy01-native")
            .unwrap();
        assert_eq!(
            read_agent(old, &legacy, None).unwrap().last_message,
            "Legacy answer"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn native_subagent_directory_supplies_membership_and_tool_result_supplies_identity() {
        let root = parse_header(
            &json!({"sessionId":"root","projectHash":"hash"}),
            PathBuf::from("tmp/hash/chats/session-root.jsonl"),
        )
        .unwrap();
        let child = parse_header(
            &json!({"sessionId":"child","projectHash":"hash","kind":"subagent"}),
            PathBuf::from("tmp/hash/chats/root/child.jsonl"),
        )
        .unwrap();
        let unrelated = parse_header(
            &json!({"sessionId":"other","projectHash":"hash"}),
            PathBuf::from("tmp/hash/chats/session-other.jsonl"),
        )
        .unwrap();
        assert_eq!(descendants(&[root, child, unrelated], "root").len(), 2);
        let mut agent = super::super::tests::agent();
        parse_record(
            &mut agent,
            &json!({"id":"message","type":"gemini","model":"gemini-test","thoughts":[{"text":"private"}],"toolCalls":[{"id":"delegate","name":"generalist","args":{"task":"Review authentication"},"status":"success","agentId":"child","resultDisplay":{"isSubagentProgress":true,"agentName":"generalist","state":"error"}}]}),
        );
        assert_eq!(agent.events[0].delegated_agent_id.as_deref(), Some("child"));
        assert_eq!(agent.events[0].delegated_status.as_deref(), Some("error"));
        assert_eq!(agent.events[0].status, "failed");
        assert!(agent.last_message.is_empty());
        assert_eq!(agent.model.as_deref(), Some("gemini-test"));
    }

    #[test]
    fn repeated_native_message_snapshots_update_tools_without_duplicates_or_thoughts() {
        let mut agent = super::super::tests::agent();
        let mut record = json!({"id":"message","type":"gemini","content":[{"text":"Visible"},{"thought":true,"text":"private"}],"toolCalls":[{"id":"read","name":"read_file","args":{"path":"src/main.rs"},"status":"running"}]});
        parse_record(&mut agent, &record);
        record["toolCalls"][0]["status"] = json!("success");
        parse_record(&mut agent, &record);
        assert_eq!(agent.events.len(), 1);
        assert_eq!(agent.events[0].status, "completed");
        assert_eq!(agent.last_message, "Visible");
    }
}
