//! Adapts RTK's native rewrite to Codex's documented PreToolUse response.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    process::Stdio,
    time::{Duration, Instant},
};
pub fn stdio_entry() -> Option<i32> {
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).map(String::as_str) != Some("--rtk-hook") {
        return None;
    }
    let run = || -> Result<Value, String> {
        let encoded = args
            .iter()
            .position(|a| a == "--context")
            .and_then(|i| args.get(i + 1))
            .filter(|s| s.len() < 16000)
            .ok_or("Missing RTK context")?;
        let context: Value = serde_json::from_slice(
            &STANDARD
                .decode(encoded)
                .map_err(|_| "Invalid RTK context")?,
        )
        .map_err(|_| "Invalid RTK context")?;
        let path = context["rtkPath"]
            .as_str()
            .filter(|p| std::path::Path::new(p).is_absolute() && std::path::Path::new(p).is_file())
            .ok_or("RTK executable unavailable")?;
        let mut bytes = vec![];
        std::io::stdin()
            .take(256 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read hook")?;
        if bytes.len() > 256 * 1024 {
            return Err("Hook input too large".into());
        }
        let payload: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid hook input")?;
        if payload["hook_event_name"] != "PreToolUse" || payload["tool_name"] != "Bash" {
            return Ok(json!({}));
        }
        let mut child = crate::util::background_command(path)
            .args(["hook", "claude"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Cannot start RTK hook")?;
        if let Some(mut stdin) = child.stdin.take() {
            if stdin.write_all(&bytes).is_err() {
                let _ = child.kill();
                let _ = child.wait();
                return Err("RTK hook input failed".into());
            }
        }
        let stdout = child.stdout.take().ok_or("RTK hook output unavailable")?;
        let reader = std::thread::spawn(move || {
            let mut out = vec![];
            let _ = stdout.take(32768).read_to_end(&mut out);
            out
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("RTK hook timed out".into());
                }
            }
        }
        let output = reader.join().map_err(|_| "RTK hook output failed")?;
        let response: Value = serde_json::from_slice(&output).unwrap_or_else(|_| json!({}));
        Ok(adapt(&payload, &response))
    };
    let response = run().unwrap_or_else(|_| json!({}));
    let _ = writeln!(std::io::stdout(), "{response}");
    Some(0)
}
fn adapt(payload: &Value, response: &Value) -> Value {
    let Some(command) = response["hookSpecificOutput"]["updatedInput"]["command"].as_str() else {
        return json!({});
    };
    if payload["tool_input"]["command"] == command {
        return json!({});
    }
    let mut replacement = payload["tool_input"].clone();
    if !replacement.is_object() {
        return json!({});
    }
    replacement["command"] = json!(command);
    json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"RTK output compression; native access policy remains configured by the user","updatedInput":replacement}})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rewrite_preserves_tool_arguments_and_does_not_change_unchanged_commands() {
        let input =
            json!({"tool_input":{"command":"git status","cwd":"C:/Project","timeout":1000}});
        let response = json!({"hookSpecificOutput":{"updatedInput":{"command":"rtk git status"}}});
        let adapted = adapt(&input, &response);
        assert_eq!(
            adapted["hookSpecificOutput"]["updatedInput"]["cwd"],
            "C:/Project"
        );
        assert_eq!(adapted["hookSpecificOutput"]["permissionDecision"], "allow");
        assert_eq!(
            adapt(
                &json!({"tool_input":{"command":"rtk git status"}}),
                &response
            ),
            json!({})
        );
    }
}
