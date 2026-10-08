import { NewWorkspaceForm } from "./workspaces/NewWorkspaceForm";
import { WorkspaceColorControl } from "./workspaces/WorkspaceColorPicker";
import { X } from "lucide-react";
import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppI18n } from "../i18n";
import {
  useWorkspaceStore,
  useWorkspacesSorted,
  getWorkspaceColor,
  type Workspace,
} from "../store/workspaceStore";
import { useSessionStore, type ClaudeSession } from "../store/sessionStore";
import { useWorkbenchStore } from "../store/workbenchStore";
import { WorktreeRecovery } from "./worktrees/WorktreeRecovery";
import { cleanupSessionWorktree } from "../services/worktreeRecoveryCommands";
import { useWorktreeRecoveryStore } from "../store/worktreeRecoveryStore";

// ── Constants ────────────────────────────────────────────────
const EMPTY_SESSIONS: ClaudeSession[] = [];

// ── Single workspace card in the expanded state ───────────────
function WorkspaceCardExpanded({
  ws, isActive, onClick, onRemove,
}: {
  ws: Workspace;
  isActive: boolean;
  onClick: () => void;
  onRemove: () => void;
}) {
  const { t } = useAppI18n();
  const [hovered, setHovered] = useState(false);
  const color = getWorkspaceColor(ws.color);
  const sessions = useSessionStore((s) => (Array.isArray(s.sessions) ? s.sessions : EMPTY_SESSIONS));
  const { sessionCount, waitingCount, runningCount } = useMemo(() => {
    return sessions.reduce(
      (counts, sess) => {
        if (!sess || typeof sess !== "object") return counts;
        if (sess.workspaceId !== ws.id) return counts;
        counts.sessionCount += 1;
        if (sess.status === "waiting") counts.waitingCount += 1;
        if (sess.status === "running") counts.runningCount += 1;
        return counts;
      },
      { sessionCount: 0, waitingCount: 0, runningCount: 0 }
    );
  }, [sessions, ws.id]);
  const showActions = hovered || isActive;
  const summaryParts = [
    waitingCount > 0 ? `${waitingCount} ${t("workspace.summaryWaiting")}` : null,
    runningCount > 0 ? `${runningCount} ${t("workspace.summaryRunning")}` : null,
    sessionCount > 0 ? `${sessionCount} ${t("workspace.summarySessions")}` : null,
  ].filter(Boolean);

  return (
    <div
      className="ad-workspace-card"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 8,
        minHeight: 32,
        padding: "6px 8px 6px 10px",
        borderRadius: 3,
        background: isActive ? "var(--ci-list-active-bg)" : hovered ? "var(--ci-list-hover-bg)" : "transparent",
        border: "1px solid transparent",
        cursor: "pointer",
        transition: "background 0.12s, border-color 0.12s",
      }}
    >
      {isActive && (
        <div style={{
          position: "absolute",
          left: 0,
          top: 4,
          bottom: 4,
          width: 1,
          borderRadius: 0,
          background: color,
        }} />
      )}

      <WorkspaceColorControl workspaceId={ws.id} name={ws.name} value={ws.color} />

      <button type="button" className="ad-workspace-select" onClick={onClick} aria-pressed={isActive}>
        <span style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
          <span style={{
            color: isActive || hovered ? "var(--ci-text)" : "var(--ci-text-muted)",
            fontSize: 13,
            fontWeight: isActive ? 700 : 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}>
            {ws.name}
          </span>
          {waitingCount > 0 && (
            <span style={{
              fontSize: 11,
              padding: "1px 2px",
              borderRadius: 0,
              background: "transparent",
              border: "none",
              color: "var(--ci-yellow-dark)",
              flexShrink: 0,
              fontWeight: 600,
            }}>
              {waitingCount}
            </span>
          )}
          {runningCount > 0 && (
            <span style={{
              fontSize: 11,
              padding: "1px 2px",
              borderRadius: 0,
              background: "transparent",
              border: "none",
              color: "var(--ci-green-dark)",
              flexShrink: 0,
              fontWeight: 600,
            }}>
              {runningCount}
            </span>
          )}
        </span>
        <span style={{
          display: "block",
          margin: "1px 0 0",
          fontSize: 11,
          color: "var(--ci-text-dim)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>
          {hovered || isActive ? ws.path : summaryParts.join(" · ") || ws.path}
        </span>
      </button>

      <div className="ad-workspace-actions" style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        flexShrink: 0,
        opacity: showActions ? 1 : 0,
        pointerEvents: showActions ? "auto" : "none",
        transition: "opacity 0.12s",
      }}>
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title={t("workspace.removeWorkspace")}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--ci-text-dim)",
            fontSize: 11,
            cursor: "pointer",
            padding: "2px 4px",
            borderRadius: 4,
            flexShrink: 0,
          }}
        ><X size={12} /></button>
      </div>
    </div>
  );
}

// ── Card layers in the collapsed stack ────────────────────────
export function WorkspaceStack() {
  const { t } = useAppI18n();
  const { workspaces, activeWorkspaceId, bringToFront, removeWorkspace } = useWorkspaceStore();
  const { removeSessionsByWorkspace } = useSessionStore();
  const sorted = useWorkspacesSorted();
  const [showForm, setShowForm] = useState(workspaces.length === 0);
  const handleRemove = async (id: string) => {
    const sessionsToRemove = useSessionStore
      .getState()
      .sessions
      .filter((session) => session.workspaceId === id);
    const workspace = workspaces.find((item) => item.id === id);
    if (workspace?.path) useWorktreeRecoveryStore.getState().remember(workspace.path);

    if ("__TAURI_INTERNALS__" in window) {
      await invoke("mark_deleted_items", {
        sessionIds: [],
        workspaceIds: [],
        sessionRefs: sessionsToRemove.map((session) => ({
          sessionId: session.id,
          workspaceId: session.workspaceId,
        })),
        workspaceRefs: workspace ? [{ workspaceId: id, path: workspace.path }] : [{ workspaceId: id }],
      }).catch((e) => {
        console.warn("[ui-state] mark deleted workspace failed:", e);
      });
    }

    removeSessionsByWorkspace(id);
    removeWorkspace(id);

    if (workspaces.length === 1) {
      useWorkbenchStore.getState().resetWorkbenchMode();
    }

    if (!("__TAURI_INTERNALS__" in window) || !workspace?.path) {
      return;
    }

    sessionsToRemove.forEach((session: ClaudeSession) => {
      if (!session.worktreePath || !session.branchName) return;

      void cleanupSessionWorktree(workspace.path, session.worktreePath, session.branchName);
    });
  };

  return <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <h2 style={{ fontSize: 12, fontWeight: 600, color: "var(--ci-text-muted)" }}>{t("workspace.title")}</h2>
      <button className="ad-button" onClick={() => setShowForm(value => !value)}>+ {t("common.add")}</button>
    </div>
    <div style={{ display: "flex", flexWrap: "wrap" }}><WorktreeRecovery /></div>
    {showForm && <NewWorkspaceForm onDone={() => setShowForm(false)} />}
    <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 190, overflow: "auto" }}>
      {sorted.map(ws => <WorkspaceCardExpanded key={ws.id} ws={ws} isActive={ws.id === activeWorkspaceId}
        onClick={() => bringToFront(ws.id)} onRemove={() => void handleRemove(ws.id)} />)}
    </div>
  </section>;
}
