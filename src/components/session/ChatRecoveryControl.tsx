import { useEffect, useRef, useState } from "react";
import { ArchiveRestore, X } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { useChatStore, emptyThread } from "../../store/chatStore";
import { usePtyRuntimeStore } from "../../store/ptyRuntimeStore";
import { type ClaudeSession } from "../../store/sessionStore";
import { improvementsCopy } from "../platformImprovementsCopy";
import { createChatContinuation, prepareReviewedContext } from "../../services/chatContinuity";
import { listChatCheckpoints, readCheckpoint, saveChatCheckpoint, type ChatCheckpoint, type ChatCheckpointSummary } from "../../services/chatCheckpoints";
import { showSessionSurface } from "../../services/workbenchCommands";
import { SortableCollection } from "../ordering/SortableCollection";

export function ChatRecoveryControl({ session, visible, disabled = false }: { session: ClaudeSession; visible: boolean; disabled?: boolean }) {
  const { locale } = useAppI18n(); const c = improvementsCopy(locale);
  const thread = useChatStore(state => state.threads[session.id] ?? emptyThread);
  const ptyRunning = usePtyRuntimeStore(state => !!state.sessions[session.id]);
  const stopped = !disabled && !thread.busy && !ptyRunning;
  const [checkpoints, setCheckpoints] = useState<ChatCheckpointSummary[]>([]); const [expanded, setExpanded] = useState(false); const [review, setReview] = useState<string>(); const [restoring, setRestoring] = useState<ChatCheckpoint>();
  const [pending, setPending] = useState(false); const [error, setError] = useState(""); const dialog = useRef<HTMLDialogElement>(null);
  const reviewGeneration = useRef(0);
  const closeReview = () => { reviewGeneration.current++; setReview(undefined); setRestoring(undefined); setPending(false); };
  const openReview = (summary?: ChatCheckpointSummary) => {
    if (!stopped || pending) return;
    const generation = ++reviewGeneration.current;
    setRestoring(undefined); setPending(true); setError("");
    void (async () => {
      const checkpoint = summary ? await readCheckpoint(session.id, summary.id) : undefined;
      if (reviewGeneration.current !== generation) return;
      setRestoring(checkpoint);
      const value = await prepareReviewedContext(session.id, locale, checkpoint?.thread);
      if (reviewGeneration.current === generation) setReview(value);
    })().catch(failure => { if (reviewGeneration.current === generation) { setRestoring(undefined); setError(String(failure)); } }).finally(() => { if (reviewGeneration.current === generation) setPending(false); });
  };
  useEffect(() => { setCheckpoints([]); closeReview(); return () => { reviewGeneration.current++; }; }, [session.id]);
  useEffect(() => { if (!visible) closeReview(); }, [visible]);
  useEffect(() => {
    let current = true;
    if (visible && expanded) void listChatCheckpoints(session.id).then(rows => { if (current) setCheckpoints(rows); }).catch(failure => { if (current) setError(String(failure)); });
    return () => { current = false; };
  }, [visible, expanded, session.id]);
  useEffect(() => { if (review !== undefined) dialog.current?.showModal(); else dialog.current?.close(); }, [review !== undefined]);
  useEffect(() => {
    const handler = (event: Event) => { if (visible && (event as CustomEvent<{ sessionId: string }>).detail?.sessionId === session.id) openReview(); };
    window.addEventListener("agentdeck-correct-sources", handler); return () => window.removeEventListener("agentdeck-correct-sources", handler);
  }, [visible, session.id, locale, stopped, pending]);
  return <div className="ad-chat-recovery">
    <span className="ad-hint">{thread.recoveryKind === "provider-resumed" ? c.nativeResumed : thread.continuation ? c.newContext : thread.messages.length && thread.historyRestored ? c.historyRestored : ""}</span>
    <button className="ad-button ad-button-ghost" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><ArchiveRestore size={14}/>{c.checkpoints}</button>
    {expanded && <div><button className="ad-button" disabled={!stopped || pending} onClick={() => { const generation=reviewGeneration.current; setPending(true); setError(""); void saveChatCheckpoint(session.id).then(() => listChatCheckpoints(session.id)).then(rows=>{if(reviewGeneration.current===generation)setCheckpoints(rows);}).catch(failure => {if(reviewGeneration.current===generation)setError(String(failure));}).finally(() => {if(reviewGeneration.current===generation)setPending(false);}); }}>{c.createCheckpoint}</button><button className="ad-button" disabled={!stopped || pending} onClick={() => openReview()}>{c.correctSources}</button>
      <SortableCollection surface="chat-checkpoints" context={session.id} items={checkpoints} getId={checkpoint => checkpoint.id} getLabel={checkpoint => new Date(checkpoint.at).toLocaleString(locale)} render={(checkpoint, handle) => <div>{handle}<time>{new Date(checkpoint.at).toLocaleString(locale)}</time><button className="ad-button ad-button-ghost" disabled={!stopped || pending} onClick={() => openReview(checkpoint)}>{c.restoreCheckpoint}</button></div>}/>
    </div>}
    {error && <p role="alert">{error}</p>}
    <dialog ref={dialog} className="ad-context-review" aria-label={c.reviewContext} onCancel={event => { event.preventDefault(); if (!pending) closeReview(); }}><h2>{c.reviewContext}</h2><p>{c.reviewHint}</p>{error && <p role="alert">{error}</p>}<textarea aria-label={c.reviewContext} value={review ?? ""} onChange={event => setReview(event.target.value)}/><div><button className="ad-button" disabled={pending || !stopped} onClick={() => { if (review === undefined) return; const generation=reviewGeneration.current; setPending(true); setError(""); void createChatContinuation(session.id, locale, { reviewedDraft: review, checkpointThread: restoring?.thread }).then(id => { closeReview(); showSessionSurface(id); }).catch(failure => {if(reviewGeneration.current===generation)setError(String(failure));}).finally(() => {if(reviewGeneration.current===generation)setPending(false);}); }}>{c.createChat}</button><button className="ad-button ad-button-ghost" disabled={pending} onClick={closeReview}><X size={14}/>{c.cancel}</button></div></dialog>
  </div>;
}
