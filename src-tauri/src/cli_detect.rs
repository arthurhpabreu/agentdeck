use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

#[cfg(windows)]
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};

use crate::util::background_command;

// Command path cache
/// Process-wide cache: command name to full path. Cache misses avoid repeated slow shell lookups.
static CMD_PATH_CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();

fn cmd_path_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    CMD_PATH_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}
pub fn clear_command_cache() {
    if let Ok(mut cache) = cmd_path_cache().lock() {
        cache.clear();
    }
}

/// Resolve an executable path, including installations managed by nvm, mise, fnm, volta, asdf, and pyenv.
///
/// Resolution order:
///   0. Return cached results immediately.
///   1. Return explicit paths directly.
///   2. Search the process PATH for system tools and Homebrew installations.
///   3. Source shell configuration and run which for version managers, with a three-second timeout.
///   4. Scan common installation directories if shell lookup fails.
pub fn resolve_command_path(command: &str) -> String {
    // Explicit paths bypass the cache.
    if is_direct_command_path(command) {
        return command.to_string();
    }

    // Use a cached result when available.
    {
        let cache = cmd_path_cache().lock().unwrap();
        if let Some(cached) = cache.get(command) {
            return cached.clone().unwrap_or_else(|| command.to_string());
        }
    }

    let result = scan_path_env(command)
        .or_else(|| {
            let p = shell_which(command)?;
            eprintln!("[resolve] shell-which: {command} -> {p}");
            Some(p)
        })
        .or_else(|| {
            let p = static_venv_scan(command)?;
            eprintln!("[resolve] static-scan: {command} -> {p}");
            Some(p)
        });

    // Cache both resolved paths and misses to avoid repeating slow lookups.
    {
        let mut cache = cmd_path_cache().lock().unwrap();
        cache.insert(command.to_string(), result.clone());
    }

    normalize_windows_command_path(result.unwrap_or_else(|| command.to_string()))
}

fn is_direct_command_path(command: &str) -> bool {
    #[cfg(windows)]
    {
        Path::new(command).is_absolute() || command.contains('\\') || command.contains('/')
    }

    #[cfg(not(windows))]
    {
        command.contains('/')
    }
}

fn normalize_windows_command_path(command: String) -> String {
    #[cfg(windows)]
    {
        let path = PathBuf::from(&command);
        if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
            if ext.eq_ignore_ascii_case("ps1") {
                for sibling_ext in ["cmd", "bat", "exe", "com"] {
                    let sibling = path.with_extension(sibling_ext);
                    if sibling.exists() {
                        return sibling.to_string_lossy().to_string();
                    }
                }
            }
            return command;
        }

        for ext in ["cmd", "bat", "exe", "com"] {
            let candidate = PathBuf::from(format!("{command}.{ext}"));
            if candidate.exists() {
                return candidate.to_string_lossy().to_string();
            }
        }

        command
    }

    #[cfg(not(windows))]
    {
        command
    }
}

#[cfg(windows)]
fn windows_candidates(command: &str) -> Vec<String> {
    if Path::new(command).extension().is_some() {
        return vec![command.to_string()];
    }

    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let mut candidates = Vec::new();
    for ext in pathext.split(';').filter(|s| !s.is_empty()) {
        candidates.push(format!("{command}{ext}"));
        candidates.push(format!("{command}{}", ext.to_ascii_lowercase()));
    }
    candidates.push(command.to_string());
    candidates.dedup();
    candidates
}

/// Search the process PATH and return the full path of an executable.
fn scan_path_env(command: &str) -> Option<String> {
    let path_var = std::env::var("PATH").ok()?;
    let sep = if cfg!(windows) { ';' } else { ':' };
    for dir in path_var.split(sep).filter(|s| !s.is_empty()) {
        #[cfg(windows)]
        let candidates = windows_candidates(command);
        #[cfg(not(windows))]
        let candidates = vec![command.to_string()];

        for candidate in candidates {
            let full = std::path::PathBuf::from(dir).join(&candidate);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&full) {
                    if meta.permissions().mode() & 0o111 != 0 {
                        return Some(full.to_string_lossy().to_string());
                    }
                }
            }
            #[cfg(not(unix))]
            if full.exists() {
                return Some(full.to_string_lossy().to_string());
            }
        }
    }
    None
}

#[cfg(windows)]
fn shell_which(command: &str) -> Option<String> {
    let script = format!(
        "(Get-Command {command} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)"
    );
    let out = background_command("powershell.exe")
        .args(["-NoProfile", "-Command", &script])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let resolved = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if resolved.is_empty() || !Path::new(&resolved).exists() {
        None
    } else {
        Some(resolved)
    }
}

/// Source the user's shell configuration and run which, with a three-second timeout.
#[cfg(not(windows))]
fn shell_which(command: &str) -> Option<String> {
    use std::time::Duration;

    let script = format!(
        r#"export TERM=dumb
[ -f "$HOME/.zshenv" ] && source "$HOME/.zshenv" 2>/dev/null
[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile" 2>/dev/null
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null
[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null
[ -f "$HOME/.bash_profile" ] && source "$HOME/.bash_profile" 2>/dev/null
which {command} 2>/dev/null | head -1"#
    );

    let candidates = {
        let mut v = vec![];
        if let Ok(s) = std::env::var("SHELL") {
            v.push(s);
        }
        v.push("/bin/zsh".to_string());
        v.push("/bin/bash".to_string());
        v
    };

    for shell in &candidates {
        if !std::path::Path::new(shell.as_str()).exists() {
            continue;
        }
        let mut child = match background_command(shell)
            .args(["-c", &script])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .stdin(std::process::Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => continue,
        };

        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let mut timed_out = false;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        eprintln!("[resolve] shell-which timeout for {command} via {shell}");
                        timed_out = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => break,
            }
        }

        if !timed_out {
            if let Ok(out) = child.wait_with_output() {
                let line = String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .find(|l| !l.trim().is_empty() && l.contains('/'))
                    .map(|l| l.trim().to_string());
                if let Some(p) = line {
                    if std::path::Path::new(&p).exists() {
                        return Some(p);
                    }
                }
            }
        }
    }
    None
}

/// Scan common nvm/fnm/volta/mise/asdf/pyenv/rbenv/cargo/go installation directories.
fn static_venv_scan(command: &str) -> Option<String> {
    #[cfg(windows)]
    {
        let home = crate::util::home_dir()?;
        let dirs = [
            home.join("AppData\\Roaming\\npm"),
            home.join("scoop\\shims"),
            home.join(".cargo\\bin"),
        ];
        for dir in dirs {
            for candidate in windows_candidates(command) {
                let full = dir.join(&candidate);
                if full.exists() {
                    return Some(full.to_string_lossy().to_string());
                }
            }
        }
        return None;
    }

    #[cfg(not(windows))]
    {
        let home = std::path::PathBuf::from(std::env::var("HOME").ok()?);

        let mut dirs: Vec<std::path::PathBuf> = vec![
            "/usr/local/bin".into(),
            "/opt/homebrew/bin".into(),
            "/opt/homebrew/sbin".into(),
        ];

        // nvm: ~/.nvm/versions/node/vX.Y.Z/bin/
        let nvm_root = home.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm_root) {
            let mut versions: Vec<_> = entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .collect();
            versions.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
            for entry in &versions {
                dirs.push(entry.path().join("bin"));
            }
        }

        // fnm: ~/.local/share/fnm/node-versions/vX/installation/bin/
        let fnm_root = home.join(".local/share/fnm/node-versions");
        if let Ok(entries) = std::fs::read_dir(&fnm_root) {
            let mut versions: Vec<_> = entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .collect();
            versions.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
            for entry in &versions {
                dirs.push(entry.path().join("installation/bin"));
            }
        }

        dirs.extend([
            home.join(".volta/bin"),
            home.join(".local/share/mise/shims"),
            home.join(".asdf/shims"),
            home.join(".pyenv/shims"),
            home.join(".pyenv/bin"),
            home.join(".rbenv/shims"),
            home.join(".rbenv/bin"),
            home.join(".cargo/bin"),
            home.join("go/bin"),
        ]);

        for dir in &dirs {
            let full = dir.join(command);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&full) {
                    if meta.permissions().mode() & 0o111 != 0 {
                        return Some(full.to_string_lossy().to_string());
                    }
                }
            }
            #[cfg(not(unix))]
            if full.exists() {
                return Some(full.to_string_lossy().to_string());
            }
        }

        None
    }
}

// ── Tauri Commands ────────────────────────────────────────────────

/// Check whether a CLI is available by resolving its full path.
#[tauri::command]
pub async fn check_cli(command: String) -> bool {
    let resolved = resolve_command_path(&command);
    std::path::Path::new(&resolved).exists()
}

/// Return process environment details for diagnosing PATH/SHELL issues in packaged builds.
#[tauri::command]
pub fn debug_env(command: String) -> serde_json::Value {
    let path = std::env::var("PATH").unwrap_or_else(|_| "<unset>".to_string());
    let shell = if cfg!(windows) {
        std::env::var("ComSpec").unwrap_or_else(|_| "<unset>".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "<unset>".to_string())
    };
    let home = crate::util::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "<unset>".to_string());
    let resolved = resolve_command_path(&command);

    #[cfg(windows)]
    let shell_which = match background_command("powershell.exe")
        .args([
            "-NoProfile",
            "-Command",
            &format!(
                "(Get-Command {command} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)"
            ),
        ])
        .output()
    {
        Ok(out) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        Err(e) => format!("error: {e}"),
    };

    #[cfg(not(windows))]
    let shell_which = if shell != "<unset>" {
        match background_command(&shell)
            .args([
                "-l",
                "-c",
                &format!("which {command} 2>/dev/null; echo SHELL_PATH=$PATH"),
            ])
            .output()
        {
            Ok(out) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
            Err(e) => format!("error: {e}"),
        }
    } else {
        "SHELL not set".to_string()
    };

    serde_json::json!({
        "PATH": path,
        "SHELL": shell,
        "HOME": home,
        "resolved": resolved,
        "shell_which_output": shell_which,
    })
}
