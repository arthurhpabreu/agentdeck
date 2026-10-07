use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::Serialize;
use tauri::Manager;

use crate::util::expand_path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileReadResult {
    path: String,
    content: String,
    version_token: Option<String>,
    is_binary: bool,
    missing: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileWriteResult {
    path: String,
    version_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDirectoryEntry {
    name: String,
    path: String,
    kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDirectoryListResult {
    path: String,
    entries: Vec<SessionDirectoryEntry>,
}

fn session_root(app: &tauri::AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let sanitized = session_id.trim();
    if sanitized.is_empty() {
        return Err(crate::i18n::native_text("native.missingSession", "session id").into());
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| crate::i18n::native_text("native.parse", &format!("app data : {e}")))?
        .join("ui-state")
        .join(format!("session-workdir-{sanitized}.txt"));
    let content = fs::read_to_string(&path).map_err(|e| {
        crate::i18n::native_text(
            "native.read",
            &format!("session workdir {}: {e}", path.display()),
        )
    })?;
    let root = PathBuf::from(expand_path(content.trim()));
    if !root.exists() {
        return Err(crate::i18n::native_text(
            "native.missingDirectory",
            &format!("session workdir : {}", root.display()),
        ));
    }
    root.canonicalize().map_err(|e| {
        crate::i18n::native_text(
            "native.parse",
            &format!("session workdir {}: {e}", root.display()),
        )
    })
}

fn validate_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let trimmed = relative_path.trim();
    if trimmed.is_empty() {
        return Ok(PathBuf::new());
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        return Err(crate::i18n::native_text("native.relative", "").into());
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(crate::i18n::native_text("native.outside", "session").into());
    }
    Ok(path)
}

fn resolve_session_file(
    app: &tauri::AppHandle,
    session_id: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let root = session_root(app, session_id)?;
    let relative = validate_relative_path(relative_path)?;
    if relative.as_os_str().is_empty() {
        return Ok(root);
    }

    let joined = root.join(relative);
    let canonical_parent = joined
        .parent()
        .unwrap_or(root.as_path())
        .canonicalize()
        .map_err(|e| {
            crate::i18n::native_text("native.parse", &format!("{}: {e}", joined.display()))
        })?;
    if !canonical_parent.starts_with(&root) {
        return Err(crate::i18n::native_text("native.outside", "session").into());
    }

    Ok(joined)
}

fn file_version_token(path: &Path) -> Result<Option<String>, String> {
    match fs::metadata(path) {
        Ok(metadata) => {
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis())
                .unwrap_or(0);
            Ok(Some(format!("{}:{}", metadata.len(), modified)))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(crate::i18n::native_text(
            "native.read",
            &format!("{}: {e}", path.display()),
        )),
    }
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(2048).any(|byte| *byte == 0)
}

#[tauri::command]
pub fn remember_session_workdir(
    app: tauri::AppHandle,
    session_id: String,
    workdir: String,
) -> Result<(), String> {
    let sanitized = session_id.trim();
    if sanitized.is_empty() {
        return Err(crate::i18n::native_text("native.missingSession", "session id").into());
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| crate::i18n::native_text("native.parse", &format!("app data : {e}")))?
        .join("ui-state")
        .join(format!("session-workdir-{sanitized}.txt"));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            crate::i18n::native_text("native.create", &format!("{}: {e}", parent.display()))
        })?;
    }
    fs::write(&path, expand_path(workdir.trim())).map_err(|e| {
        crate::i18n::native_text(
            "native.write",
            &format!("session workdir {}: {e}", path.display()),
        )
    })
}

#[tauri::command]
pub fn remove_session_workdir(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let sanitized = session_id.trim();
    if sanitized.is_empty() {
        return Ok(());
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| crate::i18n::native_text("native.parse", &format!("app data : {e}")))?
        .join("ui-state")
        .join(format!("session-workdir-{sanitized}.txt"));
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(crate::i18n::native_text(
            "native.delete",
            &format!("session workdir {}: {e}", path.display()),
        )),
    }
}

#[tauri::command]
pub fn read_session_file(
    app: tauri::AppHandle,
    session_id: String,
    relative_path: String,
) -> Result<SessionFileReadResult, String> {
    let full_path = resolve_session_file(&app, &session_id, &relative_path)?;
    match fs::read(&full_path) {
        Ok(bytes) => {
            let binary = is_binary(&bytes);
            let content = if binary {
                String::new()
            } else {
                String::from_utf8(bytes).map_err(|e| {
                    crate::i18n::native_text(
                        "native.utf8",
                        &format!("UTF-8 {}: {e}", full_path.display()),
                    )
                })?
            };
            Ok(SessionFileReadResult {
                path: relative_path,
                content,
                version_token: file_version_token(&full_path)?,
                is_binary: binary,
                missing: false,
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SessionFileReadResult {
            path: relative_path,
            content: String::new(),
            version_token: None,
            is_binary: false,
            missing: true,
        }),
        Err(e) => Err(crate::i18n::native_text(
            "native.read",
            &format!("{}: {e}", full_path.display()),
        )),
    }
}

#[tauri::command]
pub fn write_session_file(
    app: tauri::AppHandle,
    session_id: String,
    relative_path: String,
    content: String,
    expected_version_token: Option<String>,
) -> Result<SessionFileWriteResult, String> {
    let full_path = resolve_session_file(&app, &session_id, &relative_path)?;
    let current_token = file_version_token(&full_path)?;
    if current_token != expected_version_token {
        return Err(crate::i18n::native_text("native.external", "").into());
    }
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            crate::i18n::native_text("native.create", &format!("{}: {e}", parent.display()))
        })?;
    }

    let tmp_path = full_path.with_extension("agentdeck.tmp");
    {
        let mut file = fs::File::create(&tmp_path).map_err(|e| {
            crate::i18n::native_text("native.create", &format!("{}: {e}", tmp_path.display()))
        })?;
        file.write_all(content.as_bytes()).map_err(|e| {
            crate::i18n::native_text("native.write", &format!("{}: {e}", tmp_path.display()))
        })?;
        file.sync_all().map_err(|e| {
            crate::i18n::native_text("native.write", &format!("{}: {e}", tmp_path.display()))
        })?;
    }
    fs::rename(&tmp_path, &full_path).map_err(|e| {
        crate::i18n::native_text("native.replace", &format!("{}: {e}", full_path.display()))
    })?;

    Ok(SessionFileWriteResult {
        path: relative_path,
        version_token: file_version_token(&full_path)?,
    })
}

#[tauri::command]
pub fn list_session_directory(
    app: tauri::AppHandle,
    session_id: String,
    relative_path: String,
) -> Result<SessionDirectoryListResult, String> {
    let full_path = resolve_session_file(&app, &session_id, &relative_path)?;
    let metadata = fs::metadata(&full_path).map_err(|e| {
        crate::i18n::native_text("native.read", &format!("{}: {e}", full_path.display()))
    })?;
    if !metadata.is_dir() {
        return Err(crate::i18n::native_text(
            "native.notDirectory",
            &format!("{}", full_path.display()),
        ));
    }

    let mut entries = fs::read_dir(&full_path)
        .map_err(|e| {
            crate::i18n::native_text("native.read", &format!("{}: {e}", full_path.display()))
        })?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy().to_string();
            if name == ".git" {
                return None;
            }
            let file_type = entry.file_type().ok()?;
            let child_path = if relative_path.trim().is_empty() {
                name.clone()
            } else {
                format!("{}/{}", relative_path.trim_matches('/'), name)
            };
            Some(SessionDirectoryEntry {
                name,
                path: child_path,
                kind: if file_type.is_dir() {
                    "dir".into()
                } else {
                    "file".into()
                },
            })
        })
        .collect::<Vec<_>>();

    entries.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("dir", "file") => std::cmp::Ordering::Less,
        ("file", "dir") => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(SessionDirectoryListResult {
        path: relative_path,
        entries,
    })
}
