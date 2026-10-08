use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::runtime_scope::session_worktree_root_dir;
use crate::util::{background_command, expand_path, normalize_expanded_path};

// ── Helpers ──────────────────────────────────────────────────────
pub fn session_branch_prefix() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let token = format!("{:06x}", millis % 0x1000000);
    format!("ci/{token}")
}

pub fn session_branch_name(prefix: &str, session_id: &str) -> String {
    format!("{prefix}/session-{session_id}")
}

/// Read the branch name from the worktree directory's HEAD file.
pub fn read_worktree_branch(worktree_path: &Path) -> Option<String> {
    // Worktree HEAD format: ref: refs/heads/<branch>.
    let content = fs::read_to_string(worktree_path.join("HEAD")).ok()?;
    let branch = content.trim().strip_prefix("ref: refs/heads/")?;
    Some(branch.to_string())
}

/// Refuse cleanup when tracked, untracked or ignored files would be lost.
pub(super) fn ensure_clean_worktree(wt_path: &str) -> Result<(), String> {
    let status = background_command("git")
        .current_dir(wt_path)
        .args([
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--ignored",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !status.status.success() {
        return Err(String::from_utf8_lossy(&status.stderr).trim().to_string());
    }
    if !status.stdout.is_empty() {
        return Err(format!(
            "Worktree preserved because it contains local files or changes: {wt_path}"
        ));
    }
    Ok(())
}

/// Git validates worktree ownership; never fall back to deleting a directory.
pub(super) fn remove_worktree(workdir: &str, wt_path: &str) -> Result<(), String> {
    ensure_clean_worktree(wt_path)?;
    let out = background_command("git")
        .current_dir(workdir)
        .args(["worktree", "remove", "--", wt_path])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

// ── Tauri Commands ────────────────────────────────────────────────

/// Create a Git worktree with a new branch from the current HEAD at the given path.
#[tauri::command]
pub async fn git_worktree_create(
    workdir: String,
    branch: String,
    worktree_path: String,
) -> Result<String, String> {
    let expanded_workdir = expand_path(&workdir);
    let expanded_wt_path = expand_path(&worktree_path);

    tokio::task::spawn_blocking(move || {
        if let Some(parent) = Path::new(&expanded_wt_path).parent() {
            fs::create_dir_all(parent)
                .map_err(|e| crate::i18n::native_text("native.create", &format!("{e}")))?;
        }

        let out = background_command("git")
            .current_dir(&expanded_workdir)
            .args(["worktree", "add", "-b", &branch, &expanded_wt_path, "HEAD"])
            .output()
            .map_err(|e| e.to_string())?;

        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(expanded_wt_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove a Git worktree and optionally its branch.
#[tauri::command]
pub async fn git_worktree_remove(
    workdir: String,
    worktree_path: String,
    branch: String,
    delete_branch: bool,
) -> Result<(), String> {
    let expanded_workdir = expand_path(&workdir);
    let expanded_wt_path = expand_path(&worktree_path);

    tokio::task::spawn_blocking(move || {
        remove_worktree(&expanded_workdir, &expanded_wt_path)?;

        if delete_branch && !branch.is_empty() {
            let _ = background_command("git")
                .current_dir(&expanded_workdir)
                .args(["branch", "-d", "--", &branch])
                .output();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List all Git worktrees as structured data.
#[tauri::command]
pub async fn git_worktree_list(workdir: String) -> Result<Vec<serde_json::Value>, String> {
    let expanded = expand_path(&workdir);

    tokio::task::spawn_blocking(move || {
        let out = background_command("git")
            .current_dir(&expanded)
            .args(["worktree", "list", "--porcelain"])
            .output()
            .map_err(|e| e.to_string())?;

        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }

        let stdout = String::from_utf8_lossy(&out.stdout);
        let mut worktrees = vec![];
        let mut current: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();

        for line in stdout.lines() {
            if line.is_empty() {
                if !current.is_empty() {
                    worktrees.push(serde_json::Value::Object(current.clone()));
                    current.clear();
                }
            } else if let Some(path) = line.strip_prefix("worktree ") {
                current.insert("path".into(), path.into());
            } else if let Some(hash) = line.strip_prefix("HEAD ") {
                current.insert("head".into(), hash.into());
            } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
                current.insert("branch".into(), branch.into());
            } else if line == "bare" {
                current.insert("bare".into(), true.into());
            } else if line == "detached" {
                current.insert("detached".into(), true.into());
            }
        }
        if !current.is_empty() {
            worktrees.push(serde_json::Value::Object(current));
        }

        Ok(worktrees)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Merge committed work, then clean up only when local files can be preserved.
#[tauri::command]
pub async fn git_worktree_merge(
    workdir: String,
    worktree_path: String,
    branch: String,
    target_branch: String,
) -> Result<(), String> {
    let expanded_workdir = expand_path(&workdir);
    let expanded_wt_path = expand_path(&worktree_path);

    tokio::task::spawn_blocking(move || {
        // Switch to the target branch.
        let switch = background_command("git")
            .current_dir(&expanded_workdir)
            .args(["checkout", &target_branch])
            .output()
            .map_err(|e| e.to_string())?;
        if !switch.status.success() {
            return Err(crate::i18n::native_text(
                "native.switchBranch",
                &format!(
                    "{} : {}",
                    target_branch,
                    String::from_utf8_lossy(&switch.stderr).trim()
                ),
            ));
        }

        // merge --no-ff
        let merge = background_command("git")
            .current_dir(&expanded_workdir)
            .args(["merge", "--no-ff", &branch])
            .output()
            .map_err(|e| e.to_string())?;
        if !merge.status.success() {
            return Err(crate::i18n::native_text(
                "native.merge",
                &format!("merge : {}", String::from_utf8_lossy(&merge.stderr).trim()),
            ));
        }

        // Merge already succeeded. A dirty/locked worktree is retained; cleanup
        // must not turn a completed merge into a misleading failure.
        if remove_worktree(&expanded_workdir, &expanded_wt_path).is_ok() && !branch.is_empty() {
            let _ = background_command("git")
                .current_dir(&expanded_workdir)
                .args(["branch", "-d", "--", &branch])
                .output();
        }

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Automatically create an isolated Git worktree for a session.
/// Return { worktree_path, branch, base_branch }, or None outside a Git repository.
#[tauri::command]
pub async fn setup_session_worktree(
    workdir: String,
    session_id: String,
) -> Result<Option<serde_json::Value>, String> {
    let expanded_workdir = expand_path(&workdir);
    let session_id_clone = session_id.clone();

    tokio::task::spawn_blocking(move || {
        // Check whether the directory is a Git repository.
        let branch_out = background_command("git")
            .current_dir(&expanded_workdir)
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .output()
            .map_err(|e| e.to_string())?;

        if !branch_out.status.success() {
            return Ok(None);
        }

        let base_branch = String::from_utf8_lossy(&branch_out.stdout)
            .trim()
            .to_string();
        if base_branch == "HEAD" {
            return Ok(None); // Skip detached HEAD.
        }

        // Place the session worktree root alongside the repository.
        let repo_parent = Path::new(&expanded_workdir)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| expanded_workdir.clone());
        let worktree_path = format!(
            "{}/{}/session-{}",
            repo_parent,
            session_worktree_root_dir(),
            session_id_clone
        );
        let branch_prefix = session_branch_prefix();
        let branch = session_branch_name(&branch_prefix, &session_id_clone);

        // A retried launch must never destroy a previous session's files or branch.
        // `worktree add` reports an existing destination without changing it.

        // Create the worktree.
        if let Some(parent) = Path::new(&worktree_path).parent() {
            fs::create_dir_all(parent).map_err(|e| {
                crate::i18n::native_text("native.create", &format!("worktree : {e}"))
            })?;
        }

        let out = background_command("git")
            .current_dir(&expanded_workdir)
            .args(["worktree", "add", "-b", &branch, &worktree_path, "HEAD"])
            .output()
            .map_err(|e| e.to_string())?;

        if !out.status.success() {
            return Err(crate::i18n::native_text(
                "native.create",
                &format!("worktree : {}", String::from_utf8_lossy(&out.stderr).trim()),
            ));
        }

        Ok(Some(serde_json::json!({
            "worktree_path": worktree_path,
            "branch": branch,
            "base_branch": base_branch,
        })))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Clean up a session's Git worktree only when Git can safely remove it.
#[tauri::command]
pub async fn teardown_session_worktree(
    app: tauri::AppHandle,
    workdir: String,
    worktree_path: String,
    branch: String,
) -> Result<(), String> {
    let expanded_workdir = expand_path(&workdir);
    let expanded_wt = expand_path(&worktree_path);

    tokio::task::spawn_blocking(move || {
        let target = fs::canonicalize(&expanded_wt).map_err(|e| e.to_string())?;
        if super::worktree_recovery::in_use(&app, &target) {
            return Err("Worktree preserved: session is still in use".into());
        }
        teardown_folder(&expanded_workdir, &expanded_wt, &branch)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn teardown_folder(workdir: &str, path: &str, branch: &str) -> Result<(), String> {
    remove_worktree(workdir, path)?;
    let _ = background_command("git")
        .current_dir(workdir)
        .args(["worktree", "prune"])
        .output();
    if !branch.is_empty() {
        let _ = background_command("git")
            .current_dir(workdir)
            .args(["branch", "-d", "--", branch])
            .output();
    }
    Ok(())
}

/// Clean up orphan worktree directories and branches absent from known_worktree_paths.
#[tauri::command]
pub async fn prune_orphan_worktrees(
    workdir: String,
    known_worktree_paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let expanded_workdir = expand_path(&workdir);

    tokio::task::spawn_blocking(move || {
        let repo_parent = Path::new(&expanded_workdir)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| expanded_workdir.clone());
        let wt_base = format!("{}/{}", repo_parent, session_worktree_root_dir());
        let wt_base_path = Path::new(&wt_base);

        if !wt_base_path.exists() {
            return Ok(vec![]);
        }

        // Normalize the known paths.
        let known: std::collections::HashSet<String> = known_worktree_paths
            .iter()
            .map(|p| normalize_expanded_path(p))
            .collect();

        let mut pruned = vec![];

        for entry in fs::read_dir(wt_base_path).into_iter().flatten().flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let canonical = normalize_expanded_path(path.to_string_lossy().as_ref());
            if known.contains(&canonical) {
                continue;
            }

            // Read the orphan worktree's branch name before cleanup.
            let branch = read_worktree_branch(&path);

            if remove_worktree(&expanded_workdir, &canonical).is_err() {
                continue;
            }

            if let Some(b) = &branch {
                if !b.is_empty() {
                    let _ = background_command("git")
                        .current_dir(&expanded_workdir)
                        .args(["branch", "-d", "--", b])
                        .output();
                }
            }

            pruned.push(canonical);
        }

        if !pruned.is_empty() {
            let _ = background_command("git")
                .current_dir(&expanded_workdir)
                .args(["worktree", "prune"])
                .output();
        }

        Ok(pruned)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Sandbox(PathBuf);
    impl Sandbox {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("agentdeck-worktree-qa-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            // Cleanup is confined to the uniquely named synthetic fixture.
            let temp = fs::canonicalize(std::env::temp_dir()).unwrap();
            let root = fs::canonicalize(&self.0).unwrap();
            assert_eq!(root.parent(), Some(temp.as_path()));
            assert!(self
                .0
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("agentdeck-worktree-qa-"));
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn git(root: &Path, args: &[&str]) {
        let out = background_command("git")
            .current_dir(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    fn repository(sandbox: &Sandbox) -> PathBuf {
        let repo = sandbox.0.join("repository");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init"]);
        git(&repo, &["config", "user.name", "QA fixture"]);
        git(&repo, &["config", "user.email", "qa@example.invalid"]);
        fs::write(repo.join("tracked.txt"), "saved").unwrap();
        fs::write(repo.join(".gitignore"), "ignored.txt\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "fixture"]);
        repo
    }

    #[test]
    fn cleanup_preserves_tracked_untracked_ignored_and_unregistered_files() {
        let sandbox = Sandbox::new();
        let repo = repository(&sandbox);
        let worktree = sandbox.0.join("session");
        let repo_text = repo.to_str().unwrap();
        let wt = worktree.to_str().unwrap();
        git(&repo, &["worktree", "add", "-b", "qa-session", wt]);
        fs::write(worktree.join("tracked.txt"), "unsaved").unwrap();
        assert!(remove_worktree(repo_text, wt).is_err());
        assert_eq!(
            fs::read_to_string(worktree.join("tracked.txt")).unwrap(),
            "unsaved"
        );
        git(&worktree, &["restore", "tracked.txt"]);
        for filename in ["new.txt", "ignored.txt"] {
            fs::write(worktree.join(filename), "local data").unwrap();
            assert!(remove_worktree(repo_text, wt).is_err());
            assert_eq!(
                fs::read_to_string(worktree.join(filename)).unwrap(),
                "local data"
            );
            fs::remove_file(worktree.join(filename)).unwrap();
        }
        let other = sandbox.0.join("ordinary-folder");
        fs::create_dir(&other).unwrap();
        fs::write(other.join("keep.txt"), "keep").unwrap();
        assert!(remove_worktree(repo_text, other.to_str().unwrap()).is_err());
        assert!(other.join("keep.txt").exists());
        remove_worktree(repo_text, wt).unwrap();
        assert!(!worktree.exists());
        assert!(repo.join("tracked.txt").exists());
    }

    #[test]
    fn session_teardown_keeps_unmerged_commits_reachable() {
        let sandbox = Sandbox::new();
        let repo = repository(&sandbox);
        let worktree = sandbox.0.join("session");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "qa-unmerged",
                worktree.to_str().unwrap(),
            ],
        );
        fs::write(worktree.join("tracked.txt"), "committed session work").unwrap();
        git(&worktree, &["add", "."]);
        git(&worktree, &["commit", "-m", "session work"]);
        teardown_folder(
            repo.to_str().unwrap(),
            worktree.to_str().unwrap(),
            "qa-unmerged",
        )
        .unwrap();
        assert!(!worktree.exists());
        git(&repo, &["show-ref", "--verify", "refs/heads/qa-unmerged"]);
    }

    #[test]
    fn completed_merge_keeps_local_files_when_cleanup_is_not_possible() {
        let sandbox = Sandbox::new();
        let repo = repository(&sandbox);
        let base = background_command("git")
            .current_dir(&repo)
            .args(["branch", "--show-current"])
            .output()
            .unwrap();
        let worktree = sandbox.0.join("session");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "qa-merge",
                worktree.to_str().unwrap(),
            ],
        );
        fs::write(worktree.join("tracked.txt"), "committed session work").unwrap();
        git(&worktree, &["add", "."]);
        git(&worktree, &["commit", "-m", "session work"]);
        fs::write(worktree.join("ignored.txt"), "local build artifact").unwrap();
        tauri::async_runtime::block_on(git_worktree_merge(
            repo.to_string_lossy().into_owned(),
            worktree.to_string_lossy().into_owned(),
            "qa-merge".into(),
            String::from_utf8_lossy(&base.stdout).trim().into(),
        ))
        .unwrap();
        assert_eq!(
            fs::read_to_string(repo.join("tracked.txt")).unwrap(),
            "committed session work"
        );
        assert_eq!(
            fs::read_to_string(worktree.join("ignored.txt")).unwrap(),
            "local build artifact"
        );
        git(&repo, &["show-ref", "--verify", "refs/heads/qa-merge"]);
    }
}
