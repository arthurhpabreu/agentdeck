import { invoke } from "@tauri-apps/api/core";
import { useWorktreeRecoveryStore } from "../store/worktreeRecoveryStore";

export interface RecoverableWorktree { path: string; branch: string; head: string; reason: "clean" | "dirty" | "locked" | "in_use" | "unavailable" | "detached"; canRemove: boolean }
export const worktreeRecoveryCommands = {
  list: (workdir: string) => invoke<RecoverableWorktree[]>("list_recoverable_worktrees", { workdir }),
  remove: (workdir: string, row: RecoverableWorktree) => invoke<void>("remove_recoverable_worktree", { workdir, worktreePath: row.path, expectedHead: row.head }),
  open: (workdir: string, path: string) => invoke<void>("open_recoverable_worktree", { workdir, worktreePath: path }),
};

export async function cleanupSessionWorktree(workdir: string, worktreePath: string, branch: string) {
  const store = useWorktreeRecoveryStore.getState();
  store.remember(workdir);
  // Keep the location discoverable even if the app closes before cleanup finishes.
  store.preserved(workdir, worktreePath, "");
  try {
    await invoke("teardown_session_worktree", { workdir, worktreePath, branch });
    store.resolved(worktreePath);
  } catch (error) { store.preserved(workdir, worktreePath, String(error)); }
}
