//! Small native CLI helpers run before Tauri starts, with bounded input and no
//! external runtime requirement for macOS consumers.
#[cfg(any(unix, test))]
use serde_json::json;
use serde_json::Value;
use std::io::{Read, Write};
const MAX_INPUT: u64 = 512 * 1024;

fn read_payload() -> Result<Value, String> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(MAX_INPUT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "bridge_input")?;
    if bytes.len() as u64 > MAX_INPUT {
        return Err("bridge_input_limit".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "bridge_json".into())
}

pub fn stdio_entry() -> Option<i32> {
    let arguments = std::env::args().collect::<Vec<_>>();
    match arguments.get(1).map(String::as_str) {
        Some("--hook-bridge") => {
            let _ = send_hook(&arguments[2..]);
            Some(0) // An unavailable desktop receiver must not interrupt the CLI.
        }
        Some("--claude-statusline") => {
            if let Ok(payload) = read_payload() {
                let _ = crate::provider_usage::record_native_statusline(&payload);
            }
            let mut stdout = std::io::stdout().lock();
            let _ = write!(stdout, "Agentdeck");
            let _ = stdout.flush();
            Some(0)
        }
        _ => None,
    }
}

#[cfg(unix)]
fn send_hook(arguments: &[String]) -> Result<(), String> {
    use crate::session_lifecycle::HookSource;
    let [source_flag, source, socket_flag, socket_path] = arguments else {
        return Err("bridge_arguments".into());
    };
    if source_flag != "--source" || socket_flag != "--socket" {
        return Err("bridge_arguments".into());
    }
    let source = match source.as_str() {
        "claude-code" => HookSource::ClaudeCode,
        "codex" => HookSource::Codex,
        _ => return Err("bridge_source".into()),
    };
    if *socket_path != source.socket_path() {
        return Err("bridge_socket".into());
    }
    let mut payload = read_payload()?;
    annotate_hook(
        &mut payload,
        source.label(),
        std::env::var("AGENTDECK_SESSION_ID").ok().as_deref(),
        std::env::var("AGENTDECK_RUNNER_TYPE").ok().as_deref(),
    )?;
    deliver_hook(socket_path, &payload)
}

#[cfg(unix)]
fn deliver_hook(socket_path: &str, payload: &Value) -> Result<(), String> {
    use std::{os::unix::net::UnixStream, time::Duration};
    let mut stream = UnixStream::connect(socket_path).map_err(|_| "bridge_connect")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "bridge_timeout")?;
    serde_json::to_writer(&mut stream, payload).map_err(|_| "bridge_write")?;
    Ok(())
}

#[cfg(not(unix))]
fn send_hook(_arguments: &[String]) -> Result<(), String> {
    Err("bridge_platform".into())
}

#[cfg(any(unix, test))]
fn annotate_hook(
    payload: &mut Value,
    source: &str,
    session_id: Option<&str>,
    runner: Option<&str>,
) -> Result<(), String> {
    let object = payload.as_object_mut().ok_or("bridge_json")?;
    object.insert("agentdeck_source".into(), json!(source));
    for (key, value) in [
        ("agentdeck_session_id", session_id),
        ("agentdeck_runner_type", runner),
    ] {
        if let Some(value) = value.filter(|value| {
            !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
        }) {
            object.insert(key.into(), json!(value));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hook_routing_keeps_provider_payload_and_validates_local_identity() {
        let mut payload = json!({"hook_event_name":"Stop", "session_id":"provider-session", "agentdeck_session_id":"existing"});
        annotate_hook(&mut payload, "codex", Some("local-session"), Some("codex")).unwrap();
        assert_eq!(payload["session_id"], "provider-session");
        assert_eq!(payload["agentdeck_session_id"], "local-session");
        annotate_hook(&mut payload, "codex", Some("bad\nidentity"), None).unwrap();
        assert_eq!(payload["agentdeck_session_id"], "local-session");
        assert!(annotate_hook(&mut json!([]), "codex", None, None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn native_bridge_delivers_unicode_payload_over_local_socket() {
        use std::os::unix::net::UnixListener;
        let name = uuid::Uuid::new_v4().to_string();
        let path = std::env::temp_dir().join(format!("ad-{}.sock", &name[..8]));
        let listener = UnixListener::bind(&path).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).unwrap();
            let _ = tx.send(serde_json::from_slice::<Value>(&bytes).unwrap());
        });
        let payload = json!({"hook_event_name":"Stop", "cwd":"/Users/O'Brien/Projeto café"});
        deliver_hook(path.to_str().unwrap(), &payload).unwrap();
        assert_eq!(
            rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap(),
            payload
        );
        std::fs::remove_file(path).unwrap();
    }
}
