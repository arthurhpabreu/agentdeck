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

/// Force-remove a worktree, falling back to directory removal and prune if Git fails.
fn force_remove_worktree(workdir: &str, wt_path: &str) {
    let _ = background_command("git")
        .current_dir(workdir)
        .args(["worktree", "remove", "--force", wt_path])
        .output();

    let p = Path::new(wt_path);
    if p.exists() {
        let _ = fs::remove_dir_all(p);
        let _ = background_command("git")
            .current_dir(workdir)
            .args(["worktree", "prune"])
            .output();
    }
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
        force_remove_worktree(&expanded_workdir, &expanded_wt_path);

        if delete_branch && !branch.is_empty() {
            let _ = background_command("git")
                .current_dir(&expanded_workdir)
                .args(["branch", "-D", &branch])
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

/// Merge a worktree branch into the target, then remove the worktree and its branch.
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

        // Remove the worktree and its branch.
        force_remove_worktree(&expanded_workdir, &expanded_wt_path);
        if !branch.is_empty() {
            let _ = background_command("git")
                .current_dir(&expanded_workdir)
                .args(["branch", "-D", &branch])
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

        // Keep creation idempotent by cleaning up an existing worktree and branch with this name.
        let _ = background_command("git")
            .current_dir(&expanded_workdir)
            .args(["worktree", "remove", "--force", &worktree_path])
            .output();
        let _ = background_command("git")
            .current_dir(&expanded_workdir)
            .args(["branch", "-D", &branch])
            .output();

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

/// Clean up a session's Git worktree without surfacing cleanup failures.
#[tauri::command]
pub async fn teardown_session_worktree(
    workdir: String,
    worktree_path: String,
    branch: String,
) -> Result<(), String> {
    let expanded_workdir = expand_path(&workdir);
    let expanded_wt = expand_path(&worktree_path);

    tokio::task::spawn_blocking(move || {
        force_remove_worktree(&expanded_workdir, &expanded_wt);

        // Prune dangling worktree references.
        let _ = background_command("git")
            .current_dir(&expanded_workdir)
            .args(["worktree", "prune"])
            .output();

        if !branch.is_empty() {
            let _ = background_command("git")
                .current_dir(&expanded_workdir)
                .args(["branch", "-D", &branch])
                .output();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
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

            let _ = background_command("git")
                .current_dir(&expanded_workdir)
                .args(["worktree", "remove", "--force", &canonical])
                .output();

            if path.exists() {
                let _ = fs::remove_dir_all(&path);
            }

            if let Some(b) = &branch {
                if !b.is_empty() {
                    let _ = background_command("git")
                        .current_dir(&expanded_workdir)
                        .args(["branch", "-D", b])
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
