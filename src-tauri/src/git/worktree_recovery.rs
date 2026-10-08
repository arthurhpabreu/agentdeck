use super::worktree::{ensure_clean_worktree, remove_worktree};
use crate::{
    runtime_scope::session_worktree_root_dir,
    util::{background_command, expand_path},
};
use serde::Serialize;
use std::{fs, path::Path};
use tauri::Manager;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    path: String,
    branch: String,
    head: String,
    reason: String,
    can_remove: bool,
}

fn git(workdir: &str, args: &[&str]) -> Result<String, String> {
    let out = background_command("git")
        .current_dir(workdir)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn inspect(workdir: &str, in_use: impl Fn(&Path) -> bool) -> Result<Vec<RecoveryEntry>, String> {
    let root_text = git(workdir, &["rev-parse", "--show-toplevel"])?;
    let root = fs::canonicalize(root_text.trim()).map_err(|e| e.to_string())?;
    let managed = root
        .parent()
        .ok_or("Repository has no parent")?
        .join(session_worktree_root_dir());
    let output = git(workdir, &["worktree", "list", "--porcelain", "-z"])?;
    let mut raw = Vec::new();
    let mut entry: Option<RecoveryEntry> = None;
    for field in output.split('\0') {
        if let Some(path) = field.strip_prefix("worktree ") {
            if let Some(previous) = entry.take() {
                raw.push(previous);
            }
            entry = Some(RecoveryEntry {
                path: path.into(),
                ..Default::default()
            });
        } else if let Some(current) = entry.as_mut() {
            if let Some(head) = field.strip_prefix("HEAD ") {
                current.head = head.into();
            }
            if let Some(branch) = field.strip_prefix("branch refs/heads/") {
                current.branch = branch.into();
            }
            if field == "locked" || field.starts_with("locked ") {
                current.reason = "locked".into();
            }
        }
    }
    if let Some(previous) = entry {
        raw.push(previous);
    }
    let mut entries = Vec::new();
    for mut entry in raw {
        let path = Path::new(&entry.path);
        let Ok(parent) = path
            .parent()
            .ok_or(())
            .and_then(|parent| fs::canonicalize(parent).map_err(|_| ()))
        else {
            continue;
        };
        let legacy_nested = parent.starts_with(&root)
            && parent
                .file_name()
                .is_some_and(|name| name == session_worktree_root_dir());
        if (parent != managed && !legacy_nested)
            || !path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("session-"))
        {
            continue;
        }
        let canonical = fs::canonicalize(path);
        if canonical
            .as_ref()
            .is_ok_and(|path| path.parent() != Some(parent.as_path()))
            || fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
        {
            continue;
        }
        if let Ok(path) = canonical {
            if in_use(&path) {
                entry.reason = "in_use".into();
            } else if entry.branch.is_empty() {
                entry.reason = "detached".into();
            } else if entry.reason != "locked" {
                entry.reason = if ensure_clean_worktree(&entry.path).is_ok() {
                    "clean"
                } else {
                    "dirty"
                }
                .into();
            }
        } else {
            entry.reason = "unavailable".into();
        }
        entry.can_remove = entry.reason == "clean";
        entries.push(entry);
    }
    Ok(entries)
}

pub(super) fn in_use(app: &tauri::AppHandle, path: &Path) -> bool {
    if crate::chat::uses_workdir(app, path) {
        return true;
    }
    let metadata = app.state::<crate::state::PtySessionMetaMap>();
    metadata
        .lock()
        .map(|sessions| {
            sessions.values().any(|session| {
                fs::canonicalize(expand_path(&session.workdir))
                    .is_ok_and(|dir| dir.starts_with(path))
            })
        })
        .unwrap_or(true)
}

fn cleanup(
    workdir: &str,
    path: &str,
    expected_head: &str,
    in_use: impl Fn(&Path) -> bool,
) -> Result<(), String> {
    let target = fs::canonicalize(path).map_err(|e| e.to_string())?;
    let entry = inspect(workdir, &in_use)?
        .into_iter()
        .find(|entry| fs::canonicalize(&entry.path).is_ok_and(|path| path == target))
        .ok_or("This folder is not a registered Agent Deck worktree for this repository")?;
    if !entry.can_remove {
        return Err(format!(
            "Worktree preserved: {} ({})",
            entry.reason, entry.path
        ));
    }
    if entry.head.is_empty() || entry.head != expected_head {
        return Err("Worktree changed since inspection. Refresh before cleaning.".into());
    }
    if in_use(&target) {
        return Err("Worktree is in use".into());
    }
    // Git rechecks dirty/locked state. The branch is always retained for recovery.
    remove_worktree(workdir, &entry.path)
}

#[tauri::command]
pub async fn list_recoverable_worktrees(
    app: tauri::AppHandle,
    workdir: String,
) -> Result<Vec<RecoveryEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        inspect(&expand_path(&workdir), |path| in_use(&app, path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn remove_recoverable_worktree(
    app: tauri::AppHandle,
    workdir: String,
    worktree_path: String,
    expected_head: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        cleanup(
            &expand_path(&workdir),
            &expand_path(&worktree_path),
            &expected_head,
            |path| in_use(&app, path),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_recoverable_worktree(
    app: tauri::AppHandle,
    workdir: String,
    worktree_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = fs::canonicalize(expand_path(&worktree_path)).map_err(|e| e.to_string())?;
        let entry = inspect(&expand_path(&workdir), |path| in_use(&app, path))?
            .into_iter()
            .find(|entry| fs::canonicalize(&entry.path).is_ok_and(|other| other == path))
            .ok_or("Worktree is not registered")?;
        #[cfg(target_os = "windows")]
        let mut command = background_command("explorer.exe");
        #[cfg(target_os = "macos")]
        let mut command = background_command("open");
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        let mut command = background_command("xdg-open");
        command.arg(entry.path).spawn().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    struct Fixture {
        directory: PathBuf,
        repo: PathBuf,
        managed: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("agentdeck-recovery-{}", uuid::Uuid::new_v4()));
            let repo = directory.join("repo");
            let managed = directory.join(session_worktree_root_dir());
            fs::create_dir_all(&repo).unwrap();
            fs::create_dir_all(&managed).unwrap();
            for args in [
                &["init"][..],
                &["config", "user.name", "QA fixture"],
                &["config", "user.email", "qa@example.invalid"],
            ] {
                git(repo.to_str().unwrap(), args).unwrap();
            }
            fs::write(repo.join("file.txt"), "initial").unwrap();
            fs::write(repo.join(".gitignore"), "ignored.txt\n").unwrap();
            git(repo.to_str().unwrap(), &["add", "."]).unwrap();
            git(repo.to_str().unwrap(), &["commit", "-m", "fixture"]).unwrap();
            Self {
                directory,
                repo,
                managed,
            }
        }
        fn worktree(&self, name: &str) -> PathBuf {
            let path = self.managed.join(format!("session-{name}"));
            git(
                self.repo.to_str().unwrap(),
                &["worktree", "add", "-b", name, path.to_str().unwrap()],
            )
            .unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let path = fs::canonicalize(&self.directory).unwrap();
            let temp = fs::canonicalize(std::env::temp_dir()).unwrap();
            assert_eq!(path.parent(), Some(temp.as_path()));
            assert!(path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("agentdeck-recovery-"));
            let _ = fs::remove_dir_all(path);
        }
    }
    #[test]
    fn cleanup_revalidates_files_commits_and_ownership_and_keeps_branch() {
        let fixture = Fixture::new();
        let repo = fixture.repo.to_str().unwrap();
        let path = fixture.worktree("clean");
        let entry = inspect(repo, |_| false).unwrap().remove(0);
        assert!(entry.can_remove);
        fs::write(path.join("ignored.txt"), "local build output").unwrap();
        assert!(cleanup(repo, path.to_str().unwrap(), &entry.head, |_| false).is_err());
        assert_eq!(
            fs::read_to_string(path.join("ignored.txt")).unwrap(),
            "local build output"
        );
        fs::remove_file(path.join("ignored.txt")).unwrap();
        fs::write(path.join("file.txt"), "new commit").unwrap();
        git(path.to_str().unwrap(), &["add", "."]).unwrap();
        git(path.to_str().unwrap(), &["commit", "-m", "new work"]).unwrap();
        assert!(cleanup(repo, path.to_str().unwrap(), &entry.head, |_| false).is_err());
        let next = inspect(repo, |_| false).unwrap().remove(0);
        assert!(cleanup(repo, path.to_str().unwrap(), &next.head, |_| true).is_err());
        let unknown = fixture.managed.join("session-not-registered");
        fs::create_dir(&unknown).unwrap();
        fs::write(unknown.join("keep.txt"), "keep").unwrap();
        assert!(cleanup(repo, unknown.to_str().unwrap(), &next.head, |_| false).is_err());
        cleanup(repo, path.to_str().unwrap(), &next.head, |_| false).unwrap();
        assert!(!path.exists());
        assert!(unknown.join("keep.txt").exists());
        git(repo, &["show-ref", "--verify", "refs/heads/clean"]).unwrap();
        assert_eq!(
            fs::read_to_string(fixture.repo.join("file.txt")).unwrap(),
            "initial"
        );
    }
    #[test]
    fn inspection_blocks_locked_detached_and_active_and_finds_legacy_subfolders() {
        let fixture = Fixture::new();
        let repo = fixture.repo.to_str().unwrap();
        let locked = fixture.worktree("locked");
        let detached = fixture.worktree("detached");
        let active = fixture.worktree("active");
        git(repo, &["worktree", "lock", locked.to_str().unwrap()]).unwrap();
        git(detached.to_str().unwrap(), &["checkout", "--detach"]).unwrap();
        let nested = fixture
            .repo
            .join("subfolder")
            .join(session_worktree_root_dir())
            .join("session-legacy");
        fs::create_dir_all(nested.parent().unwrap()).unwrap();
        git(
            repo,
            &["worktree", "add", "-b", "legacy", nested.to_str().unwrap()],
        )
        .unwrap();
        let active = fs::canonicalize(active).unwrap();
        let rows = inspect(repo, |path| path == active).unwrap();
        assert_eq!(rows.len(), 4);
        for (name, reason) in [
            ("session-locked", "locked"),
            ("session-detached", "detached"),
            ("session-active", "in_use"),
        ] {
            let row = rows.iter().find(|row| row.path.ends_with(name)).unwrap();
            assert_eq!(row.reason, reason);
            assert!(!row.can_remove);
        }
        let row = rows.iter().find(|row| row.branch == "legacy").unwrap();
        assert!(row.can_remove);
        let row = rows
            .iter()
            .find(|row| row.path.ends_with("session-detached"))
            .unwrap();
        assert!(cleanup(repo, &row.path, &row.head, |_| false).is_err());
        assert!(detached.exists());
    }
}
