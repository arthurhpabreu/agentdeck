//! Native platform details and subprocess environments shared by every transport.
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

#[derive(serde::Serialize)]
pub struct RuntimePlatform {
    os: &'static str,
    arch: &'static str,
}

#[tauri::command]
pub fn get_runtime_platform() -> RuntimePlatform {
    RuntimePlatform {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

#[derive(serde::Serialize)]
pub struct DefaultShell {
    command: String,
    args: Vec<String>,
}

#[tauri::command]
pub fn get_default_shell() -> DefaultShell {
    #[cfg(windows)]
    let (command, args) = (
        std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()),
        vec!["/K".into()],
    );
    #[cfg(not(windows))]
    let (command, args) = (login_shell(), vec!["-l".into(), "-i".into()]);
    DefaultShell { command, args }
}

#[cfg(not(windows))]
pub fn login_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|shell| Path::new(shell).is_absolute() && Path::new(shell).is_file())
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".into()
            } else {
                "/bin/sh".into()
            }
        })
}

fn prepend_paths(base: &OsStr, additions: impl IntoIterator<Item = PathBuf>) -> std::ffi::OsString {
    let mut paths = Vec::new();
    for path in additions.into_iter().chain(std::env::split_paths(base)) {
        if !path.as_os_str().is_empty() && !paths.contains(&path) {
            paths.push(path);
        }
    }
    std::env::join_paths(paths).unwrap_or_else(|_| base.to_owned())
}

/// Finder launches do not inherit shell dotfiles. Include conventional native
/// installations without executing user startup scripts during application boot.
pub fn initialize_environment() {
    #[cfg(target_os = "macos")]
    {
        let mut directories = Vec::new();
        if let Some(home) = crate::util::home_dir() {
            directories.extend([
                home.join(".local/bin"),
                home.join(".cargo/bin"),
                home.join(".volta/bin"),
            ]);
        }
        directories.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/opt/homebrew/sbin"),
            PathBuf::from("/usr/local/bin"),
        ]);
        let base = std::env::var_os("PATH").unwrap_or_default();
        std::env::set_var("PATH", prepend_paths(&base, directories));
    }
}

/// Node scripts discovered via a version manager need the same Node installation
/// in PATH when their shebang or nested package commands use `/usr/bin/env node`.
pub fn process_path(executable: &Path) -> std::ffi::OsString {
    let node = crate::cli_detect::resolve_command_path("node");
    let node = Path::new(&node);
    let additions = executable
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .into_iter()
        .chain(node.parent().filter(|path| !path.as_os_str().is_empty()))
        .map(Path::to_path_buf);
    prepend_paths(&std::env::var_os("PATH").unwrap_or_default(), additions)
}

/// Single-quoted POSIX argument. The generated command invokes only our local
/// executable; paths are data and never become shell syntax.
#[cfg(any(unix, test))]
pub fn quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn executable_paths_preserve_spaces_and_deduplicate() {
        let first = PathBuf::from("/Applications/Agent Deck.app/Contents/MacOS");
        let second = PathBuf::from("/opt/homebrew/bin");
        let base = std::env::join_paths([first.clone(), second.clone()]).unwrap();
        let result = prepend_paths(&base, [first.clone(), first.clone()]);
        assert_eq!(
            std::env::split_paths(&result).collect::<Vec<_>>(),
            [first, second]
        );
    }
    #[test]
    fn posix_arguments_preserve_apostrophes_and_shell_metacharacters() {
        assert_eq!(
            quote_posix("/Users/O'Brien/$data `literal`"),
            "'/Users/O'\\''Brien/$data `literal`'"
        );
    }
}
