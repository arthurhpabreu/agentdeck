import { NewWorkspaceForm } from "./workspaces/NewWorkspaceForm";
import { WorkspaceColorControl } from "./workspaces/WorkspaceColorPicker";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { formatRelativeTime, useAppI18n } from "../i18n";
import {
  useWorkspaceStore,
  useWorkspacesSorted,
  getWorkspaceColor,
  type Workspace,
} from "../store/workspaceStore";
import { useSessionStore, type ClaudeSession } from "../store/sessionStore";
import { ATTENTION_RANK, type AttentionKind } from "../store/attentionStore";
import { usePresentationStore } from "../store/presentationStore";
import { useWorkbenchStore } from "../store/workbenchStore";
import { WorktreeRecovery } from "./worktrees/WorktreeRecovery";
import { cleanupSessionWorktree } from "../services/worktreeRecoveryCommands";
import { openWorkspace } from "../services/workbenchCommands";
import { useWorktreeRecoveryStore } from "../store/worktreeRecoveryStore";
import { ATTENTION_LABEL, useSessionActivity } from "../hooks/useSessionActivity";
import { SortableCollection } from "./ordering/SortableCollection";
import "./workspaces/workspaceControls.css";

// ── Automatic grouping ───────────────────────────────────────
type ProjectGroup = "attention" | "running" | "recent" | "other";
const GROUPS: ProjectGroup[] = ["attention", "running", "recent", "other"];
const GROUP_LABEL: Record<ProjectGroup, string> = {
  attention: "workspace.groupAttention",
  running: "workspace.groupRunning",
  recent: "workspace.groupRecent",
  other: "workspace.groupOther",
};
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const COLLAPSED_VIEW = "projects:collapsed";

interface ProjectActivity {
  group: ProjectGroup;
  attention: number;
  attentionKind?: AttentionKind;
  running: number;
  sessions: number;
  task: string;
  /** Last real agent or user activity; 0 when none is known. */
  activeAt: number;
}

/** Group projects by what needs the user now, then by recent work. */
function useProjectActivity(workspaces: Workspace[]) {
  const { sessions, activity: sessionActivity, now } = useSessionActivity();
  return useMemo(() => {
    const result = new Map<string, ProjectActivity>(workspaces.map(ws => [ws.id, {
      group: "other", attention: 0, running: 0, sessions: 0, task: "", activeAt: ws.lastActiveAt ?? 0,
    }]));
    for (const session of sessions) {
      const activity = result.get(session.workspaceId);
      if (!activity) continue;
      const current = sessionActivity.get(session.id);
      activity.sessions += 1;
      activity.activeAt = Math.max(activity.activeAt, current?.at ?? session.createdAt);
      if (current?.attention) {
        activity.attention += current.unread;
        if (!activity.attentionKind || ATTENTION_RANK[current.attention] < ATTENTION_RANK[activity.attentionKind]) activity.attentionKind = current.attention;
      }
      if (session.status === "running") {
        activity.running += 1;
        if (!activity.task) activity.task = session.currentTask;
      }
    }
    for (const ws of workspaces) {
      const activity = result.get(ws.id)!;
      activity.group = activity.attention ? "attention"
        : activity.running ? "running"
        : now - (activity.activeAt || ws.createdAt) < RECENT_MS ? "recent"
        : "other";
    }
    return result;
  }, [workspaces, sessions, sessionActivity, now]);
}

// ── Single workspace card in the expanded state ───────────────
function WorkspaceCardExpanded({
  ws, activity, isActive, onClick, onRemove,
}: {
  ws: Workspace;
  activity: ProjectActivity;
  isActive: boolean;
  onClick: () => void;
  onRemove: () => void;
}) {
  const { t, locale } = useAppI18n();
  const [hovered, setHovered] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  // Search and notifications can switch projects while this row is scrolled away.
  useEffect(() => { if (isActive) row.current?.scrollIntoView({ block: "nearest" }); }, [isActive]);
  const color = getWorkspaceColor(ws.color);
  const showActions = hovered || isActive;
  const status = activity.attentionKind
    ? `${t(ATTENTION_LABEL[activity.attentionKind])}${activity.attention > 1 ? ` · ${activity.attention}` : ""}`
    : activity.running
      ? activity.task || `${activity.running} ${t("workspace.summaryRunning")}`
      : activity.activeAt
        ? t("workspace.lastActive", { time: formatRelativeTime(activity.activeAt, locale) })
        : activity.sessions ? `${activity.sessions} ${t("workspace.summarySessions")}` : ws.path;

  return (
    <div
      ref={row}
      className="ad-workspace-card"
      data-state={activity.attention ? "attention" : activity.running ? "running" : undefined}
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

      <button data-drag-primary type="button" className="ad-workspace-select" onClick={onClick} aria-pressed={isActive}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {(activity.attention > 0 || activity.running > 0) && <i className="ad-project-pulse" aria-hidden="true" />}
          <span style={{
            color: isActive || hovered || activity.attention || activity.running ? "var(--ci-text)" : "var(--ci-text-muted)",
            fontSize: 13,
            fontWeight: isActive ? 700 : 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}>
            {ws.name}
          </span>
          <span className="ad-project-chat-count" title={t("workspace.openChats", { count: activity.sessions })} aria-label={t("workspace.openChats", { count: activity.sessions })}>{activity.sessions}</span>
        </span>
        <span className="ad-project-status" style={{
          display: "block",
          margin: "1px 0 0",
          fontSize: 11,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>
          {hovered ? ws.path : status}
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

/** Adding a project leaves both navigation lists in place. */
function NewWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const { t } = useAppI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return createPortal(<dialog ref={dialog} className="ad-project-color-dialog ad-project-form-dialog" aria-label={t("workspace.addWorkspace")}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <NewWorkspaceForm onDone={onClose} />
  </dialog>, document.body);
}

// ── Project list grouped by activity ──────────────────────────
export function WorkspaceStack() {
  const { t } = useAppI18n();
  const { workspaces, activeWorkspaceId, removeWorkspace } = useWorkspaceStore();
  const removeSessionsByWorkspace = useSessionStore(state => state.removeSessionsByWorkspace);
  const sorted = useWorkspacesSorted();
  const activity = useProjectActivity(sorted);
  const collapsedView = usePresentationStore(state => state.views[COLLAPSED_VIEW] ?? "");
  // The first project is added inline; later ones in a dialog above the lists.
  const [form, setForm] = useState<"inline" | "dialog" | null>(workspaces.length === 0 ? "inline" : null);
  const addButton = useRef<HTMLButtonElement>(null);
  const groups = useMemo(() => GROUPS.map(group => {
    const members = sorted.filter(ws => activity.get(ws.id)?.group === group);
    // Stale projects keep the user's arrangement; active ones follow the latest work.
    const recency = (ws: Workspace) => activity.get(ws.id)!.activeAt || ws.createdAt;
    return { group, items: group === "other" ? members : members.sort((a, b) => recency(b) - recency(a)) };
  }).filter(entry => entry.items.length > 0), [sorted, activity]);
  const collapsed = new Set(collapsedView.split(",").filter(Boolean));
  const toggle = (group: ProjectGroup) => {
    const next = new Set(collapsed);
    if (!next.delete(group)) next.add(group);
    usePresentationStore.getState().setView(COLLAPSED_VIEW, [...next].join(","));
  };
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
  const card = (ws: Workspace, handle?: ReactNode) => <div style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
    {handle}<div style={{ flex: 1, minWidth: 0 }}><WorkspaceCardExpanded ws={ws} activity={activity.get(ws.id)!} isActive={ws.id === activeWorkspaceId}
      onClick={() => openWorkspace(ws.id)} onRemove={() => void handleRemove(ws.id)} /></div>
  </div>;

  return <nav className="ad-nav-projects" aria-label={t("workspace.title")}>
    <div className="ad-nav-head">
      <h2>{t("workspace.title")}</h2>
      <div className="ad-nav-head-actions">
        <WorktreeRecovery />
        <button ref={addButton} type="button" className="ad-button" onClick={() => setForm(value => value ? null : workspaces.length ? "dialog" : "inline")}>+ {t("common.add")}</button>
      </div>
    </div>
    {form === "inline" && <div className="ad-nav-inline-form"><NewWorkspaceForm onDone={() => setForm(null)} /></div>}
    {form === "dialog" && <NewWorkspaceDialog onClose={() => { setForm(null); addButton.current?.focus({ preventScroll: true }); }} />}
    <div className="ad-project-groups">
      {groups.map(({ group, items }) => {
        const grouped = groups.length > 1, hidden = grouped && collapsed.has(group);
        return <div key={group} className="ad-project-group" data-group={group}>
          {grouped && <button type="button" className="ad-project-group-header" aria-expanded={!hidden} onClick={() => toggle(group)}>
            {hidden ? <ChevronRight size={12} /> : <ChevronDown size={12} />}<span>{t(GROUP_LABEL[group])}</span><b>{items.length}</b>
          </button>}
          {hidden ? null : group === "other"
            ? <SortableCollection surface="projects" context="navigation" items={items} allIds={sorted.map(ws => ws.id)} getId={ws => ws.id} getLabel={ws => ws.name} render={(ws, handle) => card(ws, handle)} />
            : <div role="list">{items.map(ws => <div key={ws.id} role="listitem">{card(ws)}</div>)}</div>}
        </div>;
      })}
    </div>
  </nav>;
}
