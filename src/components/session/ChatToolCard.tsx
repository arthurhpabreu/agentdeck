import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, LoaderCircle, TerminalSquare } from "lucide-react";
import { useAppI18n } from "../../i18n";
import type { ChatMessage } from "../../store/chatStore";
import { CopyButton } from "./ChatMarkdown";
import { chatActivityCopy, toolStatusLabel } from "./chatActivityCopy";
import "./chatActivity.css";

const OUTPUT_PREVIEW_LIMIT = 8_000;
const DIFF_ROW_LIMIT = 400, DIFF_LINE_LIMIT = 600, DIFF_CONTEXT = 3;
/** Larger edits are shown as removed-then-added lines instead of an aligned diff. */
const ALIGN_CELL_LIMIT = 40_000;
/** Old transcripts store command inputs as JSON in text. Keep them useful as well. */
function legacyCommand(message: ChatMessage): string | undefined {
  if (!/^(bash|terminal|command|shell|exec|powershell)/i.test(message.title ?? "")) return undefined;
  try {
    const input = JSON.parse(message.text);
    if (typeof input.command === "string") return input.command;
    if (typeof input.cmd === "string") return input.cmd;
  } catch { /* Results and raw text are displayed as output. */ }
  return undefined;
}

type Copy = ReturnType<typeof chatActivityCopy>;
type DiffRow = { kind: "add" | "del" | "ctx" | "hunk"; text: string };
interface ToolChange { path?: string; kind?: string; movePath?: string; diff?: string; edits?: { before: string; after: string }[] }
interface ToolInput { target?: string; fullTarget?: string; changes?: ToolChange[]; content?: string }
const PREFIX: Record<DiffRow["kind"], string> = { add: "+", del: "-", ctx: " ", hunk: "" };
/** Claude Code tool → input field that names what it touched. Codex file changes arrive as "Files". */
const TARGET_FIELD = new Map(Object.entries({ Edit: "file_path", MultiEdit: "file_path", Write: "file_path", Read: "file_path", NotebookEdit: "notebook_path", Grep: "pattern", Glob: "pattern", WebFetch: "url", WebSearch: "query", Task: "description", Agent: "description" }));
const PATH_TOOLS = new Set(["Edit", "MultiEdit", "Write", "Read", "NotebookEdit"]);
const str = (value: unknown) => typeof value === "string" ? value : undefined;
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function parseJson(text: string): unknown {
  if (!/^\s*[[{]/.test(text)) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}
/** A complete string field from input the native side cut at its size bound; never a partial value. */
function stringField(text: string, key: string): string | undefined {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`));
  try { return match ? JSON.parse(match[1]) : undefined; } catch { return undefined; }
}
/** Workspace-relative when possible; otherwise the file with its nearest folders. */
function displayPath(path: string, root?: string): string {
  let shown = path.replace(/\\/g, "/");
  const base = root?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (base && shown.toLowerCase().startsWith(`${base.toLowerCase()}/`)) shown = shown.slice(base.length + 1);
  const parts = shown.split("/");
  return parts.length > 4 ? `…/${parts.slice(-3).join("/")}` : shown;
}
function toolInput(title: string | undefined, text: string, root?: string): ToolInput | undefined {
  const parsed = parseJson(text);
  if (title === "Files") {
    const changes = (Array.isArray(parsed) ? parsed : []).flatMap(item => {
      const change = record(item), kind = record(change?.kind);
      return change ? [{ path: str(change.path), kind: str(change.kind) ?? str(kind?.type), movePath: str(kind?.move_path), diff: str(change.diff) }] : [];
    });
    const first = changes.find(change => change.path)?.path ?? stringField(text, "path");
    return { target: first && displayPath(first, root) + (changes.length > 1 ? ` +${changes.length - 1}` : ""), fullTarget: first, changes: changes.length ? changes : undefined };
  }
  const field = title ? TARGET_FIELD.get(title) : undefined;
  if (!title || !field) return undefined;
  const input = record(parsed);
  const value = input ? str(input[field]) : stringField(text, field);
  const target = value && (PATH_TOOLS.has(title) ? displayPath(value, root) : value.replace(/\s+/g, " ").trim());
  const edits = !input ? [] : title === "Edit" ? [input] : title === "MultiEdit" && Array.isArray(input.edits) ? input.edits.map(record).filter(edit => edit !== undefined) : [];
  const pairs = edits.flatMap(edit => typeof edit.old_string === "string" || typeof edit.new_string === "string" ? [{ before: str(edit.old_string) ?? "", after: str(edit.new_string) ?? "" }] : []);
  const content = title === "Write" ? str(input?.content) : title === "NotebookEdit" ? str(input?.new_source) : undefined;
  return { target, fullTarget: value, changes: pairs.length ? [{ path: value, edits: pairs }] : undefined, content };
}
function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
/** Line diff of an edit's old/new strings: common lines stay as context around the changed ones. */
function lineDiff(before: string, after: string): DiffRow[] {
  const a = splitLines(before), b = splitLines(after);
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const x = a.slice(start, a.length - end), y = b.slice(start, b.length - end), rows = a.slice(0, start).map((line): DiffRow => ({ kind: "ctx", text: line }));
  let i = 0, j = 0;
  if (x.length && y.length && x.length * y.length <= ALIGN_CELL_LIMIT) {
    const common = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
    for (let p = x.length - 1; p >= 0; p--) for (let q = y.length - 1; q >= 0; q--) common[p][q] = x[p] === y[q] ? common[p + 1][q + 1] + 1 : Math.max(common[p + 1][q], common[p][q + 1]);
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) { rows.push({ kind: "ctx", text: x[i] }); i++; j++; }
      else if (common[i + 1][j] >= common[i][j + 1]) rows.push({ kind: "del", text: x[i++] });
      else rows.push({ kind: "add", text: y[j++] });
    }
  }
  while (i < x.length) rows.push({ kind: "del", text: x[i++] });
  while (j < y.length) rows.push({ kind: "add", text: y[j++] });
  rows.push(...a.slice(a.length - end).map((line): DiffRow => ({ kind: "ctx", text: line })));
  if (!rows.some(row => row.kind !== "ctx")) return rows;
  const compact: DiffRow[] = [];
  for (let k = 0; k < rows.length;) {
    let next = k; while (next < rows.length && rows[next].kind === "ctx") next++;
    if (next === k) { compact.push(rows[k++]); continue; }
    const head = k === 0 ? 0 : DIFF_CONTEXT, tail = next === rows.length ? 0 : DIFF_CONTEXT;
    compact.push(...(next - k > head + tail + 1 ? [...rows.slice(k, k + head), { kind: "hunk" as const, text: "⋯" }, ...rows.slice(next - tail, next)] : rows.slice(k, next)));
    k = next;
  }
  return compact;
}
/** Codex sends a unified diff for updates and the whole file for additions and deletions. */
function patchRows(diff: string, kind?: string): DiffRow[] {
  const lines = splitLines(diff), hunks = lines.some(line => line.startsWith("@@"));
  if (!hunks && (kind === "add" || kind === "delete")) return lines.map((line): DiffRow => ({ kind: kind === "add" ? "add" : "del", text: line }));
  let header = hunks;
  return lines.flatMap((line): DiffRow[] => {
    if (line.startsWith("@@")) { header = false; return [{ kind: "hunk", text: line }]; }
    if (header) return [];
    if (line.startsWith("\\")) return [{ kind: "hunk", text: line }];
    const sign = line[0] === "+" ? "add" : line[0] === "-" ? "del" : "ctx";
    return [{ kind: sign, text: sign !== "ctx" || line[0] === " " ? line.slice(1) : line }];
  });
}

function ToolChanges({ changes, root, c }: { changes: ToolChange[]; root?: string; c: Copy }) {
  const { files, copy } = useMemo(() => {
    let budget = DIFF_ROW_LIMIT;
    const files = changes.map(change => {
      const rows = change.diff !== undefined ? patchRows(change.diff, change.kind) : (change.edits ?? []).flatMap((edit, index) => [...(index ? [{ kind: "hunk" as const, text: "⋯" }] : []), ...lineDiff(edit.before, edit.after)]);
      const shown = rows.slice(0, Math.max(budget, 0)); budget -= shown.length;
      return { ...change, rows, shown };
    });
    return { files, copy: files.map(file => [file.path ?? "", ...file.rows.map(row => PREFIX[row.kind] + row.text)].join("\n").trim()).join("\n\n") };
  }, [changes]);
  return <div className="ad-tool-input"><div className="ad-tool-section-heading"><span>{c.changes}</span><CopyButton text={copy} /></div>
    {files.map((file, index) => <div key={index}>
      {file.path && <div className="ad-tool-file"><span title={file.path}>{displayPath(file.path, root)}</span>{file.kind === "add" ? <small>{c.created}</small> : file.kind === "delete" ? <small>{c.deleted}</small> : file.movePath && <small title={file.movePath}>→ {displayPath(file.movePath, root)}</small>}</div>}
      {file.shown.length > 0 && <pre className="ad-tool-diff">{file.shown.map((row, line) => <span key={line} className={`is-${row.kind}`}><i>{PREFIX[row.kind]}</i>{row.text.length > DIFF_LINE_LIMIT ? `${row.text.slice(0, DIFF_LINE_LIMIT)}…` : row.text}</span>)}</pre>}
      {file.rows.length > file.shown.length && <p className="ad-tool-more">… {file.rows.length - file.shown.length} {c.moreLines}</p>}
    </div>)}
  </div>;
}
function ToolContent({ content, c }: { content: string; c: Copy }) {
  const shown = content.slice(0, OUTPUT_PREVIEW_LIMIT), hidden = content.length > shown.length ? content.slice(shown.length).split("\n").length : 0;
  return <div className="ad-tool-input"><div className="ad-tool-section-heading"><span>{c.content}</span><CopyButton text={content} /></div><pre>{shown}</pre>{hidden > 0 && <p className="ad-tool-more">… {hidden} {c.moreLines}</p>}</div>;
}

export const ChatToolCard = memo(function ChatToolCard({ message, active, root }: { message: ChatMessage; active: boolean; root?: string }) {
  const { locale } = useAppI18n(); const c = chatActivityCopy(locale);
  const running = active && [undefined, "running", "in_progress", "inProgress", "started", "pending", "queued"].includes(message.status);
  const [open, setOpen] = useState(false);
  const [fullOutput, setFullOutput] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null); const followOutput = useRef(true);
  const legacyInput = legacyCommand(message);
  const command = message.command || legacyInput;
  const input = useMemo(() => command ? undefined : toolInput(message.title, message.text, root), [command, message.title, message.text, root]);
  // A recognised input is rendered as a diff or preview, so its raw JSON is not repeated as output.
  const inputView = !!input?.changes || input?.content !== undefined;
  const output = message.output ?? (command === message.text || legacyInput || inputView ? "" : message.text);
  const shownOutput = fullOutput ? output : output.slice(-OUTPUT_PREVIEW_LIMIT);
  useEffect(() => { if (open && followOutput.current && running) outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight }); }, [shownOutput, open, running]);
  const status = !active && ["running", "in_progress", "inProgress", "started", "pending", "queued"].includes(message.status ?? "") ? "interrupted" : message.status ?? (active ? "running" : "completed");
  return <details className={`ad-chat-tool ad-tool-card ${running ? "is-running" : ""}`} open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary title={command || input?.fullTarget || message.title || c.details}>
      <ChevronRight className="ad-tool-chevron" size={13} />
      {running ? <LoaderCircle size={14} className="ad-spin" /> : <TerminalSquare size={14} />}
      <strong>{message.title || c.command}</strong>
      {command ? <code className="ad-tool-command-preview">{command.replace(/\s+/g, " ")}</code> : input?.target && <code className="ad-tool-command-preview">{input.target}</code>}
      {message.elapsedSeconds !== undefined && <time className="ad-tool-duration">{Math.floor(message.elapsedSeconds / 60)}:{String(Math.floor(message.elapsedSeconds % 60)).padStart(2, "0")}</time>}
      <span className={`ad-tool-status is-${status || "running"}`}>{toolStatusLabel(status, locale)}</span>
    </summary>
    {open && <div className="ad-tool-body">
      {(message.cwd || message.parentId) && <div className="ad-tool-location">{message.cwd && <span title={message.cwd}>{message.cwd}</span>}{message.parentId && <span>{c.subagent} · {message.parentId.slice(-6)}</span>}</div>}
      {command && <div className="ad-tool-command"><div className="ad-tool-section-heading"><span>{c.command}</span><CopyButton text={command} /></div><pre>{command}</pre></div>}
      {input?.changes && <ToolChanges changes={input.changes} root={root} c={c} />}
      {input?.content !== undefined && <ToolContent content={input.content} c={c} />}
      {output ? <div className="ad-tool-result"><div className="ad-tool-section-heading"><span>{!fullOutput && output.length > OUTPUT_PREVIEW_LIMIT ? c.latestLines : command ? c.output : inputView ? c.result : c.details}</span><div>{output.length > OUTPUT_PREVIEW_LIMIT && <button type="button" className="ad-tool-output-toggle" onClick={() => { setFullOutput(value => !value); followOutput.current = fullOutput; }}>{fullOutput ? c.showTail : c.showAll}</button>}<CopyButton text={output} /></div></div><pre ref={outputRef} onScroll={e => { const el = e.currentTarget; followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>{shownOutput}</pre></div> : running && !inputView && <p className="ad-tool-waiting">{c.waitingOutput}</p>}
      {message.exitCode !== undefined && <div className="ad-tool-exit">{c.exit}: <code>{message.exitCode}</code></div>}
    </div>}
  </details>;
});
