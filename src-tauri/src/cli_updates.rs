//! Version checks never start an inference. Updates use the detected installation,
//! fixed official package names and argv (no interpolated shell commands).
use serde::Serialize;
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;

#[derive(Default)]
struct Gate {
    readers: usize,
    updating: bool,
}
static GATE: Mutex<Gate> = Mutex::new(Gate {
    readers: 0,
    updating: false,
});
pub struct LaunchGuard;
impl Drop for LaunchGuard {
    fn drop(&mut self) {
        if let Ok(mut gate) = GATE.lock() {
            gate.readers -= 1;
        }
    }
}
pub fn launch_guard() -> Result<LaunchGuard, String> {
    let mut gate = GATE.lock().map_err(|_| "cli_busy")?;
    if gate.updating {
        return Err("cli_updating".into());
    }
    gate.readers += 1;
    Ok(LaunchGuard)
}
struct UpdateGuard;
impl Drop for UpdateGuard {
    fn drop(&mut self) {
        if let Ok(mut gate) = GATE.lock() {
            gate.updating = false;
        }
    }
}
fn update_guard() -> Result<UpdateGuard, String> {
    let mut gate = GATE.lock().map_err(|_| "cli_busy")?;
    if gate.updating || gate.readers > 0 {
        return Err("cli_busy".into());
    }
    gate.updating = true;
    Ok(UpdateGuard)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdate {
    provider: String,
    installed: Option<String>,
    latest: Option<String>,
    update_available: bool,
    method: String,
    executable: String,
    error: Option<String>,
}
fn package(provider: &str) -> Result<&'static str, String> {
    match provider {
        "claude-code" => Ok("@anthropic-ai/claude-code"),
        "codex" => Ok("@openai/codex"),
        "gemini" => Ok("@google/gemini-cli"),
        _ => Err("unsupported_cli".into()),
    }
}
fn version(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|word| {
            let parts: Vec<_> = word.split('.').collect();
            parts.len() == 3
                && parts.iter().all(|part| {
                    !part.is_empty()
                        && part.len() < 10
                        && part.bytes().all(|byte| byte.is_ascii_digit())
                })
        })
        .map(str::to_owned)
}
fn newer(installed: &str, latest: &str) -> bool {
    let numbers = |value: &str| {
        value
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    numbers(latest) > numbers(installed)
}
pub fn run_bounded(program: &str, args: &[String], timeout: Duration) -> Result<String, String> {
    let (program, args) = crate::util::resolve_windows_pty_command(program, args);
    #[cfg(windows)]
    if Path::new(&program)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "cmd" | "bat" | "ps1"))
    {
        return Err("unsupported_installation".into());
    }
    let mut child = crate::util::background_command(program)
        .args(args)
        .current_dir(std::env::temp_dir())
        .env("DISABLE_AUTOUPDATER", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "cli_unavailable")?;
    let output = child.stdout.take().ok_or("cli_unavailable")?;
    let errors = child.stderr.take().ok_or("cli_unavailable")?;
    let reader = std::thread::spawn(move || bounded_output(output));
    let error_reader = std::thread::spawn(move || bounded_output(errors));
    let deadline = Instant::now() + timeout;
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                #[cfg(windows)]
                {
                    let _ = crate::util::background_command("taskkill.exe")
                        .args(["/PID", &child.id().to_string(), "/T", "/F"])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                }
                let _ = child.kill();
                let _ = child.wait();
                break Err("cli_timeout");
            }
        }
    };
    let text = reader.join().unwrap_or_default();
    let errors = error_reader.join().unwrap_or_default();
    match success {
        Ok(status) if status.success() => Ok(text),
        Ok(status) => Err(command_failure(&errors, &text, status.code())),
        Err(error) => Err(error.into()),
    }
}

fn bounded_output(mut output: impl Read) -> String {
    // Drain both pipes concurrently to avoid blocking a verbose installer. Only
    // retain a bounded tail; raw logs are never serialized to the frontend.
    const LIMIT: usize = 16 * 1024;
    let mut collected = Vec::new();
    let mut buffer = [0; 4096];
    while let Ok(count) = output.read(&mut buffer) {
        if count == 0 {
            break;
        }
        collected.extend_from_slice(&buffer[..count]);
        if collected.len() > LIMIT {
            collected.drain(..collected.len() - LIMIT);
        }
    }
    String::from_utf8_lossy(&collected).into_owned()
}

fn command_failure(stderr: &str, stdout: &str, exit_code: Option<i32>) -> String {
    let output = format!("{stderr}\n{stdout}");
    // Export only known error categories and a numeric exit code. npm logs can
    // contain proxy URLs, registry credentials and local paths.
    let category = if output.contains("Maximum call stack size exceeded") {
        "cli_path_error"
    } else if output.contains("ENOSPC") {
        "cli_disk_full"
    } else if output.contains("EACCES") {
        "cli_permission_denied"
    } else if ["EPERM", "EBUSY", "ETXTBSY"]
        .iter()
        .any(|code| output.contains(code))
    {
        "cli_files_in_use"
    } else if [
        "CERT_HAS_EXPIRED",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
    ]
    .iter()
    .any(|code| output.contains(code))
    {
        "cli_certificate_error"
    } else if [
        "ENOTFOUND",
        "ETIMEDOUT",
        "ECONNRESET",
        "ECONNREFUSED",
        "ENETUNREACH",
        "EAI_AGAIN",
    ]
    .iter()
    .any(|code| output.contains(code))
    {
        "network_unavailable"
    } else if ["E401", "E403", "ENEEDAUTH"]
        .iter()
        .any(|code| output.contains(code))
    {
        "cli_registry_access"
    } else {
        "cli_command_failed"
    };
    match exit_code {
        Some(code) => format!("{category}:exit={code}"),
        None => category.into(),
    }
}
pub fn installed_version(executable: &str) -> Option<String> {
    run_bounded(executable, &["--version".into()], Duration::from_secs(6))
        .ok()
        .and_then(|text| version(&text))
}

pub fn terminate_probe(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        let _ = crate::util::background_command("taskkill.exe")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn npm_command() -> Result<(String, Vec<String>), String> {
    let npm = crate::cli_detect::resolve_command_path("npm");
    #[cfg(windows)]
    {
        // npm.cmd uses variables rather than the simple generated package shim.
        // Execute npm's JS entry through Node, avoiding cmd.exe interpolation.
        let folder = Path::new(&npm).parent().ok_or("unsupported_installation")?;
        let script = folder.join("node_modules/npm/bin/npm-cli.js");
        if !script.is_file() {
            return Err("unsupported_installation".into());
        }
        let node = folder.join("node.exe");
        let node = if node.is_file() {
            node.to_string_lossy().into_owned()
        } else {
            crate::cli_detect::resolve_command_path("node")
        };
        Ok((node, vec![script.to_string_lossy().into_owned()]))
    }
    #[cfg(not(windows))]
    Ok((npm, vec![]))
}

fn npm_prefix(executable: &str, name: &str) -> Option<PathBuf> {
    // Follow Unix launch symlinks and Windows npm wrappers. Only update the
    // prefix which actually owns this CLI, never a second unrelated install.
    let (native, args) = crate::util::resolve_windows_pty_command(executable, &[]);
    for path in std::iter::once(PathBuf::from(executable))
        .chain(std::iter::once(PathBuf::from(native)))
        .chain(args.iter().map(PathBuf::from))
    {
        let path = std::fs::canonicalize(&path).unwrap_or(path);
        for parent in path.ancestors().skip(1) {
            for root in [parent.join("node_modules"), parent.join("lib/node_modules")] {
                let metadata = root.join(name).join("package.json");
                if metadata.is_file()
                    && (path.starts_with(root.join(name))
                        || path.parent() == Some(parent)
                            && parent.join("node_modules").join(name).is_dir())
                {
                    if let Ok(text) = std::fs::read_to_string(metadata) {
                        if serde_json::from_str::<serde_json::Value>(&text)
                            .ok()
                            .is_some_and(|value| value["name"] == name)
                        {
                            #[cfg(unix)]
                            if parent.file_name().is_some_and(|name| name == "lib")
                                && root == parent.join("node_modules")
                            {
                                return parent.parent().map(Path::to_path_buf);
                            }
                            return Some(parent.to_path_buf());
                        }
                    }
                }
            }
        }
    }
    None
}

/// Rust canonicalization returns a Windows verbatim path. npm's Arborist can
/// recurse indefinitely on that prefix; pass the equivalent DOS/UNC path at
/// the process boundary, keeping canonical paths for filesystem comparisons.
fn npm_prefix_argument(prefix: &Path) -> String {
    let value = prefix.to_string_lossy();
    #[cfg(windows)]
    if let Some(rest) = value.strip_prefix(r"\\?\") {
        if let Some(unc) = rest
            .strip_prefix("UNC\\")
            .or_else(|| rest.strip_prefix("unc\\"))
        {
            return format!(r"\\{unc}");
        }
        if rest.as_bytes().get(1) == Some(&b':') && rest.as_bytes().get(2) == Some(&b'\\') {
            return rest.to_owned();
        }
    }
    value.into_owned()
}

fn npm_install_arguments(prefix: &Path, specification: &str) -> Vec<String> {
    vec![
        "install".into(),
        "--global".into(),
        "--prefix".into(),
        npm_prefix_argument(prefix),
        specification.into(),
        "--registry=https://registry.npmjs.org".into(),
        "--no-audit".into(),
        "--no-fund".into(),
    ]
}

fn install_npm_package(prefix: &Path, provider: &str, target: &str) -> Result<(), String> {
    if version(target).as_deref() != Some(target) {
        return Err("unsupported_cli_version".into());
    }
    let (npm, mut args) = npm_command()?;
    args.extend(npm_install_arguments(
        prefix,
        &format!("{}@{target}", package(provider)?),
    ));
    run_bounded(&npm, &args, Duration::from_secs(180)).map(|_| ())
}
fn method(provider: &str, executable: &str) -> String {
    if package(provider)
        .ok()
        .and_then(|name| npm_prefix(executable, name))
        .is_some()
    {
        return "npm".into();
    }
    if provider == "claude-code"
        && crate::util::home_dir()
            .is_some_and(|home| Path::new(executable).starts_with(home.join(".local")))
    {
        return "native".into();
    }
    "manual".into()
}
fn latest_version(provider: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| "network_unavailable")?;
    let response = client
        .get(format!(
            "https://registry.npmjs.org/{}/latest",
            package(provider)?
        ))
        .send()
        .and_then(|res| res.error_for_status())
        .map_err(|_| "network_unavailable")?;
    let mut text = String::new();
    response
        .take(512 * 1024)
        .read_to_string(&mut text)
        .map_err(|_| "network_unavailable")?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "network_unavailable")?;
    value["version"]
        .as_str()
        .and_then(version)
        .ok_or_else(|| "network_unavailable".into())
}
fn check(provider: &str, cli_path: &str) -> Result<CliUpdate, String> {
    package(provider)?;
    let executable = crate::util::find_cli_path(provider, cli_path);
    let installed = installed_version(&executable);
    let latest = latest_version(provider);
    let error = latest
        .as_ref()
        .err()
        .cloned()
        .or_else(|| installed.is_none().then(|| "cli_unavailable".into()));
    let latest = latest.ok();
    Ok(CliUpdate {
        provider: provider.into(),
        update_available: installed
            .as_deref()
            .zip(latest.as_deref())
            .is_some_and(|(a, b)| newer(a, b)),
        method: method(provider, &executable),
        executable,
        installed,
        latest,
        error,
    })
}
#[tauri::command]
pub async fn check_cli_update(
    provider: String,
    cli_path: Option<String>,
) -> Result<CliUpdate, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = launch_guard()?;
        check(&provider, cli_path.as_deref().unwrap_or_default())
    })
    .await
    .map_err(|_| "cli_unavailable".to_string())?
}
#[tauri::command]
pub async fn update_agent_cli(
    app: tauri::AppHandle,
    provider: String,
    cli_path: Option<String>,
) -> Result<CliUpdate, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = update_guard()?;
        if crate::chat::has_active_processes(&app)
            || !app
                .state::<crate::state::PtyKillerMap>()
                .lock()
                .map_err(|_| "cli_busy")?
                .is_empty()
            || !app
                .state::<crate::state::ProcessMap>()
                .lock()
                .map_err(|_| "cli_busy")?
                .is_empty()
        {
            return Err("cli_busy".into());
        }
        let path = cli_path.as_deref().unwrap_or_default();
        let before = check(&provider, path)?;
        let target = before.latest.as_deref().ok_or("network_unavailable")?;
        if before.installed.is_none() {
            return Err("cli_unavailable".into());
        }
        if !before.update_available {
            return Ok(before);
        }
        match before.method.as_str() {
            "npm" => {
                let name = package(&provider)?;
                let prefix =
                    npm_prefix(&before.executable, name).ok_or("unsupported_installation")?;
                install_npm_package(&prefix, &provider, target)?;
            }
            "native" => {
                run_bounded(
                    &before.executable,
                    &["update".into()],
                    Duration::from_secs(180),
                )?;
            }
            _ => return Err("unsupported_installation".into()),
        }
        crate::cli_detect::clear_command_cache();
        let after = check(&provider, path)?;
        if after
            .installed
            .as_deref()
            .is_none_or(|installed| newer(installed, target))
        {
            return Err("cli_version_unchanged".into());
        }
        Ok(after)
    })
    .await
    .map_err(|_| "cli_command_failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(windows)]
    fn npm_arguments_remove_verbatim_prefixes_without_changing_spaces_or_unc() {
        for (input, expected) in [
            (
                r"\\?\C:\Users\Example User\Tuxão\npm",
                r"C:\Users\Example User\Tuxão\npm",
            ),
            (
                r"\\?\UNC\server\share\pasta com espaços",
                r"\\server\share\pasta com espaços",
            ),
            (r"C:\Users\Example User\npm", r"C:\Users\Example User\npm"),
        ] {
            let args = npm_install_arguments(Path::new(input), "@openai/codex@0.160.1");
            assert_eq!(args[3], expected);
            assert_eq!(args[4], "@openai/codex@0.160.1");
        }
    }
    #[test]
    fn installer_errors_are_actionable_bounded_and_never_leak_credentials() {
        for (message, expected) in [
            (
                "npm error Maximum call stack size exceeded",
                "cli_path_error",
            ),
            ("npm error code EPERM", "cli_files_in_use"),
            ("npm error code EACCES", "cli_permission_denied"),
            ("npm error code ENOSPC", "cli_disk_full"),
            ("npm error code ENOTFOUND", "network_unavailable"),
            ("npm error code CERT_HAS_EXPIRED", "cli_certificate_error"),
            ("npm error code E403", "cli_registry_access"),
            ("unexpected failure", "cli_command_failed"),
        ] {
            let error = command_failure(
                &format!("{message}\nhttps://user:secret@registry.invalid/token"),
                "private output",
                Some(1),
            );
            assert_eq!(error, format!("{expected}:exit=1"));
        }
        let input = format!("{}ENOSPC", "a".repeat(32000));
        let output = bounded_output(input.as_bytes());
        assert_eq!(output.len(), 16 * 1024);
        assert!(output.ends_with("ENOSPC"));
    }
    #[test]
    #[cfg(windows)]
    fn command_drains_both_pipes_and_reports_stderr_failure() {
        let script = "[Console]::Out.Write(('x' * 262144)); [Console]::Error.Write(('y' * 262144)); [Console]::Error.WriteLine('ENOSPC'); exit 17";
        let result = run_bounded(
            "powershell.exe",
            &[
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                script.into(),
            ],
            Duration::from_secs(10),
        );
        assert_eq!(result.unwrap_err(), "cli_disk_full:exit=17");
    }

    #[test]
    #[ignore = "Installs and upgrades official CLIs in an isolated temporary npm prefix; no global changes or inference"]
    fn npm_real_cli_install_and_update_smoke() {
        let root =
            std::env::temp_dir().join(format!("Agentdeck QA Tuxão {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let canonical = std::fs::canonicalize(&root).unwrap();
        let result = (|| -> Result<(), String> {
            for (provider, baseline, bin) in [
                ("claude-code", "2.1.287", "claude"),
                ("codex", "0.160.0", "codex"),
            ] {
                let latest = latest_version(provider)?;
                let executable = root.join(if cfg!(windows) {
                    format!("{bin}.cmd")
                } else {
                    format!("bin/{bin}")
                });
                println!("{provider}: installing baseline {baseline} in isolated prefix");
                install_npm_package(&canonical, provider, baseline)?;
                assert_eq!(
                    installed_version(&executable.to_string_lossy()).as_deref(),
                    Some(baseline)
                );
                let detected = npm_prefix(&executable.to_string_lossy(), package(provider)?)
                    .ok_or("prefix_not_detected")?;
                assert_eq!(detected, canonical);
                println!("{provider}: upgrading {baseline} -> {latest} with detected prefix");
                install_npm_package(&detected, provider, &latest)?;
                assert_eq!(
                    installed_version(&executable.to_string_lossy()).as_deref(),
                    Some(latest.as_str())
                );
                println!("{provider}: installed version verified: {latest}");
            }
            Ok(())
        })();
        assert!(canonical.starts_with(std::fs::canonicalize(std::env::temp_dir()).unwrap()));
        std::fs::remove_dir_all(&canonical).unwrap();
        result.unwrap();
    }
    #[test]
    fn numeric_versions_and_packages_are_validated() {
        assert_eq!(version("codex-cli 0.160.0\n"), Some("0.160.0".into()));
        assert_eq!(version("2.1.287 (Claude Code)"), Some("2.1.287".into()));
        assert!(newer("2.1.99", "2.1.292"));
        assert!(!newer("2.2.0", "2.1.292"));
        assert!(version("2.1.292;bad").is_none());
        assert!(package("bad;command").is_err());
    }
    #[test]
    fn updates_exclude_launches_and_duplicate_updates() {
        let launch = launch_guard().unwrap();
        assert!(update_guard().is_err());
        drop(launch);
        let update = update_guard().unwrap();
        assert!(launch_guard().is_err());
        assert!(update_guard().is_err());
        drop(update);
        assert!(launch_guard().is_ok());
    }
    #[test]
    fn npm_prefix_is_scoped_to_the_installed_package() {
        let root = std::env::temp_dir().join(format!("agentdeck-update-{}", uuid::Uuid::new_v4()));
        let module = root.join("node_modules/@anthropic-ai/claude-code");
        std::fs::create_dir_all(module.join("bin")).unwrap();
        let executable = module.join("bin/claude.exe");
        std::fs::write(&executable, b"").unwrap();
        std::fs::write(
            module.join("package.json"),
            r#"{"name":"@anthropic-ai/claude-code"}"#,
        )
        .unwrap();
        assert_eq!(
            npm_prefix(&executable.to_string_lossy(), "@anthropic-ai/claude-code").unwrap(),
            std::fs::canonicalize(&root).unwrap()
        );
        assert!(npm_prefix(&executable.to_string_lossy(), "@openai/codex").is_none());
        let target = std::fs::canonicalize(root).unwrap();
        assert!(target.starts_with(std::fs::canonicalize(std::env::temp_dir()).unwrap()));
        std::fs::remove_dir_all(target).unwrap();
    }
    #[test]
    #[ignore = "Opt-in installed CLI / registry read-only smoke test; no update or inference"]
    fn installed_cli_update_metadata_smoke() {
        for provider in ["claude-code", "codex"] {
            let result = check(provider, "").unwrap();
            println!("{}", serde_json::to_string(&result).unwrap());
            assert!(result.installed.is_some());
            assert!(result.latest.is_some());
            assert_eq!(result.method, "npm");
            let prefix = npm_prefix(&result.executable, package(provider).unwrap()).unwrap();
            assert!(prefix.is_dir());
        }
        let (npm, mut args) = npm_command().unwrap();
        args.push("--version".into());
        assert!(version(&run_bounded(&npm, &args, Duration::from_secs(8)).unwrap()).is_some());
    }
}
