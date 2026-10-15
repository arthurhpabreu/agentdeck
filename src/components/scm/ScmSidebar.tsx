import { useState } from "react";
import { ChevronDown, ChevronRight, Plus, Minus, Trash2 } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { type DiffFile, type ClaudeSession } from "../../store/sessionStore";
import {
  commitScm,
  discardScmFile,
  selectScmFile,
  stageAllScm,
  stageScmFile,
  unstageAllScm,
  unstageScmFile,
} from "../../services/scmCommands";
import { resetWorkbenchMode } from "../../services/workbenchCommands";
import { EMPTY_SCM_GROUPS, type ScmEntryGroup, type ScmStatusEntry, useScmStore } from "../../store/scmStore";
import { WorkbenchTooltip } from "../ui/WorkbenchTooltip";
import { SortableCollection } from "../ordering/SortableCollection";

function mapDiffFileToStatusEntry(file: DiffFile): ScmStatusEntry {
  return {
    path: file.path,
    kind: file.type === "added" ? "added" : file.type === "deleted" ? "deleted" : "modified",
    staged: false,
    unstaged: false,
    conflicted: false,
    oldPath: null,
  };
}

function buildCommittedEntries(snapshot: DiffFile[], localPaths: Set<string>): ScmStatusEntry[] {
  return snapshot
    .filter((file) => !localPaths.has(file.path))
    .map(mapDiffFileToStatusEntry);
}

function ActionButton({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <WorkbenchTooltip label={label}>
      <button
        onClick={(event) => {
          event.stopPropagation();
          void onClick();
        }}
        disabled={disabled}
        style={{
          background: "none",
          border: "none",
          color: disabled ? "var(--ci-text-dim)" : "var(--ci-text-dim)",
          width: 18,
          height: 18,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: disabled ? "default" : "pointer",
          padding: 0,
          opacity: disabled ? 0.35 : 0.78,
        }}
      >
        {icon}
      </button>
    </WorkbenchTooltip>
  );
}

function Section({
  title,
  count,
  defaultExpanded = true,
  actions,
  handle,
  children,
}: {
  title: string;
  count?: number;
  defaultExpanded?: boolean;
  actions?: React.ReactNode;
  handle?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  if (count === 0) return null;

  return (
    <div style={{ marginBottom: 6 }}>
      <div
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "2px 12px 6px",
          color: "var(--ci-text-dim)",
        }}
      >
        {handle}
        <button
          onClick={() => setExpanded((value) => !value)}
          style={{
            minWidth: 0,
            flex: 1,
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "none",
            border: "none",
            color: "inherit",
            cursor: "pointer",
            textAlign: "left",
            padding: 0,
          }}
        >
          <span style={{ width: 12, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {expanded ? <ChevronDown size={12} strokeWidth={1.8} /> : <ChevronRight size={12} strokeWidth={1.8} />}
          </span>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>{title}</span>
          {typeof count === "number" && <span style={{ fontSize: 10, marginLeft: "auto" }}>{count}</span>}
        </button>
        {actions && <div style={{ display: "flex", alignItems: "center", gap: 2, marginLeft: 8 }}>{actions}</div>}
      </div>
      {expanded && children}
    </div>
  );
}

function GroupSection({
  group,
  files,
  sessionId,
  selectedPath,
  busy,
}: {
  group: ScmEntryGroup;
  files: ScmStatusEntry[];
  sessionId: string;
  selectedPath: string | null;
  busy: boolean;
}) {
  const { t } = useAppI18n();
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);

  return (
    <SortableCollection surface="scm-files" context={JSON.stringify([sessionId, group])} items={files} getId={file => file.path} getLabel={file => file.path} render={(file, handle) => {
        const isSelected = selectedPath === file.path;
        const isHovered = hoveredPath === file.path;
        return (
          <div
            key={`${group}:${file.path}`}
            onMouseEnter={() => setHoveredPath(file.path)}
            onMouseLeave={() => setHoveredPath((current) => (current === file.path ? null : current))}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 8,
              minHeight: 22,
              padding: "0 8px 0 24px",
              background: isSelected ? "var(--ci-list-active-bg)" : isHovered ? "var(--ci-list-hover-bg)" : "transparent",
              color: isSelected || isHovered ? "var(--ci-text)" : "var(--ci-text-muted)",
              borderInlineStart: isSelected ? "1px solid var(--ci-accent)" : "1px solid transparent",
            }}
          >
            {handle}
            <button data-drag-primary
              onClick={() => selectScmFile(sessionId, group, file.path)}
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: "none",
                border: "none",
                color: "inherit",
                cursor: "pointer",
                textAlign: "left",
                padding: "3px 0",
              }}
              title={group === "untracked"
                ? t("scm.openFileContent", { path: file.path })
                : t("scm.openDiff", { path: file.path })}
            >
              <span style={{ width: 12, textAlign: "center", color: file.kind === "added" ? "var(--ci-green)" : file.kind === "deleted" ? "var(--ci-red)" : file.kind === "conflicted" ? "var(--ci-red)" : "var(--ci-yellow)", fontSize: 10, fontWeight: 700 }}>
                {file.kind === "added" ? "A" : file.kind === "deleted" ? "D" : file.kind === "conflicted" ? "!" : file.kind === "renamed" ? "R" : "M"}
              </span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>
                {file.path}
              </span>
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0, opacity: isSelected || isHovered ? 1 : 0, pointerEvents: isSelected || isHovered ? "auto" : "none" }}>
              {(group === "unstaged" || group === "untracked") && (
                <ActionButton label={t("scm.stage")} icon={<Plus size={12} strokeWidth={1.8} />} onClick={() => stageScmFile(sessionId, file.path)} disabled={busy} />
              )}
              {group === "staged" && (
                <ActionButton label={t("scm.unstage")} icon={<Minus size={12} strokeWidth={1.8} />} onClick={() => unstageScmFile(sessionId, file.path)} disabled={busy} />
              )}
              {group === "unstaged" && (
                <ActionButton label={t("scm.discard")} icon={<Minus size={12} strokeWidth={1.8} />} onClick={() => discardScmFile(sessionId, file.path, "unstaged")} disabled={busy} />
              )}
              {group === "untracked" && (
                <ActionButton label={t("scm.delete")} icon={<Trash2 size={12} strokeWidth={1.8} />} onClick={() => discardScmFile(sessionId, file.path, "untracked")} disabled={busy} />
              )}
            </div>
          </div>
        );
      }} />
  );
}

export function ScmSidebar({ session }: { session: ClaudeSession | null }) {
  const { t, isRtl } = useAppI18n();
  if (!session) {
    return (
      <div style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        color: "var(--ci-text-dim)",
        fontSize: 12,
        lineHeight: 1.7,
        textAlign: "center",
      }}>
        {t("scm.noSession")}
      </div>
    );
  }

  const snapshot = useScmStore((s) => s.snapshotBySessionId[session.id]?.files ?? session.diffFiles);
  const groups = useScmStore((s) => s.statusBySessionId[session.id] ?? EMPTY_SCM_GROUPS);
  const selectedEntry = useScmStore((s) => s.selectedEntryBySessionId[session.id] ?? null);
  const commitMessage = useScmStore((s) => s.commitMessageBySessionId[session.id] ?? "");
  const busy = useScmStore((s) => s.actionPendingBySessionId[session.id] ?? false);
  const actionError = useScmStore((s) => s.actionErrorBySessionId[session.id] ?? null);
  const setCommitMessage = useScmStore((s) => s.setCommitMessage);
  const totalAdditions = snapshot.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = snapshot.reduce((sum, file) => sum + file.deletions, 0);
  const hasGroupedStatus = groups.conflicts.length + groups.staged.length + groups.unstaged.length + groups.untracked.length > 0;
  const localPaths = new Set([
    ...groups.conflicts.map((file) => file.path),
    ...groups.staged.map((file) => file.path),
    ...groups.unstaged.map((file) => file.path),
    ...groups.untracked.map((file) => file.path),
  ]);
  const committedEntries = hasGroupedStatus
    ? buildCommittedEntries(snapshot, localPaths)
    : snapshot.map(mapDiffFileToStatusEntry);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "transparent" }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 8,
        padding: "6px 10px",
        borderBottom: "1px solid var(--ci-toolbar-border)",
      }}>
        <button
          onClick={resetWorkbenchMode}
          style={{
            background: "none",
            border: "none",
            color: "var(--ci-text-muted)",
            cursor: "pointer",
            padding: 0,
            fontSize: 12,
          }}
          title={t("scm.backToSession")}
        >
          ←
        </button>
      </div>

      <div style={{
        padding: "8px 12px",
        borderBottom: "1px solid var(--ci-toolbar-border)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 10,
        color: "var(--ci-text-dim)",
      }}>
        <span>{t("scm.filesSummary", { count: snapshot.length })}</span>
        <span style={{ color: "var(--ci-green-dark)", fontWeight: 700 }}>+{totalAdditions}</span>
        <span style={{ color: "var(--ci-deleted-text)", fontWeight: 700 }}>−{totalDeletions}</span>
      </div>

      <div style={{ padding: "8px 12px 10px", borderBottom: "1px solid var(--ci-toolbar-border)", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 10, color: "var(--ci-text-dim)", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          {t("scm.commitTitle")}
        </div>
        <textarea
          dir={isRtl ? "rtl" : "ltr"}
          value={commitMessage}
          onChange={(event) => setCommitMessage(session.id, event.target.value)}
          placeholder={t("scm.commitMessagePlaceholder")}
          rows={3}
          style={{
            width: "100%",
            resize: "vertical",
            borderRadius: 0,
            border: "1px solid var(--ci-toolbar-border)",
            background: "var(--ci-surface)",
            color: "var(--ci-text)",
            fontSize: 11,
            padding: "6px 8px",
            boxSizing: "border-box",
            textAlign: "start",
          }}
        />
        <button
          onClick={() => void commitScm(session.id)}
          disabled={busy || commitMessage.trim().length === 0}
          onMouseEnter={e => {
            if (busy || commitMessage.trim().length === 0) return;
            e.currentTarget.style.opacity = "0.8";
          }}
          onMouseLeave={e => {
            e.currentTarget.style.opacity = busy || commitMessage.trim().length === 0 ? "0.7" : "1";
          }}
          style={{
            alignSelf: "flex-start",
            background: "none",
            border: "none",
            color: busy || commitMessage.trim().length === 0 ? "var(--ci-text-dim)" : "var(--ci-accent)",
            padding: "4px 2px",
            fontSize: 11,
            fontWeight: 600,
            cursor: busy || commitMessage.trim().length === 0 ? "default" : "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
            opacity: busy || commitMessage.trim().length === 0 ? 0.7 : 1,
            transition: "opacity 0.12s",
          }}
        >
          <Plus size={12} strokeWidth={1.8} />
          {busy ? t("common.processing") : t("scm.commitAction")}
        </button>
        {actionError && (
          <div style={{ fontSize: 11, color: "var(--ci-deleted-text)", lineHeight: 1.6 }}>
            {actionError}
          </div>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 0 12px" }}>
        {!hasGroupedStatus && snapshot.length === 0 ? (
          <div style={{ padding: "12px", color: "var(--ci-text-dim)", fontSize: 12 }}>
            {t("scm.noChanges")}
          </div>
        ) : (
          <SortableCollection surface="scm-sections" context={session.id} items={[
            { id: "committed", title: t("scm.committedInSession"), count: committedEntries.length },
            { id: "working", title: t("scm.workingTree"), count: groups.conflicts.length + groups.staged.length + groups.unstaged.length + groups.untracked.length },
          ].filter(group => group.count > 0)} allIds={["committed", "working"]} getId={group => group.id} getLabel={group => group.title} render={(section, handle) => <Section title={section.title} count={section.count} handle={handle}>
            {section.id === "committed" ? <GroupSection group="committed" files={committedEntries} sessionId={session.id} selectedPath={selectedEntry?.group === "committed" ? selectedEntry.path : null} busy={busy} /> :
              <SortableCollection surface="scm-status-groups" context={session.id} allIds={["conflicts", "staged", "unstaged", "untracked"]} items={[
                { id: "conflicts" as ScmEntryGroup, title: t("scm.conflicts"), files: groups.conflicts },
                { id: "staged" as ScmEntryGroup, title: t("scm.stagedChanges"), files: groups.staged },
                { id: "unstaged" as ScmEntryGroup, title: t("scm.changes"), files: groups.unstaged },
                { id: "untracked" as ScmEntryGroup, title: t("scm.untracked"), files: groups.untracked },
              ].filter(group => group.files.length > 0)} getId={group => group.id} getLabel={group => group.title} render={(group, groupHandle) => <Section title={group.title} count={group.files.length} handle={groupHandle} actions={
                group.id === "staged" ? <ActionButton label={t("scm.unstageAll")} icon={<Minus size={12} strokeWidth={1.8} />} onClick={() => unstageAllScm(session.id)} disabled={busy} /> :
                group.id === "unstaged" ? <ActionButton label={t("scm.stageAllChanges")} icon={<Plus size={12} strokeWidth={1.8} />} onClick={() => stageAllScm(session.id, groups.unstaged.map(file => file.path))} disabled={busy} /> : undefined
              }><GroupSection group={group.id} files={group.files} sessionId={session.id} selectedPath={selectedEntry?.group === group.id ? selectedEntry.path : null} busy={busy} /></Section>} />}
          </Section>} />
        )}
      </div>
    </div>
  );
}
