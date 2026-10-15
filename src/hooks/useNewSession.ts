import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppI18n } from "../i18n";
import { sessionDirectoryCopy } from "../components/session/sessionDirectoryCopy";
import { useSessionStore } from "../store/sessionStore";
import { sanitizeRunnerConfig, useSettingsStore } from "../store/settingsStore";
import { useWorkspaceStore, type Workspace } from "../store/workspaceStore";
import { useWorkbenchStore } from "../store/workbenchStore";
import { recoveryPathKey, useWorktreeRecoveryStore } from "../store/worktreeRecoveryStore";

interface PreparedWorktree { worktree_path: string; branch: string; base_branch: string }

/** Prepare the requested folder before publishing a session that could run an agent. */
export function useNewSession(workspace: Workspace | null | undefined) {
  const { locale } = useAppI18n();
  const [creating, setCreating] = useState(false);
  const [creationError, setCreationError] = useState("");
  const pending = useRef(false);

  const createSession = async () => {
    if (!workspace || pending.current) return;
    pending.current = true; setCreating(true); setCreationError("");
    const c = sessionDirectoryCopy(locale);
    const workspaceExists = () => useWorkspaceStore.getState().workspaces.some(item => item.id === workspace.id && recoveryPathKey(item.path) === recoveryPathKey(workspace.path));
    try {
      const native = "__TAURI_INTERNALS__" in window;
      const sessions = useSessionStore.getState().sessions;
      const { runner, newSessionDirectoryMode } = useSettingsStore.getState().settings;
      const id = native
        ? await invoke<string>("reserve_session_id", {
          workspaces: useWorkspaceStore.getState().workspaces.map(item => ({ workspaceId: item.id, workspacePath: item.path })),
          existingSessionIds: sessions.map(item => item.id),
        })
        : String(sessions.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1);
      let isolated: PreparedWorktree | null = null;
      let rememberAttempted = false;
      const abandon = async () => {
        if (isolated) useWorktreeRecoveryStore.getState().preserved(workspace.path, isolated.worktree_path, c.cancelled);
        if (native && rememberAttempted) {
          await invoke("remove_session_workdir", { sessionId: id })
            .catch(error => console.warn("[session-files] remove cancelled workdir failed:", error));
        }
        setCreationError(c.cancelled);
      };
      if (!workspaceExists()) { await abandon(); return; }
      if (newSessionDirectoryMode === "worktree") {
        if (!native) throw new Error(c.unavailable);
        isolated = await invoke<PreparedWorktree | null>("setup_session_worktree", { workdir: workspace.path, sessionId: id });
        if (!isolated?.worktree_path || !isolated.branch) throw new Error(c.unavailable);
      }
      if (!workspaceExists()) { await abandon(); return; }
      const workdir = isolated?.worktree_path || workspace.path;
      if (native) {
        await invoke("clear_deleted_items", { sessionIds: [id], workspaceIds: [], sessionRefs: [{ sessionId: id, workspaceId: workspace.id }], workspaceRefs: [] })
          .catch(error => console.warn("[ui-state] clear deleted session failed:", error));
        if (!workspaceExists()) { await abandon(); return; }
        rememberAttempted = true;
        await invoke("remember_session_workdir", { sessionId: id, workdir })
          .catch(error => console.warn("[session-files] remember workdir failed:", error));
      }
      // The project may have been removed or changed during native preparation.
      // Recheck synchronously before publishing a runnable session.
      if (!workspaceExists()) { await abandon(); return; }
      const store = useSessionStore.getState();
      store.addSession(id, workspace.id, workdir, undefined, { ...sanitizeRunnerConfig(runner) });
      if (isolated) store.updateSession(id, { worktreePath: isolated.worktree_path, branchName: isolated.branch, baseBranch: isolated.base_branch });
      store.markWorktreeReady(id);
      store.setActiveSession(id); store.setExpandedSession(id);
      useWorkbenchStore.getState().focusSession(id);
    } catch (error) {
      setCreationError(`${c.failure}: ${String(error)}`);
    } finally {
      pending.current = false; setCreating(false);
    }
  };
  return { createSession, creating, creationError };
}
