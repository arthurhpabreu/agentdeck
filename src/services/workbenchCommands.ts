import { useSessionStore } from "../store/sessionStore";
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
