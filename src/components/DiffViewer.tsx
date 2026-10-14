import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileCode2, FilePlus2, FileX2, Minus, Plus } from "lucide-react";
import { useAppI18n } from "../i18n";
import { DiffFile, DiffLine } from "../store/sessionStore";
import { type ScmActionMode } from "../store/scmStore";
import { WorkbenchTooltip } from "./ui/WorkbenchTooltip";
import { useSessionStore } from "../store/sessionStore";
import { useDiffReviewStore, diffContext, diffRevision } from "../store/diffReviewStore";
import { improvementsCopy } from "./platformImprovementsCopy";
import { DiffReviewPanel } from "./editor/DiffReviewPanel";
import { SortableCollection } from "./ordering/SortableCollection";
import { WindowedRows } from "./ui/WindowedRows";

const MONO = "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace";

type LineStyle = { bg: string; text: string; gutter: string; prefix: string };
const LINE_STYLES: Record<DiffLine["type"], LineStyle> = {
  added:   {
    bg:     "var(--ci-added-bg)",
    text:   "var(--ci-added-text)",
    gutter: "rgba(52,199,89,0.06)",
    prefix: "var(--ci-green)",
  },
  deleted: {
    bg:     "var(--ci-deleted-bg)",
    text:   "var(--ci-deleted-text)",
    gutter: "rgba(255,59,48,0.05)",
    prefix: "var(--ci-red)",
  },
  context: {
    bg:     "transparent",
    text:   "var(--ci-text-muted)",
    gutter: "transparent",
    prefix: "transparent",
  },
};

function DiffLineRow({ line, onSelect, selected }: { line: DiffLine; onSelect?: (extend: boolean) => void; selected?: boolean }) {
  const { locale } = useAppI18n(); const copy = improvementsCopy(locale);
  const c = LINE_STYLES[line.type];
  const prefix = line.type === "added" ? "+" : line.type === "deleted" ? "−" : " ";
  return (
    <div style={{
      display: "flex",
      width: "max-content",
      minWidth: "100%",
      fontFamily: MONO,
      fontSize: 11,
      lineHeight: "18px",
      background: selected ? "var(--ci-accent-soft, rgba(0,122,255,.18))" : c.bg,
    }}>
      <span style={{
        width: 36,
        textAlign: "right",
        padding: "0 6px",
        color: "var(--ci-text-dim)",
        flexShrink: 0,
        background: c.gutter,
        userSelect: "none",
        borderInlineEnd: "1px solid var(--ci-toolbar-border)",
      }}>
        {line.oldLineNo ?? ""}
      </span>
      <span style={{
        width: 36,
        textAlign: "right",
        padding: "0 6px",
        color: "var(--ci-text-dim)",
        flexShrink: 0,
        background: c.gutter,
        userSelect: "none",
        borderInlineEnd: "1px solid var(--ci-toolbar-border)",
      }}>
        {line.newLineNo ?? ""}
      </span>
      <span style={{
        width: 18,
        textAlign: "center",
        color: line.type === "context" ? "transparent" : c.prefix,
        flexShrink: 0,
        userSelect: "none",
        fontWeight: 600,
      }}>
        {prefix}
      </span>
      <span style={{ flex: 1, padding: "0 10px", color: c.text, whiteSpace: "pre" }}>
        {line.content || " "}
      </span>
      {onSelect && <button type="button" style={{ height: 18, padding: 0, width: 22 }} aria-label={`${copy.comment} ${line.oldLineNo ?? ""}:${line.newLineNo ?? ""}`} className="ad-icon-button" onClick={event => onSelect(event.shiftKey)}>+</button>}
    </div>
  );
}

function FileIcon({ type, binary }: { type: DiffFile["type"]; binary?: boolean }) {
  if (binary) return <FileCode2 size={12} strokeWidth={1.8} />;
  if (type === "added") return <FilePlus2 size={12} strokeWidth={1.8} />;
  if (type === "deleted") return <FileX2 size={12} strokeWidth={1.8} />;
  return <FileCode2 size={12} strokeWidth={1.8} />;
}

function FileStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span style={{ display: "flex", gap: 8, fontSize: 10, marginInlineStart: "auto", flexShrink: 0 }}>
      {additions > 0 && <span style={{ color: "var(--ci-added-text)" }}>+{additions}</span>}
      {deletions > 0 && <span style={{ color: "var(--ci-deleted-text)" }}>−{deletions}</span>}
    </span>
  );
}

function HunkActionButton({ label, icon, onClick, disabled }: { label: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <WorkbenchTooltip label={label}>
      <button
        onClick={onClick}
        disabled={disabled}
        style={{
          background: "none",
          border: "none",
          color: disabled ? "var(--ci-text-dim)" : "var(--ci-text-dim)",
          width: 18,
          height: 18,
          padding: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.35 : 0.82,
        }}
      >
        {icon}
      </button>
    </WorkbenchTooltip>
  );
}

function DiffFileRow({
  file,
  fileMode,
  onStageHunk,
  onUnstageHunk,
  onDiscardHunk,
  busy,
  contentMaxHeight,
  sessionId,
}: {
  file: DiffFile;
  fileMode?: ScmActionMode | null;
  onStageHunk?: (path: string, hunkIndex: number) => void;
  onUnstageHunk?: (path: string, hunkIndex: number) => void;
  onDiscardHunk?: (path: string, hunkIndex: number) => void;
  busy?: boolean;
  contentMaxHeight?: number | string;
  sessionId?: string;
}) {
  const { t, locale } = useAppI18n(); const c = improvementsCopy(locale);
  const [isOpen, setIsOpen] = useState(true);
  const [selection, setSelection] = useState<{ side: "old" | "new"; start: number; end: number; anchor: number }>();
  const [comment, setComment] = useState("");
  const isBinary = !!file.binary;
  const useInnerScroll = contentMaxHeight !== "none";
  const virtualRows = useMemo(() => file.hunks.flatMap((hunk, hunkIndex) => [{ line: undefined as DiffLine | undefined, hunkIndex, header: hunk.header }, ...hunk.lines.map(line => ({ line, hunkIndex, header: "" }))]), [file]);
  const lineSelection = (line: DiffLine, extend: boolean) => { const side = line.newLineNo === undefined ? "old" : "new"; const number = (side === "old" ? line.oldLineNo : line.newLineNo)!; const anchor = extend && selection?.side === side ? selection.anchor : number; setSelection({ side, anchor, start: Math.min(anchor, number), end: Math.max(anchor, number) }); };
  const isSelected = (line: DiffLine) => { const number = selection?.side === "old" ? line.oldLineNo : line.newLineNo; return !!selection && number !== undefined && number >= selection.start && number <= selection.end; };

  return (
    <div style={{ borderBottom: "1px solid var(--ci-toolbar-border)", background: "transparent" }}>
      <button
        onClick={() => setIsOpen((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          color: "var(--ci-text)",
          textAlign: "left",
        }}
      >
        <span style={{ width: 12, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ci-text-dim)", flexShrink: 0 }}>
          {isOpen ? <ChevronDown size={12} strokeWidth={1.8} /> : <ChevronRight size={12} strokeWidth={1.8} />}
        </span>
        <span style={{ width: 12, display: "flex", alignItems: "center", justifyContent: "center", color: file.type === "added" ? "var(--ci-green)" : file.type === "deleted" ? "var(--ci-red)" : "var(--ci-text-dim)", flexShrink: 0 }}>
          <FileIcon type={file.type} binary={isBinary} />
        </span>
        <span style={{ fontSize: 11, fontFamily: MONO, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {file.path}
        </span>
        {isBinary ? (
          <span style={{ fontSize: 10, color: "var(--ci-purple)" }}>{t("diff.binary")}</span>
        ) : (
          <FileStat additions={file.additions} deletions={file.deletions} />
        )}
      </button>

      {isOpen && (
        <div style={{ background: "var(--ci-code-bg)", borderTop: "1px solid var(--ci-toolbar-border)", maxHeight: contentMaxHeight, overflow: useInnerScroll ? "auto" : "visible" }}>
          {isBinary ? (
            <div style={{ padding: "14px 16px", fontSize: 11, color: "var(--ci-text-dim)" }}>
              {t("diff.binaryPreviewUnsupported")}
            </div>
          ) : file.hunks.length === 0 ? (
            <div style={{ padding: "12px 16px", fontSize: 11, color: "var(--ci-text-muted)", fontFamily: MONO }}>
              {file.note?.startsWith("agentdeck:mode:") ? t("diff.modeChange", { old: file.note.split(":")[2], new: file.note.split(":")[3] }) : file.note === "agentdeck:submodule" ? t("diff.submoduleChange") : file.note === "agentdeck:metadata" ? t("diff.metadataChange") : file.note ?? t("diff.noContentDiff")}
            </div>
          ) : virtualRows.length > 400 ? <WindowedRows items={virtualRows} height={typeof contentMaxHeight === "number" ? contentMaxHeight : 540} render={row => row.line ? <DiffLineRow line={row.line} selected={isSelected(row.line)} onSelect={sessionId ? extend => lineSelection(row.line!, extend) : undefined}/> : <div style={{ display: "flex", gap: 8, height: 20, paddingInline: 10, background: "var(--ci-toolbar-bg)", fontSize: 10, fontFamily: MONO }}><span>{row.header}</span><span style={{ marginInlineStart: "auto", display: "flex" }}>{fileMode === "unstaged" && onStageHunk && <HunkActionButton label={t("scm.stageHunk")} icon={<Plus size={12}/>} onClick={() => onStageHunk(file.path, row.hunkIndex)} disabled={busy}/>} {fileMode === "unstaged" && onDiscardHunk && <HunkActionButton label={t("scm.discardHunk")} icon={<Minus size={12}/>} onClick={() => onDiscardHunk(file.path, row.hunkIndex)} disabled={busy}/>} {fileMode === "staged" && onUnstageHunk && <HunkActionButton label={t("scm.unstageHunk")} icon={<Minus size={12}/>} onClick={() => onUnstageHunk(file.path, row.hunkIndex)} disabled={busy}/>}</span></div>}/> : (
            file.hunks.map((hunk, hi) => (
              <div key={hi}>
                <div style={{
                  padding: "2px 8px 2px 90px",
                  background: "var(--ci-toolbar-bg)",
                  color: "var(--ci-text-dim)",
                  fontSize: 10,
                  fontFamily: MONO,
                  borderTop: "1px solid var(--ci-toolbar-border)",
                  borderBottom: "1px solid var(--ci-toolbar-border)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}>
                  <span>{hunk.header}</span>
                  <div style={{ marginInlineStart: "auto", display: "flex", gap: 2 }}>
                    {fileMode === "unstaged" && onStageHunk && <HunkActionButton label={t("scm.stageHunk")} icon={<Plus size={12} strokeWidth={1.8} />} onClick={() => onStageHunk(file.path, hi)} disabled={busy} />}
                    {fileMode === "unstaged" && onDiscardHunk && <HunkActionButton label={t("scm.discardHunk")} icon={<Minus size={12} strokeWidth={1.8} />} onClick={() => onDiscardHunk(file.path, hi)} disabled={busy} />}
                    {fileMode === "staged" && onUnstageHunk && <HunkActionButton label={t("scm.unstageHunk")} icon={<Minus size={12} strokeWidth={1.8} />} onClick={() => onUnstageHunk(file.path, hi)} disabled={busy} />}
                  </div>
                </div>
                {hunk.lines.map((line, li) => (
                  <DiffLineRow key={li} line={line} selected={!!selection && (selection.side === "old" ? line.oldLineNo : line.newLineNo) !== undefined && (selection.side === "old" ? line.oldLineNo! : line.newLineNo!) >= selection.start && (selection.side === "old" ? line.oldLineNo! : line.newLineNo!) <= selection.end} onSelect={sessionId ? extend => {
                    const side = line.newLineNo === undefined ? "old" : "new"; const number = (side === "old" ? line.oldLineNo : line.newLineNo)!;
                    const anchor = extend && selection?.side === side ? selection.anchor : number;
                    setSelection({ side, anchor, start: Math.min(anchor, number), end: Math.max(anchor, number) });
                  } : undefined} />
                ))}
              </div>
            ))
          )}
        </div>
      )}
      {selection && sessionId && <form className="ad-diff-comment" onSubmit={event => { event.preventDefault(); if (!comment.trim()) return; useDiffReviewStore.getState().add({ sessionId, path: file.path, side: selection.side, start: selection.start, end: selection.end, revision: diffRevision(file), context: diffContext(file, selection.side, selection.start, selection.end), text: comment.trim() }); setComment(""); setSelection(undefined); }}><label>{c.comment} · {selection.side}:{selection.start}-{selection.end}<textarea aria-label={c.comment} value={comment} onChange={event => setComment(event.target.value)} placeholder={c.commentHint}/></label><button className="ad-button" disabled={!comment.trim()}>{c.add}</button><button type="button" className="ad-button ad-button-ghost" onClick={() => setSelection(undefined)}>{c.cancel}</button></form>}
    </div>
  );
}

export function DiffViewer({
  files,
  fileMode,
  onStageHunk,
  onUnstageHunk,
  onDiscardHunk,
  busy = false,
  contentMaxHeight = 420,
  sessionId: explicitSessionId,
}: {
  files: DiffFile[];
  fileMode?: ScmActionMode | null;
  onStageHunk?: (path: string, hunkIndex: number) => void;
  onUnstageHunk?: (path: string, hunkIndex: number) => void;
  onDiscardHunk?: (path: string, hunkIndex: number) => void;
  busy?: boolean;
  contentMaxHeight?: number | string;
  sessionId?: string;
}) {
  const { t } = useAppI18n();
  const activeSessionId = useSessionStore(state => state.activeSessionId);
  const sessionId = explicitSessionId ?? activeSessionId ?? undefined;

  if (files.length === 0) {
    return (
      <div style={{ padding: "20px 0", textAlign: "center", color: "var(--ci-text-muted)", fontSize: 12 }}>
        {t("diff.noChanges")}
      </div>
    );
  }

  const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);

  return (
    <div style={{ background: "transparent" }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "7px 12px",
        borderBottom: "1px solid var(--ci-toolbar-border)",
        background: "var(--ci-toolbar-bg)",
      }}>
        <span style={{ fontSize: 11, color: "var(--ci-text-muted)" }}>
          {t("diff.filesChanged", { count: files.length })}
        </span>
        <span style={{ display: "flex", gap: 8, fontSize: 11 }}>
          <span style={{ color: "var(--ci-added-text)" }}>+{totalAdditions}</span>
          <span style={{ color: "var(--ci-deleted-text)" }}>−{totalDeletions}</span>
        </span>
      </div>
      <SortableCollection surface="diff-files" context={sessionId ?? "preview"} items={files} getId={file => file.path} getLabel={file => file.path} render={(f, handle) => <div>{handle}
        <DiffFileRow
          key={f.path}
          file={f}
          fileMode={fileMode}
          onStageHunk={onStageHunk}
          onUnstageHunk={onUnstageHunk}
          onDiscardHunk={onDiscardHunk}
          busy={busy}
          contentMaxHeight={contentMaxHeight}
          sessionId={sessionId}
        />
      </div>} />
      {sessionId && <DiffReviewPanel sessionId={sessionId} files={files}/>}
    </div>
  );
}
