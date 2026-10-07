use crate::util::{background_command, expand_path};

// ── Helper: run Git and check its exit status ─────────────────────

fn git_run(workdir: &str, args: &[&str]) -> Result<String, String> {
    let out = background_command("git")
        .current_dir(workdir)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ── Tauri Commands ────────────────────────────────────────────────

/// Return the current branch name.
#[tauri::command]
pub async fn git_current_branch(workdir: String) -> Result<String, String> {
    let expanded = expand_path(&workdir);
    tokio::task::spawn_blocking(move || git_run(&expanded, &["rev-parse", "--abbrev-ref", "HEAD"]))
        .await
        .map_err(|e| e.to_string())?
}

/// Create and switch to a new branch from the current HEAD.
#[tauri::command]
pub async fn git_branch_create(workdir: String, branch: String) -> Result<(), String> {
    let expanded = expand_path(&workdir);
    tokio::task::spawn_blocking(move || {
        git_run(&expanded, &["checkout", "-b", &branch]).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Switch to the specified branch.
#[tauri::command]
pub async fn git_branch_switch(workdir: String, branch: String) -> Result<(), String> {
    let expanded = expand_path(&workdir);
    tokio::task::spawn_blocking(move || git_run(&expanded, &["checkout", &branch]).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
}

/// Force-delete the specified branch (-D).
#[tauri::command]
pub async fn git_branch_delete(workdir: String, branch: String) -> Result<(), String> {
    let expanded = expand_path(&workdir);
    tokio::task::spawn_blocking(move || git_run(&expanded, &["branch", "-D", &branch]).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
}

/// Merge the session branch into the target, preserving branch history with --no-ff.
#[tauri::command]
pub async fn git_branch_merge(
    workdir: String,
    target_branch: String,
    session_branch: String,
) -> Result<(), String> {
    let expanded = expand_path(&workdir);
    tokio::task::spawn_blocking(move || {
        git_run(&expanded, &["checkout", &target_branch]).map_err(|e| {
            crate::i18n::native_text("native.switchBranch", &format!("{target_branch} : {e}"))
        })?;
        git_run(&expanded, &["merge", "--no-ff", &session_branch])
            .map_err(|e| crate::i18n::native_text("native.merge", &format!("merge : {e}")))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return the current branch name for a Git repository, or None otherwise.
#[tauri::command]
pub async fn git_repo_info(workdir: String) -> Result<Option<String>, String> {
    let expanded = expand_path(&workdir);
    tokio::task::spawn_blocking(move || {
        let out = background_command("git")
            .current_dir(&expanded)
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(Some(
                String::from_utf8_lossy(&out.stdout).trim().to_string(),
            ))
        } else {
            Ok(None)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
