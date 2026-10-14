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
    let stream = UnixStream::connect(socket_path).map_err(|_| "bridge_connect")?;
    stream
        .set_nonblocking(true)
        .map_err(|_| "bridge_nonblocking")?;
    let bytes = serde_json::to_vec(payload).map_err(|_| "bridge_json")?;
    write_with_deadline(stream, &bytes, Duration::from_secs(2)).map_err(|_| "bridge_write")?;
    Ok(())
}

#[cfg(any(unix, test))]
fn wait_for_socket(deadline: std::time::Instant) -> std::io::Result<()> {
    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
    if remaining.is_zero() {
        return Err(std::io::ErrorKind::TimedOut.into());
    }
    std::thread::sleep(remaining.min(std::time::Duration::from_millis(5)));
    Ok(())
}

/// Darwin can reject socket timeout options after a fast sender disconnects.
/// Nonblocking IO keeps buffered EOF data readable and enforces a total deadline.
#[cfg(any(unix, test))]
pub(crate) fn read_with_deadline(
    mut reader: impl Read,
    limit: usize,
    timeout: std::time::Duration,
) -> std::io::Result<Vec<u8>> {
    let deadline = std::time::Instant::now() + timeout;
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        if std::time::Instant::now() >= deadline {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(bytes),
            Ok(count) => {
                if bytes.len().saturating_add(count) > limit {
                    return Err(std::io::ErrorKind::InvalidData.into());
                }
                bytes.extend_from_slice(&buffer[..count]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                wait_for_socket(deadline)?
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

#[cfg(any(unix, test))]
fn write_with_deadline(
    mut writer: impl Write,
    bytes: &[u8],
    timeout: std::time::Duration,
) -> std::io::Result<()> {
    let deadline = std::time::Instant::now() + timeout;
    let mut written = 0;
    while written < bytes.len() {
        if std::time::Instant::now() >= deadline {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        let end = written.saturating_add(8192).min(bytes.len());
        match writer.write(&bytes[written..end]) {
            Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
            Ok(count) => written += count,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                wait_for_socket(deadline)?
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
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
            let (stream, _) = listener.accept().unwrap();
            let _ = tx.send(
                crate::hooks::read_unix_hook_payload(stream, std::time::Duration::from_secs(2))
                    .unwrap(),
            );
        });
        let payload = json!({"hook_event_name":"Stop", "cwd":"/Users/O'Brien/Projeto café"});
        deliver_hook(path.to_str().unwrap(), &payload).unwrap();
        assert_eq!(
            rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap(),
            payload
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn native_io_preserves_partial_writes_and_expires_backpressure() {
        struct Writer {
            output: Vec<u8>,
            blocked: bool,
        }
        impl Write for Writer {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if self.blocked {
                    self.blocked = false;
                    return Err(std::io::ErrorKind::WouldBlock.into());
                }
                self.blocked = true;
                let count = bytes.len().min(3);
                self.output.extend_from_slice(&bytes[..count]);
                Ok(count)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut writer = Writer {
            output: Vec::new(),
            blocked: true,
        };
        write_with_deadline(
            &mut writer,
            b"caf\xc3\xa9 literal payload",
            std::time::Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(writer.output, b"caf\xc3\xa9 literal payload");
        struct Blocked;
        impl Read for Blocked {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::WouldBlock.into())
            }
        }
        impl Write for Blocked {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::WouldBlock.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        assert_eq!(
            read_with_deadline(Blocked, 1024, std::time::Duration::from_millis(10))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::TimedOut
        );
        assert_eq!(
            write_with_deadline(Blocked, b"payload", std::time::Duration::from_millis(10))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::TimedOut
        );
        assert_eq!(
            read_with_deadline(
                std::io::Cursor::new(vec![0; 1025]),
                1024,
                std::time::Duration::from_secs(1)
            )
            .unwrap_err()
            .kind(),
            std::io::ErrorKind::InvalidData
        );
    }
}
