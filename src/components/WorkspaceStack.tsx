import { X } from "lucide-react";
import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, useReducedMotion } from "framer-motion";
import { useAppI18n } from "../i18n";
import {
  useWorkspaceStore,
  useWorkspacesSorted,
  WORKSPACE_COLORS,
  getWorkspaceColor,
  type Workspace,
  type WorkspaceColorId,
} from "../store/workspaceStore";
import { useSessionStore, type ClaudeSession } from "../store/sessionStore";
import { useSettingsStore, isGlassTheme } from "../store/settingsStore";
import { useWorkbenchStore } from "../store/workbenchStore";
import { WorktreeRecovery } from "./worktrees/WorktreeRecovery";
import { cleanupSessionWorktree } from "../services/worktreeRecoveryCommands";
import { useWorktreeRecoveryStore } from "../store/worktreeRecoveryStore";

// ── Constants ────────────────────────────────────────────────
const EMPTY_SESSIONS: ClaudeSession[] = [];

// ── Inline form for a new workspace ───────────────────────────
function NewWorkspaceForm({ onDone }: { onDone: () => void }) {
  const { t, isRtl } = useAppI18n();
  const reducedMotion = useReducedMotion();
  const { addWorkspace } = useWorkspaceStore();
  const isGlass = useSettingsStore((s) => isGlassTheme(s.settings.theme));
  const textShadow = isGlass ? "var(--ci-glass-text-shadow)" : "none";
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [color, setColor] = useState<WorkspaceColorId>("green");
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");

  const handlePick = async () => {
    setPicking(true);
    setError("");
    try {
      const picked = await invoke<string>("pick_folder");
      if (picked) setPath(picked);
    } catch {
      setError(t("workspace.openFolderPickerFailed"));
    } finally {
      setPicking(false);
    }
  };

  const handleCreate = async () => {
    const trimmed = path.trim();
    if (!trimmed) { setError(t("common.pathRequired")); return; }
    const workspaceId = addWorkspace(trimmed, name.trim() || undefined, color);
    if ("__TAURI_INTERNALS__" in window) {
      await invoke("clear_deleted_items", {
        sessionIds: [],
        workspaceIds: [],
        sessionRefs: [],
        workspaceRefs: [{ workspaceId, path: trimmed }],
      }).catch((e) => {
        console.warn("[ui-state] clear deleted workspace failed:", e);
      });
    }
    invoke("trust_workspace", { path: trimmed }).catch(() => {});
    onDone();
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box",
    background: "transparent",
    border: "1px solid var(--ci-border)",
    borderRadius: 3, padding: "6px 9px",
    color: "var(--ci-text)", fontSize: 13, outline: "none",
    fontFamily: "Segoe UI, system-ui, sans-serif",
    transition: "border-color 0.15s, box-shadow 0.15s, background 0.15s",
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.18 }}
      style={{ overflow: "hidden" }}
    >
      <div style={{
        background: "var(--ci-surface)",
        border: "1px solid var(--ci-toolbar-border)",
        borderRadius: 4, padding: 12,
        display: "flex", flexDirection: "column", gap: 8,
        marginBottom: 4,
        boxShadow: "none",
        textShadow,
      }}>
        <div style={{
          fontSize: 13, fontWeight: 600,
          color: "var(--ci-text)", letterSpacing: -0.1,
        }}>
          {t("workspace.addWorkspace")}
        </div>

        {/* Name (optional) */}
        <div>
          <div style={{ fontSize: 11, color: "var(--ci-text-muted)", marginBottom: 4, fontWeight: 500 }}>{t("workspace.optionalName")}</div>
          <input value={name} onChange={e => setName(e.target.value)}
            dir={isRtl ? "rtl" : "ltr"}
            placeholder={t("workspace.defaultFolderName")} style={{ ...inputStyle, textAlign: "start" }}
            onKeyDown={e => e.key === "Enter" && handleCreate()} />
        </div>

        {/* Path */}
        <div>
          <div style={{ fontSize: 11, color: "var(--ci-text-muted)", marginBottom: 4, fontWeight: 500 }}>
            {t("workspace.directory")} <span style={{ color: "var(--ci-red)" }}>*</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input value={path} onChange={e => { setPath(e.target.value); setError(""); }}
              dir="ltr"
              placeholder={t("workspace.pathPlaceholder")}
              style={{
                ...inputStyle, flex: 1,
                borderColor: error ? "rgba(255,59,48,0.5)" : undefined,
              }}
              onKeyDown={e => e.key === "Enter" && handleCreate()} />
            <button onClick={handlePick} disabled={picking}
              style={{
                flexShrink: 0,
                background: "none",
                border: "none",
                padding: "0 2px",
                color: picking ? "var(--ci-text-dim)" : "var(--ci-text-muted)",
                cursor: picking ? "wait" : "pointer",
                fontSize: 13,
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                transition: "color 0.12s, opacity 0.12s",
              }}
              onMouseEnter={e => {
                if (picking) return;
                e.currentTarget.style.color = "var(--ci-text)";
                e.currentTarget.style.opacity = "0.8";
              }}
              onMouseLeave={e => {
                e.currentTarget.style.color = picking ? "var(--ci-text-dim)" : "var(--ci-text-muted)";
                e.currentTarget.style.opacity = "1";
              }}
            >{picking ? t("workspace.choosingDirectory") : t("workspace.chooseDirectory")}</button>
          </div>
          {error && <div style={{ marginTop: 4, fontSize: 11, color: "var(--ci-red)" }}>{error}</div>}
        </div>

        {/* Color selection */}
        <div>
          <div style={{ fontSize: 11, color: "var(--ci-text-muted)", marginBottom: 6, fontWeight: 500 }}>{t("workspace.colorLabel")}</div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            {WORKSPACE_COLORS.map((c) => (
              <button key={c.id} onClick={() => setColor(c.id as WorkspaceColorId)}
                title={t(`colors.${c.id}`)}
                style={{
                  width: 20, height: 20, borderRadius: "50%",
                  background: c.hex, border: "none", cursor: "pointer", padding: 0,
                  outline: color === c.id ? `2.5px solid ${c.hex}` : "none",
                  outlineOffset: 2.5,
                  boxShadow: color === c.id ? `0 0 0 1.5px rgba(255,255,255,0.9)` : "0 1px 2px rgba(0,0,0,0.15)",
                  transform: color === c.id ? "scale(1.15)" : "scale(1)",
                  transition: "transform 0.12s, outline 0.12s, box-shadow 0.12s",
                }} />
            ))}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 2 }}>
          <button onClick={onDone}
            style={{
              background: "none",
              border: "none",
              padding: "5px 2px",
              color: "var(--ci-text-muted)", fontSize: 13, cursor: "pointer",
              fontWeight: 600,
              transition: "color 0.12s, opacity 0.12s",
            }}
            onMouseEnter={e => {
              e.currentTarget.style.color = "var(--ci-text)";
              e.currentTarget.style.opacity = "0.8";
            }}
            onMouseLeave={e => {
              e.currentTarget.style.color = "var(--ci-text-muted)";
              e.currentTarget.style.opacity = "1";
            }}
          >{t("common.cancel")}</button>
          <button onClick={handleCreate}
            style={{
              background: "none",
              border: "none",
              padding: "5px 2px",
              color: "var(--ci-accent)", fontSize: 13, fontWeight: 600, cursor: "pointer",
              transition: "color 0.12s, opacity 0.12s",
            }}
            onMouseEnter={e => {
              e.currentTarget.style.color = "var(--ci-accent)";
              e.currentTarget.style.opacity = "0.8";
            }}
            onMouseLeave={e => {
              e.currentTarget.style.color = "var(--ci-accent)";
              e.currentTarget.style.opacity = "1";
            }}
          >{t("common.create")}</button>
        </div>
      </div>
    </motion.div>
  );
}

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
      onClick={onClick}
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

      <div style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
      }} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
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
        </div>
        <p style={{
          margin: "1px 0 0",
          fontSize: 11,
          color: "var(--ci-text-dim)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>
          {hovered || isActive ? ws.path : summaryParts.join(" · ") || ws.path}
        </p>
      </div>

      <div style={{
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
