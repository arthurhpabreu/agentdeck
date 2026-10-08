import { memo, useEffect, useRef, useState } from "react";
import { ChevronRight, LoaderCircle, TerminalSquare } from "lucide-react";
import { useAppI18n } from "../../i18n";
import type { ChatMessage } from "../../store/chatStore";
import { CopyButton } from "./ChatMarkdown";
import { chatActivityCopy, toolStatusLabel } from "./chatActivityCopy";
import "./chatActivity.css";

const OUTPUT_PREVIEW_LIMIT = 8_000;
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

export const ChatToolCard = memo(function ChatToolCard({ message, active }: { message: ChatMessage; active: boolean }) {
  const { locale } = useAppI18n(); const c = chatActivityCopy(locale);
  const running = active && [undefined, "running", "in_progress", "inProgress", "started", "pending", "queued"].includes(message.status);
  const [open, setOpen] = useState(false);
  const [fullOutput, setFullOutput] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null); const followOutput = useRef(true);
  const legacyInput = legacyCommand(message);
  const command = message.command || legacyInput;
  const output = message.output ?? (command === message.text || legacyInput ? "" : message.text);
  const shownOutput = fullOutput ? output : output.slice(-OUTPUT_PREVIEW_LIMIT);
  useEffect(() => { if (open && followOutput.current && running) outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight }); }, [shownOutput, open, running]);
  const status = !active && ["running", "in_progress", "inProgress", "started", "pending", "queued"].includes(message.status ?? "") ? "interrupted" : message.status ?? (active ? "running" : "completed");
  return <details className={`ad-chat-tool ad-tool-card ${running ? "is-running" : ""}`} open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary title={command || message.title || c.details}>
      <ChevronRight className="ad-tool-chevron" size={13} />
      {running ? <LoaderCircle size={14} className="ad-spin" /> : <TerminalSquare size={14} />}
      <strong>{message.title || c.command}</strong>
      {command && <code className="ad-tool-command-preview">{command.replace(/\s+/g, " ")}</code>}
      {message.elapsedSeconds !== undefined && <time className="ad-tool-duration">{Math.floor(message.elapsedSeconds / 60)}:{String(Math.floor(message.elapsedSeconds % 60)).padStart(2, "0")}</time>}
      <span className={`ad-tool-status is-${status || "running"}`}>{toolStatusLabel(status, locale)}</span>
    </summary>
    {open && <div className="ad-tool-body">
      {(message.cwd || message.parentId) && <div className="ad-tool-location">{message.cwd && <span title={message.cwd}>{message.cwd}</span>}{message.parentId && <span>{c.subagent} · {message.parentId.slice(-6)}</span>}</div>}
      {command && <div className="ad-tool-command"><div className="ad-tool-section-heading"><span>{c.command}</span><CopyButton text={command} /></div><pre>{command}</pre></div>}
      {output ? <div className="ad-tool-result"><div className="ad-tool-section-heading"><span>{!fullOutput && output.length > OUTPUT_PREVIEW_LIMIT ? c.latestLines : command ? c.output : c.details}</span><div>{output.length > OUTPUT_PREVIEW_LIMIT && <button type="button" className="ad-tool-output-toggle" onClick={() => { setFullOutput(value => !value); followOutput.current = fullOutput; }}>{fullOutput ? c.showTail : c.showAll}</button>}<CopyButton text={output} /></div></div><pre ref={outputRef} onScroll={e => { const el = e.currentTarget; followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>{shownOutput}</pre></div> : running && <p className="ad-tool-waiting">{c.waitingOutput}</p>}
      {message.exitCode !== undefined && <div className="ad-tool-exit">{c.exit}: <code>{message.exitCode}</code></div>}
    </div>}
  </details>;
});
