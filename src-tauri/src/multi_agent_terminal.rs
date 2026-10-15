//! Add a process-only suffix; never replace the user's instructions or start a turn.
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    process::Stdio,
    sync::mpsc,
    time::Duration,
};

const ERROR: &str = "Could not preserve native instructions for model distribution. Use readable Chat or remove unsupported native flags; your configuration was not changed.";
const LIMIT: u64 = 2 * 1024 * 1024;

/// True means guidance is present in the native process, even before its first prompt.
/// The caller may keep app-managed revocation pending when this fails with the mode off.
pub async fn configure(
    provider: &str,
    cli_path: &str,
    workdir: &str,
    args: &mut Vec<String>,
    guidance: &str,
) -> Result<bool, String> {
    if guidance.is_empty() {
        return Ok(false);
    }
    let (provider, cli, cwd, original, suffix) = (
        provider.to_owned(),
        cli_path.to_owned(),
        workdir.to_owned(),
        args.clone(),
        guidance.to_owned(),
    );
    let configured = tauri::async_runtime::spawn_blocking(move || {
        let mut configured = original;
        if provider == "claude-code" {
            claude_suffix(&cwd, &mut configured, &suffix)?;
        } else if provider == "codex" {
            let base = codex_instructions(&cli, &cwd, &configured)?;
            let position = configured
                .iter()
                .position(|arg| arg == "--")
                .unwrap_or(configured.len());
            configured.splice(
                position..position,
                [
                    "-c".into(),
                    format!("developer_instructions={}", json!(joined(&base, &suffix))),
                ],
            );
        } else {
            return Err(ERROR.to_owned());
        }
        Ok::<_, String>(configured)
    })
    .await
    .map_err(|_| ERROR.to_owned())??;
    *args = configured;
    Ok(true)
}

fn joined(base: &str, suffix: &str) -> String {
    if base.is_empty() {
        suffix.to_owned()
    } else {
        format!("{base}\n\n{suffix}")
    }
}

fn claude_suffix(cwd: &str, args: &mut Vec<String>, suffix: &str) -> Result<(), String> {
    let flags = ["--append-system-prompt", "--append-system-prompt-file"];
    let positions: Vec<_> = args
        .iter()
        .take_while(|arg| arg.as_str() != "--")
        .enumerate()
        .filter(|(_, arg)| {
            flags
                .iter()
                .any(|flag| arg.as_str() == *flag || arg.starts_with(&format!("{flag}=")))
        })
        .map(|(index, _)| index)
        .collect();
    if positions.len() > 1 {
        return Err(ERROR.into());
    }
    let Some(position) = positions.first().copied() else {
        let position = args
            .iter()
            .position(|arg| arg == "--")
            .unwrap_or(args.len());
        args.splice(position..position, [flags[0].into(), suffix.into()]);
        return Ok(());
    };
    let (flag, inline) = args[position]
        .split_once('=')
        .map_or((args[position].as_str(), None), |(flag, value)| {
            (flag, Some(value))
        });
    let value = inline
        .or_else(|| args.get(position + 1).map(String::as_str))
        .ok_or(ERROR)?;
    let base = if flag == flags[1] {
        let path = crate::util::resolve_path_from_workdir(cwd, value);
        let mut text = String::new();
        fs::File::open(path)
            .and_then(|file| file.take(LIMIT + 1).read_to_string(&mut text))
            .map_err(|_| ERROR)?;
        if text.len() as u64 > LIMIT {
            return Err(ERROR.into());
        }
        text
    } else {
        value.to_owned()
    };
    let end = position + if inline.is_some() { 1 } else { 2 };
    args.splice(position..end, [flags[0].into(), joined(&base, suffix)]);
    Ok(())
}

fn probe_flags(args: &[String]) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    let mut index = 0;
    while let Some(arg) = args.get(index) {
        if arg == "--" {
            break;
        }
        if ["--profile", "--cd", "--remote", "--worktree"]
            .iter()
            .any(|flag| arg == flag || arg.starts_with(&format!("{flag}=")))
            || (arg.starts_with("-p") || arg.starts_with("-C")) && !arg.starts_with("--")
        {
            return Err(ERROR.into());
        }
        if matches!(arg.as_str(), "-c" | "--config" | "--enable" | "--disable") {
            result.extend([arg.clone(), args.get(index + 1).ok_or(ERROR)?.clone()]);
            index += 2;
        } else {
            if arg.starts_with("-c") && !arg.starts_with("--")
                || ["--config=", "--enable=", "--disable="]
                    .iter()
                    .any(|flag| arg.starts_with(flag))
            {
                result.push(arg.clone());
            }
            index += 1;
        }
    }
    Ok(result)
}

fn config_instructions(config: &Value) -> Result<String, String> {
    if !config.is_object() || config.get("profile").is_some_and(|value| !value.is_null()) {
        return Err(ERROR.into());
    }
    match config.get("developer_instructions") {
        Some(Value::Null) => Ok(String::new()),
        Some(Value::String(value)) => Ok(value.clone()),
        _ => Err(ERROR.into()),
    }
}

fn codex_instructions(cli: &str, cwd: &str, original: &[String]) -> Result<String, String> {
    let mut arguments = probe_flags(original)?;
    arguments.extend(["app-server", "--strict-config", "--listen", "stdio://"].map(str::to_owned));
    let executable = crate::util::find_cli_path("codex", cli);
    let (executable, arguments) = crate::util::resolve_windows_pty_command(&executable, &arguments);
    #[cfg(windows)]
    if std::path::Path::new(&executable)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "cmd" | "bat" | "ps1"))
    {
        return Err(ERROR.into());
    }
    let mut child = crate::util::background_command(&executable)
        .args(arguments)
        .current_dir(cwd)
        .env(
            "PATH",
            crate::platform::process_path(std::path::Path::new(&executable)),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ERROR)?;
    let Some(output) = child.stdout.take() else {
        crate::cli_updates::terminate_probe(&mut child);
        return Err(ERROR.into());
    };
    let (sender, receiver) = mpsc::sync_channel(2);
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output.take(4 * 1024 * 1024))
            .lines()
            .map_while(Result::ok)
        {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if matches!(value["id"].as_u64(), Some(1 | 2)) {
                    let _ = sender.try_send(value);
                }
            }
        }
    });
    let result = (|| {
        let input = child.stdin.as_mut().ok_or(ERROR)?;
        for (id, method, params) in [
            (
                1,
                "initialize",
                json!({"clientInfo":{"name":"agentdeck-terminal","version":env!("CARGO_PKG_VERSION")}}),
            ),
            (2, "config/read", json!({"includeLayers":false,"cwd":cwd})),
        ] {
            writeln!(
                input,
                "{}",
                json!({"id":id,"method":method,"params":params})
            )
            .and_then(|_| input.flush())
            .map_err(|_| ERROR)?;
            let response = receiver
                .recv_timeout(Duration::from_secs(10))
                .map_err(|_| ERROR)?;
            if response["id"] != id || response.get("error").is_some() {
                return Err(ERROR.into());
            }
            if id == 2 {
                return config_instructions(&response["result"]["config"]);
            }
            writeln!(input, "{}", json!({"method":"initialized"}))
                .and_then(|_| input.flush())
                .map_err(|_| ERROR)?;
        }
        Err(ERROR.into())
    })();
    drop(child.stdin.take());
    crate::cli_updates::terminate_probe(&mut child);
    let _ = reader.join();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).into()).collect()
    }

    #[test]
    fn claude_preserves_inline_instructions_and_unrelated_permissions() {
        for flag in ["--append-system-prompt", "--append-system-prompt="] {
            let mut args = strings(&["--permission-mode", "plan"]);
            if flag.ends_with('=') {
                args.push(format!("{flag}user\n\"quoted\""));
            } else {
                args.extend([flag.into(), "user\n\"quoted\"".into()]);
            }
            claude_suffix("", &mut args, "routing").unwrap();
            assert_eq!(&args[..2], &["--permission-mode", "plan"]);
            assert_eq!(args[3], "user\n\"quoted\"\n\nrouting");
        }
    }
    #[test]
    fn claude_reads_original_file_without_modifying_it() {
        let directory =
            std::env::temp_dir().join(format!("agentdeck-instructions-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("original.txt");
        fs::write(&path, "ação\nBASE").unwrap();
        let mut args = strings(&["--append-system-prompt-file=original.txt"]);
        claude_suffix(directory.to_str().unwrap(), &mut args, "OFF revocation").unwrap();
        assert_eq!(
            args,
            strings(&["--append-system-prompt", "ação\nBASE\n\nOFF revocation"])
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "ação\nBASE");
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }
    #[test]
    fn probe_forwards_only_config_flags_and_rejects_unresolvable_profiles() {
        assert_eq!(
            probe_flags(&strings(&[
                "resume",
                "private-session",
                "-c",
                "developer_instructions=\"explicit\"",
                "--enable=fast_mode",
                "--model",
                "private-model",
                "--",
                "-cnot_config"
            ]))
            .unwrap(),
            strings(&[
                "-c",
                "developer_instructions=\"explicit\"",
                "--enable=fast_mode"
            ])
        );
        for flag in [
            "-p",
            "-preview",
            "--profile=review",
            "--cd=elsewhere",
            "--remote=ws://localhost",
            "--worktree",
        ] {
            assert!(probe_flags(&strings(&[flag])).is_err());
        }
        assert!(
            config_instructions(&json!({"profile":"review","developer_instructions":"base"}))
                .is_err()
        );
    }
    #[test]
    fn codex_requires_observable_base_and_serializes_suffix_without_losing_quotes() {
        for invalid in [json!({}), json!({"developer_instructions":true})] {
            assert!(config_instructions(&invalid).is_err());
        }
        assert_eq!(
            config_instructions(&json!({"developer_instructions":null})).unwrap(),
            ""
        );
        let base =
            config_instructions(&json!({"developer_instructions":"explicit\n\"quoted\"\\path"}))
                .unwrap();
        let value = json!(joined(&base, "routing"));
        let toml: toml::Value = toml::from_str(&format!("developer_instructions={value}")).unwrap();
        assert_eq!(
            toml["developer_instructions"].as_str().unwrap(),
            "explicit\n\"quoted\"\\path\n\nrouting"
        );
    }
}
