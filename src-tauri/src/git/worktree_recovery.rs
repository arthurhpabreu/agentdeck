use super::{worktree::remove_worktree, worktree_storage};
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
    size_bytes: u64,
    reclaimable_bytes: u64,
    cache_paths: Vec<String>,
    storage_error: Option<String>,
}

fn migration_worktree_root_dir() -> String {
    let name = [".code", "bar", "worktrees"].join("-");
    if cfg!(debug_assertions) {
        format!("{name}-dev")
    } else {
        name
    }
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
    inspect_entries(workdir, in_use, true)
}

fn inspect_entries(
    workdir: &str,
    in_use: impl Fn(&Path) -> bool,
    measure_storage: bool,
) -> Result<Vec<RecoveryEntry>, String> {
    let root_text = git(workdir, &["rev-parse", "--show-toplevel"])?;
    let root = fs::canonicalize(root_text.trim()).map_err(|e| e.to_string())?;
    let repo_parent = root.parent().ok_or("Repository has no parent")?;
    let migration = migration_worktree_root_dir();
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
        // Canonicalization alone conceals junctions and symlinked ancestors.
        if path.exists() && worktree_storage::ensure_plain_path(path).is_err() {
            continue;
        }
        let Ok(parent) = path
            .parent()
            .ok_or(())
            .and_then(|parent| fs::canonicalize(parent).map_err(|_| ()))
        else {
            continue;
        };
        let namespace = parent.file_name().and_then(|name| name.to_str());
        let is_current = namespace == Some(session_worktree_root_dir());
        let is_migration = namespace == Some(migration.as_str());
        let managed_parent = parent.parent() == Some(repo_parent) || parent.starts_with(&root);
        let session_name = path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("session-"));
        // Older installations used descriptive directory names. Git registration
        // still proves ownership; only the matching build namespace is recoverable.
        if !managed_parent || (!is_current && !is_migration) || (is_current && !session_name) {
            continue;
        }
        let canonical = fs::canonicalize(path);
        if canonical
            .as_ref()
            .is_ok_and(|path| path.parent() != Some(parent.as_path()))
            || fs::symlink_metadata(path).is_ok_and(|meta| worktree_storage::is_link(&meta))
        {
            continue;
        }
        if let Ok(path) = canonical {
            if in_use(&path) {
                entry.reason = "in_use".into();
            } else if entry.branch.is_empty() {
                entry.reason = "detached".into();
            } else if entry.reason != "locked" {
                // A directory-level status preserves the same conservative dirty
                // classification without listing every installed dependency file.
                entry.reason = if git(
                    &entry.path,
                    &[
                        "status",
                        "--porcelain",
                        "--untracked-files=normal",
                        "--ignored=matching",
                    ],
                )
                .is_ok_and(|status| status.is_empty())
                {
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
        if measure_storage {
            let storage = worktree_storage::inspect(path);
            entry.size_bytes = storage.size_bytes;
            entry.reclaimable_bytes = storage.reclaimable_bytes;
            entry.cache_paths = storage.cache_paths;
            entry.storage_error = storage.error;
        }
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
    let entry = inspect_entries(workdir, &in_use, false)?
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

fn cleanup_caches(
    workdir: &str,
    path: &str,
    expected_head: &str,
    cache_paths: &[String],
    in_use: impl Fn(&Path) -> bool,
) -> Result<u64, String> {
    if cache_paths.is_empty() {
        return Err("Select at least one inspected cache folder".into());
    }
    worktree_storage::ensure_plain_path(Path::new(path))?;
    let target = fs::canonicalize(path).map_err(|error| error.to_string())?;
    let validate = || -> Result<RecoveryEntry, String> {
        let entry = inspect_entries(workdir, &in_use, false)?
            .into_iter()
            .find(|entry| fs::canonicalize(&entry.path).is_ok_and(|path| path == target))
            .ok_or("This folder is not a registered Agent Deck worktree for this repository")?;
        if !matches!(entry.reason.as_str(), "clean" | "dirty") {
            return Err(format!(
                "Worktree preserved: {} ({})",
                entry.reason, entry.path
            ));
        }
        if entry.head.is_empty()
            || entry.head != expected_head
            || git(path, &["rev-parse", "HEAD"])?.trim() != expected_head
        {
            return Err("Worktree changed since inspection. Refresh before cleaning.".into());
        }
        if in_use(&target) {
            return Err("Worktree is in use".into());
        }
        Ok(entry)
    };
    validate()?;
    let storage = worktree_storage::inspect(&target);
    if cache_paths
        .iter()
        .any(|path| !storage.cache_paths.contains(path))
    {
        return Err("Cache folders changed since inspection. Refresh before cleaning.".into());
    }
    // Measuring a large dependency directory can take time. Recheck session and
    // Git state after measurement and immediately before the validated deletion.
    validate()?;
    worktree_storage::clean_with_guard(&target, cache_paths, || validate().map(|_| ()))
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
pub async fn clean_recoverable_worktree_caches(
    app: tauri::AppHandle,
    workdir: String,
    worktree_path: String,
    expected_head: String,
    cache_paths: Vec<String>,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        cleanup_caches(
            &expand_path(&workdir),
            &expand_path(&worktree_path),
            &expected_head,
            &cache_paths,
            |path| in_use(&app, path),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn open_recoverable_worktree(
    app: tauri::AppHandle,
    workdir: String,
    worktree_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = fs::canonicalize(expand_path(&worktree_path)).map_err(|e| e.to_string())?;
        let entry = inspect_entries(&expand_path(&workdir), |path| in_use(&app, path), false)?
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
            fs::create_dir_all(&directory).unwrap();
            // macOS temp directories can be reached through /var -> /private/var.
            // Test real paths so the production link guard remains strict.
            let directory = fs::canonicalize(directory).unwrap();
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

    fn cache(path: &Path, directory: &str, bytes: &[u8]) {
        fs::create_dir_all(path.join(directory)).unwrap();
        fs::write(path.join(directory).join("cache.bin"), bytes).unwrap();
    }

    fn cache_fixture(fixture: &Fixture, name: &str) -> PathBuf {
        let path = fixture.worktree(name);
        fs::write(path.join("package.json"), "{}").unwrap();
        fs::write(
            path.join("Cargo.toml"),
            "[package]\nname='cache-fixture'\nversion='0.1.0'\n",
        )
        .unwrap();
        fs::create_dir_all(path.join("src-tauri")).unwrap();
        fs::write(
            path.join("src-tauri/Cargo.toml"),
            "[package]\nname='native-fixture'\nversion='0.1.0'\n",
        )
        .unwrap();
        fs::write(
            path.join(".gitignore"),
            "ignored.txt\n.env\n/node_modules/\n/target/\n/src-tauri/target/\n",
        )
        .unwrap();
        path
    }

    #[test]
    fn cache_cleanup_preserves_dirty_sources_ignored_user_files_and_worktree() {
        let fixture = Fixture::new();
        let repo = fixture.repo.to_str().unwrap();
        let path = cache_fixture(&fixture, "caches");
        fs::write(path.join("file.txt"), "unsaved source").unwrap();
        fs::write(path.join(".env"), "private local config").unwrap();
        fs::write(path.join("ignored.txt"), "user data").unwrap();
        cache(&path, "node_modules", b"dependencies");
        cache(&path, "target", b"rust build");
        cache(&path, "src-tauri/target", b"desktop build");
        cache(&path, "dist", b"keep dist");
        cache(&path, "release", b"keep release");
        let entry = inspect(repo, |_| false).unwrap().remove(0);
        assert_eq!(entry.reason, "dirty");
        assert!(!entry.can_remove);
        assert_eq!(entry.cache_paths.len(), 3);
        let expected_bytes = b"dependencies".len() + b"rust build".len() + b"desktop build".len();
        assert_eq!(entry.reclaimable_bytes, expected_bytes as u64);
        assert!(entry.size_bytes > entry.reclaimable_bytes);
        assert!(entry.storage_error.is_none());
        assert_eq!(
            cleanup_caches(
                repo,
                path.to_str().unwrap(),
                &entry.head,
                &entry.cache_paths,
                |_| false
            )
            .unwrap(),
            expected_bytes as u64
        );
        for directory in ["node_modules", "target", "src-tauri/target"] {
            assert!(!path.join(directory).exists());
        }
        for (name, content) in [
            ("file.txt", "unsaved source"),
            (".env", "private local config"),
            ("ignored.txt", "user data"),
            ("dist/cache.bin", "keep dist"),
            ("release/cache.bin", "keep release"),
        ] {
            assert_eq!(fs::read_to_string(path.join(name)).unwrap(), content);
        }
        git(repo, &["show-ref", "--verify", "refs/heads/caches"]).unwrap();
    }

    #[test]
    fn cache_cleanup_rejects_tracked_not_ignored_and_unrecognized_directories() {
        let fixture = Fixture::new();
        let path = cache_fixture(&fixture, "protected-caches");
        cache(&path, "node_modules", b"tracked data");
        git(
            path.to_str().unwrap(),
            &["add", "-f", "node_modules/cache.bin"],
        )
        .unwrap();
        fs::create_dir_all(path.join("tools")).unwrap();
        fs::write(path.join("tools/package.json"), "{}").unwrap();
        cache(&path, "tools/node_modules", b"not ignored");
        cache(&path, "no-manifest/target", b"no manifest");
        fs::write(path.join("no-manifest/.gitignore"), "target/\n").unwrap();
        cache(&path, "target", b"safe cache");
        let storage = worktree_storage::inspect(&path);
        assert_eq!(storage.cache_paths, vec!["target"]);
        assert!(
            worktree_storage::clean_with_guard(&path, &["target".into()], || {
                Err("Session became active during cache validation".into())
            })
            .is_err()
        );
        assert!(path.join("target/cache.bin").exists());
        assert!(
            worktree_storage::clean(&path, &["target".into(), "tools/node_modules".into()])
                .is_err()
        );
        assert!(
            path.join("target/cache.bin").exists(),
            "Every target must validate before deletion begins"
        );
        assert!(worktree_storage::clean(&path, &["node_modules".into()]).is_err());
        assert!(worktree_storage::clean(&path, &["no-manifest/target".into()]).is_err());
        assert!(path.join("node_modules/cache.bin").exists());
        assert!(path.join("tools/node_modules/cache.bin").exists());
    }

    #[test]
    fn cache_cleanup_rechecks_head_active_locked_detached_and_registration() {
        let fixture = Fixture::new();
        let repo = fixture.repo.to_str().unwrap();
        let path = cache_fixture(&fixture, "cache-state");
        cache(&path, "target", b"keep until safe");
        let entry = inspect(repo, |_| false).unwrap().remove(0);
        assert!(cleanup_caches(
            repo,
            path.to_str().unwrap(),
            "wrong-head",
            &entry.cache_paths,
            |_| false
        )
        .is_err());
        assert!(cleanup_caches(
            repo,
            path.to_str().unwrap(),
            &entry.head,
            &entry.cache_paths,
            |_| true
        )
        .is_err());
        git(repo, &["worktree", "lock", path.to_str().unwrap()]).unwrap();
        assert!(cleanup_caches(
            repo,
            path.to_str().unwrap(),
            &entry.head,
            &entry.cache_paths,
            |_| false
        )
        .is_err());
        git(repo, &["worktree", "unlock", path.to_str().unwrap()]).unwrap();
        git(path.to_str().unwrap(), &["checkout", "--detach"]).unwrap();
        assert!(cleanup_caches(
            repo,
            path.to_str().unwrap(),
            &entry.head,
            &entry.cache_paths,
            |_| false
        )
        .is_err());
        let unregistered = fixture.managed.join("session-not-registered");
        fs::create_dir_all(&unregistered).unwrap();
        fs::write(unregistered.join("Cargo.toml"), "fixture").unwrap();
        fs::write(unregistered.join(".gitignore"), "target/\n").unwrap();
        cache(&unregistered, "target", b"unregistered user data");
        assert!(cleanup_caches(
            repo,
            unregistered.to_str().unwrap(),
            &entry.head,
            &entry.cache_paths,
            |_| false
        )
        .is_err());
        assert!(path.join("target/cache.bin").exists());
        assert!(unregistered.join("target/cache.bin").exists());
        assert!(
            worktree_storage::clean(&path, &["../session-not-registered/target".into()]).is_err()
        );
    }

    #[test]
    fn inspection_includes_registered_migration_names_and_excludes_the_other_build() {
        let fixture = Fixture::new();
        let repo = fixture.repo.to_str().unwrap();
        let migration_root = fixture.directory.join(migration_worktree_root_dir());
        fs::create_dir_all(&migration_root).unwrap();
        let migration = migration_root.join("descriptive-old-session");
        git(
            repo,
            &[
                "worktree",
                "add",
                "-b",
                "migration",
                migration.to_str().unwrap(),
            ],
        )
        .unwrap();
        fs::create_dir(migration_root.join("unregistered-old-session")).unwrap();
        let opposite_name = if cfg!(debug_assertions) {
            migration_worktree_root_dir()
                .trim_end_matches("-dev")
                .to_owned()
        } else {
            format!("{}-dev", migration_worktree_root_dir())
        };
        let opposite = fixture
            .directory
            .join(opposite_name)
            .join("session-opposite");
        fs::create_dir_all(opposite.parent().unwrap()).unwrap();
        git(
            repo,
            &[
                "worktree",
                "add",
                "-b",
                "opposite",
                opposite.to_str().unwrap(),
            ],
        )
        .unwrap();
        let rows = inspect(repo, |_| false).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].branch, "migration");
        assert!(rows[0].can_remove);
    }

    #[test]
    fn cache_cleanup_removes_only_the_folders_selected_at_inspection() {
        let fixture = Fixture::new();
        let repo = fixture.repo.to_str().unwrap();
        let path = cache_fixture(&fixture, "selected-cache");
        cache(&path, "node_modules", b"selected dependencies");
        let entry = inspect(repo, |_| false).unwrap().remove(0);
        assert_eq!(entry.cache_paths, vec!["node_modules"]);
        cache(&path, "target", b"new build after inspection");
        cleanup_caches(
            repo,
            path.to_str().unwrap(),
            &entry.head,
            &entry.cache_paths,
            |_| false,
        )
        .unwrap();
        assert!(!path.join("node_modules").exists());
        assert!(path.join("target/cache.bin").exists());
        assert!(cleanup_caches(
            repo,
            path.to_str().unwrap(),
            &entry.head,
            &entry.cache_paths,
            |_| false
        )
        .is_err());
    }

    #[test]
    fn nested_caches_and_local_repository_caches_are_preserved() {
        let fixture = Fixture::new();
        let path = cache_fixture(&fixture, "nested-caches");
        cache(
            &path,
            "node_modules/package/node_modules",
            b"nested dependency",
        );
        fs::write(path.join("node_modules/package/package.json"), "{}").unwrap();
        // A Git marker anywhere inside an outer cache protects the whole tree.
        fs::write(path.join("node_modules/package/.git"), "gitdir: elsewhere").unwrap();
        fs::create_dir_all(path.join("local-repository")).unwrap();
        fs::write(path.join("local-repository/package.json"), "{}").unwrap();
        fs::write(path.join("local-repository/.git"), "gitdir: elsewhere").unwrap();
        fs::write(path.join("local-repository/.gitignore"), "node_modules/\n").unwrap();
        cache(
            &path,
            "local-repository/node_modules",
            b"local project data",
        );
        let summary = worktree_storage::inspect(&path);
        assert!(summary.cache_paths.is_empty());
        for relative in [
            "node_modules",
            "node_modules/package/node_modules",
            "local-repository/node_modules",
        ] {
            assert!(worktree_storage::clean(&path, &[relative.into()]).is_err());
        }
        assert!(path
            .join("node_modules/package/node_modules/cache.bin")
            .exists());
        assert!(path
            .join("local-repository/node_modules/cache.bin")
            .exists());
    }

    #[test]
    #[cfg(unix)]
    fn unix_backslash_named_workspaces_keep_the_exact_selected_cache_path() {
        let fixture = Fixture::new();
        let path = cache_fixture(&fixture, "unix-path-spelling");
        fs::write(path.join(".gitignore"), "node_modules/\n").unwrap();
        for workspace in ["workspace\\package", "workspace/package"] {
            fs::create_dir_all(path.join(workspace)).unwrap();
            fs::write(path.join(workspace).join("package.json"), "{}").unwrap();
            cache(
                &path,
                &format!("{workspace}/node_modules"),
                b"local dependencies",
            );
        }
        let summary = worktree_storage::inspect(&path);
        assert!(summary
            .cache_paths
            .contains(&"workspace\\package/node_modules".into()));
        assert!(summary
            .cache_paths
            .contains(&"workspace/package/node_modules".into()));
        worktree_storage::clean(&path, &["workspace\\package/node_modules".into()]).unwrap();
        assert!(!path.join("workspace\\package/node_modules").exists());
        assert!(path
            .join("workspace/package/node_modules/cache.bin")
            .exists());
    }

    #[test]
    fn case_mismatched_index_paths_also_protect_cache_files() {
        let fixture = Fixture::new();
        let path = cache_fixture(&fixture, "case-mismatched-index");
        cache(&path, "node_modules", b"tracked under different casing");
        let blob = git(path.to_str().unwrap(), &["hash-object", "-w", "file.txt"]).unwrap();
        let index_entry = format!("100644,{},Node_Modules/cache.bin", blob.trim());
        git(
            path.to_str().unwrap(),
            &["update-index", "--add", "--cacheinfo", &index_entry],
        )
        .unwrap();
        let summary = worktree_storage::inspect(&path);
        assert!(summary.cache_paths.is_empty());
        assert!(worktree_storage::clean(&path, &["node_modules".into()]).is_err());
        assert!(path.join("node_modules/cache.bin").exists());
    }

    #[test]
    fn tracked_gitlink_ancestors_protect_caches_even_without_a_git_marker() {
        let fixture = Fixture::new();
        let path = cache_fixture(&fixture, "gitlink-cache");
        fs::create_dir_all(path.join("submodule")).unwrap();
        fs::write(path.join("submodule/Cargo.toml"), "fixture").unwrap();
        fs::write(path.join("submodule/.gitignore"), "target/\n").unwrap();
        cache(&path, "submodule/target", b"submodule build");
        let head = git(path.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        let gitlink = format!("160000,{},submodule", head.trim());
        git(
            path.to_str().unwrap(),
            &["update-index", "--add", "--cacheinfo", &gitlink],
        )
        .unwrap();
        let summary = worktree_storage::inspect(&path);
        assert!(summary.cache_paths.is_empty());
        assert!(worktree_storage::clean(&path, &["submodule/target".into()]).is_err());
        assert!(path.join("submodule/target/cache.bin").exists());
    }

    #[test]
    fn linked_caches_are_never_traversed_or_deleted() {
        let fixture = Fixture::new();
        let path = cache_fixture(&fixture, "linked-cache");
        let outside = fixture.directory.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.txt"), "outside data").unwrap();
        let link = path.join("target");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        {
            // Junctions do not require Windows developer-mode symlink privileges.
            let output = background_command("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(&link)
                .arg(&outside)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let summary = worktree_storage::inspect(&path);
        assert!(summary.cache_paths.is_empty());
        assert!(worktree_storage::clean(&path, &["target".into()]).is_err());
        // Test a linked descendant separately from the root cache junction.
        fs::remove_dir(&link)
            .or_else(|_| fs::remove_file(&link))
            .unwrap();
        fs::create_dir(&link).unwrap();
        let child = link.join("linked-child");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &child).unwrap();
        #[cfg(windows)]
        {
            let output = background_command("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(&child)
                .arg(&outside)
                .output()
                .unwrap();
            assert!(output.status.success());
        }
        let summary = worktree_storage::inspect(&path);
        assert!(summary.cache_paths.is_empty());
        assert!(summary.error.is_some());
        assert!(worktree_storage::clean(&path, &["target".into()]).is_err());
        assert_eq!(
            fs::read_to_string(outside.join("keep.txt")).unwrap(),
            "outside data"
        );
        // Avoid relying on recursive fixture deletion to handle the test junction.
        fs::remove_dir(&child)
            .or_else(|_| fs::remove_file(&child))
            .unwrap();
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn unicode_nested_cache_paths_are_preserved_when_normalization_is_uncertain() {
        let fixture = Fixture::new();
        let path = cache_fixture(&fixture, "unicode-cache");
        fs::create_dir_all(path.join("packages/ação")).unwrap();
        fs::write(path.join("packages/ação/package.json"), "{}").unwrap();
        fs::write(path.join("packages/ação/.gitignore"), "node_modules/\n").unwrap();
        cache(
            &path,
            "packages/ação/node_modules",
            b"preserve uncertain index paths",
        );
        let summary = worktree_storage::inspect(&path);
        assert!(summary.cache_paths.is_empty());
        assert!(worktree_storage::clean(&path, &["packages/ação/node_modules".into()]).is_err());
        assert!(path.join("packages/ação/node_modules/cache.bin").exists());
    }
}
