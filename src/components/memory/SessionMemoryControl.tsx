import { BrainCircuit, CircleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppI18n } from "../../i18n";
import type { RunnerType } from "../../store/settingsStore";
import { useMemoryRuntimeEvents, useMemoryRuntimeStore } from "../../store/memoryRuntimeStore";
import { useSharedMemoryStore } from "../../store/sharedMemoryStore";
import { memoryCopy } from "./memoryCopy";
import "./sharedMemory.css";
import "./contextSources.css";
import { contextCopy } from "./contextCopy";
import { KnowledgeWarnings } from "./KnowledgeWarnings";

export function SessionMemoryControl({ sessionId, provider, projectPath, onOpen }: { sessionId: string; provider: RunnerType; projectPath: string; onOpen: () => void }) {
  useMemoryRuntimeEvents();
  const { locale } = useAppI18n();
  const m = memoryCopy(locale);
  const c = contextCopy(locale);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  useEffect(() => { setOpen(false); }, [sessionId]);
  const close = () => { dialog.current?.close(); setOpen(false); trigger.current?.focus(); };
  const runtime = useMemoryRuntimeStore(state => state.sessions[sessionId]);
  const context = runtime?.context;
  const details = runtime?.error ? `${m.contextError}: ${runtime.error}` : context
    ? `${m.retrieved}: ${context.recordCount} · ≈ ${context.estimatedTokens} ${m.tokens} · ${m.duplicates}: ${context.duplicateCount}`
    : `${m.viewMemory} · ${projectPath}`;
  return <div className="ad-memory-session-control" data-provider={provider}>
    <button type="button" className="ad-memory-session-button" aria-label={m.viewMemory} title={details} data-error={!!runtime?.error} onClick={() => { useSharedMemoryStore.getState().setMemoryTab("memory"); useSharedMemoryStore.getState().setMemoryScope("project"); onOpen(); }}><BrainCircuit size={14} /><span>{m.short}</span>{runtime?.error ? <span role="status" className="ad-memory-runtime-error"><CircleAlert size={12} /><span>{m.contextError}</span></span> : context && <small title={details}>{context.recordCount}<span aria-hidden="true"> · </span>{`≈${context.estimatedTokens}`}</small>}</button>
    <button type="button" ref={trigger} className="ad-memory-session-button" aria-label={c.sources} title={context?.warnings?.length ? `${c.sources}: ${c.warning}` : c.sources} data-error={!!context?.warnings?.length} onClick={() => setOpen(true)}>{context?.warnings?.length ? <CircleAlert size={13} /> : <span aria-hidden="true">↗</span>}</button>
    {open && createPortal(<dialog ref={dialog} className="ad-context-dialog" aria-label={c.sources} onCancel={event => { event.preventDefault(); close(); }}>
      <header><h2>{c.sources}</h2><button type="button" className="ad-button" onClick={close}>{c.close}</button></header>
      <p>{context?.phase === "delivered" ? c.delivered : context?.phase === "prepared" ? c.prepared : c.legacy}</p>
      <p className="ad-context-hint">{c.hint}</p>
      {runtime?.error && <div role="alert"><p>{c.historical}</p><p>{runtime.error}</p></div>}
      <KnowledgeWarnings warnings={context?.warnings ?? []} />
      {!context?.sources?.length && <p>{context?.recordCount ? c.unavailableDetails : c.empty}</p>}
      {context?.sources?.map(source => <article key={`${source.scope}:${source.id}`}><strong>{source.title}</strong><p>{source.scope === "global" ? c.global : c.project} · {source.source === "document" ? c.document : c.memory}</p><code>{source.path ?? source.id}</code><pre>{source.excerpt}</pre></article>)}
    </dialog>, document.body)}
  </div>;
}
