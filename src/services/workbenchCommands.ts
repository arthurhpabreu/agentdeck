import { ATTENTION_RANK, useAttentionStore } from "../store/attentionStore";
import { useNavigationStore } from "../store/navigationStore";
import { useSessionStore, type ClaudeSession } from "../store/sessionStore";
import { useWorkbenchStore } from "../store/workbenchStore";
import { useWorkspaceStore } from "../store/workspaceStore";

export function showSessionSurface(sessionId: string | null) {
  if (sessionId) { const session = useSessionStore.getState().sessions.find(session => session.id === sessionId); if (!session) return; useWorkspaceStore.getState().setActiveWorkspace(session.workspaceId); }
  useSessionStore.getState().setActiveSession(sessionId);
  if (sessionId) {
    useSessionStore.getState().setExpandedSession(sessionId);
  }
  useWorkbenchStore.getState().showSessionSurface(sessionId);
}

/** A project opens where the user is needed, otherwise where they left off. */
export function preferredWorkspaceSession(workspaceId: string): string | null {
  const { sessions, activeSessionId } = useSessionStore.getState();
  const owned = sessions.filter(session => session.workspaceId === workspaceId);
  const ids = new Set(owned.map(session => session.id));
  const pending = useAttentionStore.getState().items
    .filter(item => !item.read && ids.has(item.sessionId))
    .sort((a, b) => ATTENTION_RANK[a.kind] - ATTENTION_RANK[b.kind] || b.at - a.at)[0];
  if (pending) return pending.sessionId;
  if (activeSessionId && ids.has(activeSessionId)) return activeSessionId;
  const visited = useNavigationStore.getState().recent.find(id => id.startsWith("session:") && ids.has(id.slice(8)));
  if (visited) return visited.slice(8);
  const working = owned.find(session => session.status === "waiting" || session.status === "running");
  return (working ?? owned.reduce<ClaudeSession | undefined>((newest, session) => !newest || session.createdAt > newest.createdAt ? session : newest, undefined))?.id ?? null;
}

/** Selecting a project opens its conversation, so switching projects takes one click. */
export function openWorkspace(workspaceId: string) {
  if (!useWorkspaceStore.getState().workspaces.some(workspace => workspace.id === workspaceId)) return;
  const sessionId = preferredWorkspaceSession(workspaceId);
  if (sessionId) { showSessionSurface(sessionId); return; }
  useWorkspaceStore.getState().setActiveWorkspace(workspaceId);
  useSessionStore.getState().setActiveSession(null);
  useWorkbenchStore.getState().resetWorkbenchMode();
}

export function showExplorer(sessionId: string) {
  useSessionStore.getState().setActiveSession(sessionId);
  useSessionStore.getState().setExpandedSession(sessionId);
  useWorkbenchStore.getState().showExplorer(sessionId);
}

export function showScm(sessionId: string) {
  useSessionStore.getState().setActiveSession(sessionId);
  useSessionStore.getState().setExpandedSession(sessionId);
  useWorkbenchStore.getState().showScm(sessionId);
}

export function resetWorkbenchMode() {
  useWorkbenchStore.getState().resetWorkbenchMode();
}
