pub const UI_STATE_NAMESPACE_DEV: &str = "dev";
pub const WORKTREE_ROOT_DIR: &str = ".agentdeck-worktrees";
pub const WORKTREE_ROOT_DIR_DEV: &str = ".agentdeck-worktrees-dev";

pub fn ui_state_namespace_dir() -> Option<&'static str> {
    if cfg!(debug_assertions) {
        Some(UI_STATE_NAMESPACE_DEV)
    } else {
        None
    }
}

pub fn session_worktree_root_dir() -> &'static str {
    if cfg!(debug_assertions) {
        WORKTREE_ROOT_DIR_DEV
    } else {
        WORKTREE_ROOT_DIR
    }
}

/// Search only the worktree namespace belonging to this build.
pub fn session_worktree_search_dirs() -> [&'static str; 1] {
    [session_worktree_root_dir()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_recovery_uses_the_current_build_namespace() {
        let [current] = session_worktree_search_dirs();
        assert_eq!(current, session_worktree_root_dir());
        assert!(current.starts_with(".agentdeck-"));
        assert_eq!(current.ends_with("-dev"), cfg!(debug_assertions));
    }
}
