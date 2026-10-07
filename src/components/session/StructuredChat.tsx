import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, ArrowUp, Download, FileText, FolderOpen, ImagePlus, LoaderCircle, Paperclip, Pencil, Plus, Search, ShieldCheck, Square, Target, TerminalSquare, X } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { useSessionStore, type ClaudeSession } from "../../store/sessionStore";
import { RUNNER_LABELS, useSettingsStore, type RunnerType } from "../../store/settingsStore";
import { emptyThread, sendChatTurn, stopChatTurn, useChatStore, type ChatAttachment } from "../../store/chatStore";
import { ProviderIcon } from "../ProviderIcon";
import { AgentModelPicker } from "./AgentModelPicker";
import { ChatMarkdown, CopyButton } from "./ChatMarkdown";
import { SketchDialog } from "./SketchDialog";
import { modelDisplayName } from "../../services/agentExecution";
import { modelCopy } from "./modelCopy";
import { chatCopy } from "./chatCopy";
import { SaveResponseToMemory } from "../memory/SaveResponseToMemory";
import "./chat.css";
import { workflowCopy } from "./workflowCopy";
import { CommandTextarea } from "./CommandTextarea";
import { fallbackCommands, type AgentCatalogue } from "../../services/agentCommands";
import { runChatCommand } from "../../services/chatCommands";
import { commandCopy } from "./commandCopy";

interface PendingAttachment extends ChatAttachment { preview?: string }
const CHAT_BRAND = "AGENTDECK / WORKSPACE";
function readBase64(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(reader.error); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.readAsDataURL(file); }); }

export function StructuredChat({ session, visible, onNative, nativeLive = false }: { session: ClaudeSession; visible: boolean; onNative: (query?: string) => void; nativeLive?: boolean }) {
  const { t, locale } = useAppI18n(); const c = chatCopy(locale);
  const w = workflowCopy(locale);
  const [catalogue, setCatalogue] = useState<AgentCatalogue>({ entries: fallbackCommands(session.runner), warnings: [] });
  const [browse, setBrowse] = useState<{ revision: number; filter: "all" | "skill" }>();
  const [commandNotice, setCommandNotice] = useState("");
  const thread = useChatStore(s => s.threads[session.id] ?? emptyThread);
  const worktreeReady = useSessionStore(s => s.worktreeReadyIds.has(session.id));
  const storageError = useChatStore(s => s.storageError);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false); const uploadingRef = useRef(false);
  const [error, setError] = useState(""); const [menu, setMenu] = useState(false);
  const [showGoal, setShowGoal] = useState(!!thread.goal); const [sketch, setSketch] = useState(false);
  const [search, setSearch] = useState<string | null>(null); const [dragging, setDragging] = useState(false); const dragDepth = useRef(0);
  const [follow, setFollow] = useState(true); const [now, setNow] = useState(Date.now());
  const scrollRef = useRef<HTMLDivElement>(null); const inputRef = useRef<HTMLTextAreaElement>(null); const filesRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef(attachments); attachmentsRef.current = attachments;
  const patch = (value: Parameters<ReturnType<typeof useChatStore.getState>["patch"]>[1]) => useChatStore.getState().patch(session.id, value);
  useEffect(() => () => attachmentsRef.current.forEach(a => a.preview && URL.revokeObjectURL(a.preview)), []);
  useEffect(() => { if (visible && !thread.messages.length) inputRef.current?.focus(); }, [visible]);
  useEffect(() => { if (follow && visible) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [thread.messages, thread.busy, follow, visible]);
  useEffect(() => { if (!thread.busy || !visible) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [thread.busy, visible]);
  const addFiles = async (files: File[]) => {
    if (!files.length || uploadingRef.current) return;
    if (files.length + attachmentsRef.current.length > 12 || files.some(f => f.size > 20 * 1024 ** 2) || files.reduce((n, f) => n + f.size, 0) + attachmentsRef.current.reduce((n, f) => n + f.size, 0) > 40 * 1024 ** 2) { setError(c.maxFiles); return; }
    uploadingRef.current = true; setUploading(true); setError("");
    try {
      for (const file of files) {
        const saved = await invoke<ChatAttachment>("save_chat_attachment", { sessionId: session.id, name: file.name, mimeType: file.type || "application/octet-stream", dataBase64: await readBase64(file) });
        if (!saved?.path) throw new Error("Attachment was not saved");
        const attachment = { ...saved, preview: /^image\//.test(file.type) ? URL.createObjectURL(file) : undefined };
        setAttachments(current => [...current, attachment]);
      }
    } catch (e) { setError(String(e)); }
    finally { uploadingRef.current = false; setUploading(false); }
  };
  const submit = async () => {
    if (nativeLive || uploading || !worktreeReady || (!thread.draft.trim() && !attachments.length)) return;
    setError(""); setFollow(true); setSearch(null); setMenu(false);
    try {
      if (thread.draft.trimStart().startsWith('/')) {
        if (attachments.length) throw new Error(commandCopy(locale).attachments);
        if (runChatCommand(thread.draft, session, catalogue, locale, { browse: filter => setBrowse({ revision: Date.now(), filter }), native: onNative, notice: setCommandNotice })) { patch({ draft: "" }); return; }
      }
      setCommandNotice("");
    } catch (error) { setError(String(error)); return; }
    const ok = await sendChatTurn(session.id, thread.draft.trim() || c.attachmentOnly, attachments.map(({ preview: _, ...file }) => file));
    if (ok) { attachments.forEach(a => a.preview && URL.revokeObjectURL(a.preview)); setAttachments([]); }
  };
  const exportChat = () => {
    const text = `# ${session.name}\n\n${thread.messages.map(m => `## ${m.role === "user" ? c.you : m.role === "tool" ? m.title || c.tools : RUNNER_LABELS[session.runner.type]}\n\n${m.text}${m.attachments?.length ? "\n\n" + m.attachments.map(a => `- ${a.name}`).join("\n") : ""}`).join("\n\n")}`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" })); const a = document.createElement("a"); a.href = url; a.download = `${session.name.replace(/[^\p{L}\p{N} _-]/gu, "").slice(0, 60) || "conversation"}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const switchProvider = (type: RunnerType) => { if (type === session.runner.type || nativeLive || thread.busy) return; useSessionStore.getState().updateSession(session.id, { runner: useSettingsStore.getState().getRunnerConfigForType(type), providerSessionId: undefined }); patch({ providerSessionId: undefined, lastSentGoal: undefined, lastUsage: undefined, resolvedModel: undefined }); if (type === "gemini") onNative(); };
  const filtered = search ? thread.messages.filter(m => `${m.title ?? ""} ${m.text} ${m.attachments?.map(a => a.name).join(" ") ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) : thread.messages;
  const activeMessage = thread.messages.find(m => m.turnId === thread.turnId);
  const elapsed = activeMessage ? Math.max(0, Math.floor((now - activeMessage.at) / 1000)) : 0;
  return <section className="ad-chat" aria-label={c.chat} onDragEnter={e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); dragDepth.current++; setDragging(true); } }} onDragOver={e => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDragLeave={e => { e.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }} onDrop={e => { e.preventDefault(); dragDepth.current = 0; setDragging(false); void addFiles(Array.from(e.dataTransfer.files)); }}>
    {!!thread.messages.length && <header className="ad-chat-heading"><span><ProviderIcon provider={session.runner.type} size={18} /><strong>{RUNNER_LABELS[session.runner.type]}</strong><small title={thread.resolvedModel ? modelCopy(locale).reported : undefined}>{thread.resolvedModel || modelDisplayName(session.runner, session.worktreePath || session.workdir) || t("chat.defaultModel")}</small></span><div><button className="ad-icon-button" title={c.search} aria-label={c.search} onClick={() => setSearch(search === null ? "" : null)}><Search size={16} /></button><button className="ad-icon-button" title={c.export} aria-label={c.export} onClick={exportChat}><Download size={16} /></button></div></header>}
    {search !== null && <div className="ad-chat-search"><Search size={16} /><input autoFocus aria-label={c.searching} placeholder={c.searching} value={search} onChange={e => setSearch(e.target.value)} /><button className="ad-icon-button" aria-label={c.cancel} onClick={() => setSearch(null)}><X size={15} /></button></div>}
    <div className={`ad-chat-scroll ${!thread.messages.length ? "is-empty" : ""}`} ref={scrollRef} onScroll={e => { const el = e.currentTarget; setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 90); }}>
      {!thread.messages.length ? <div className="ad-chat-welcome">
        <div className="ad-chat-logo"><img src="/agentdeck-logo.jpg" alt="Agentdeck" /></div><span className="ad-eyebrow">{CHAT_BRAND}</span><h2>{c.ready}</h2><p>{c.intro}</p>
        <div className="ad-agent-pills" role="group" aria-label={t("agents.title")}>{(Object.entries(RUNNER_LABELS) as [RunnerType, string][]).map(([type, label]) => <button key={type} className="ad-button" disabled={nativeLive || thread.busy} aria-pressed={type === session.runner.type} onClick={() => switchProvider(type)}><ProviderIcon provider={type} size={17} />{label}</button>)}</div>
        {session.providerSessionId && <p className="ad-hint">{c.restore}</p>}
      </div> : <div className="ad-chat-messages" role="log" aria-label={c.chat}>
        {filtered.map(message => message.role === "tool" ? <details className="ad-chat-tool" key={message.id}><summary><TerminalSquare size={14} /><strong>{message.title || c.tools}</strong><span>{message.status === "completed" ? c.done : message.status}</span></summary><pre>{message.text}</pre></details> : <article key={message.id} className={`ad-message ad-message-${message.role}`}>
          <div className="ad-message-meta">{message.role === "assistant" ? <ProviderIcon provider={session.runner.type} size={19} /> : <span className="ad-user-avatar">{c.you.slice(0, 1)}</span>}<strong>{message.role === "user" ? c.you : RUNNER_LABELS[session.runner.type]}</strong>{message.parentId && <small className="ad-subagent-label" title={message.parentId}>{locale.startsWith("en") ? "Subagent" : "Subagente"} · {message.parentId.slice(-6)}</small>}<time>{new Date(message.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</time><CopyButton text={message.text} />{message.role === "assistant" && <SaveResponseToMemory session={session} text={message.text} disabled={thread.busy} onError={setError} />}</div>
          <div className="ad-message-body">{message.role === "assistant" ? <ChatMarkdown text={message.text} /> : <p className="ad-user-text">{message.text}</p>}{message.role === "user" && message.status && <small className="ad-supplement-status" role="status" title={message.title}>{message.status === "accepted" ? w.accepted : message.status === "failed" ? w.failed : message.status === "queued" ? w.queued : w.sending}</small>}{!!message.attachments?.length && <div className="ad-message-files">{message.attachments.map((file, index) => <span key={index}><Paperclip size={13} />{file.name}</span>)}</div>}</div>
        </article>)}
        {search && !filtered.length && <p className="ad-hint">{c.noMatch}</p>}
      </div>}
      {thread.busy && <div className="ad-chat-progress" role="status"><LoaderCircle size={16} className="ad-spin" /><span>{thread.messages.some(m => m.turnId === thread.turnId && m.role !== "user") ? c.working : c.starting}</span><time>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</time></div>}
      {thread.status === "stopped" && !thread.busy && <p className="ad-chat-progress">{c.stopped}</p>}
      {thread.diagnostic && <details className="ad-chat-diagnostics"><summary>{c.tools}</summary><pre>{thread.diagnostic}</pre></details>}
    </div>
    {!follow && thread.messages.length > 0 && <button className="ad-latest ad-button" aria-label={c.latest} title={c.latest} onClick={() => { setFollow(true); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }}><ArrowDown size={16} /></button>}
    <div className="ad-chat-bottom">
      {commandNotice && <div className="ad-command-notice" role="status"><span>{commandNotice}</span><button type="button" className="ad-icon-button" aria-label={c.cancel} onClick={() => setCommandNotice("")}><X size={13} /></button></div>}
      {!thread.busy && thread.messages.some(m => m.turnId === thread.turnId && m.status === "blocked") && <div className="ad-chat-error"><p>{c.nativeHint}</p><button className="ad-button" onClick={() => onNative()}><TerminalSquare size={14} />{c.native}</button></div>}
      {(error || thread.error) && <div className="ad-chat-error" role="alert"><strong>{c.errorTitle}</strong><p>{error || thread.error}</p>{thread.error && !thread.busy && <button className="ad-button" disabled={nativeLive} onClick={() => { const last = [...thread.messages].reverse().find(m => m.role === "user"); if (last) void sendChatTurn(session.id, last.text, last.attachments ?? []); }}>{c.retry}</button>}<button className="ad-button ad-button-ghost" disabled={thread.busy} onClick={() => onNative()}><TerminalSquare size={14} />{c.native}</button></div>}
      {storageError && <p className="ad-chat-error" role="alert">{c.storageError}</p>}
      <div className="ad-composer ad-chat-composer">
        {showGoal && <label className="ad-chat-goal"><Target size={15} /><input aria-label={c.goal} placeholder={c.goalPlaceholder} title={c.goalHint} value={thread.goal ?? ""} disabled={thread.busy} onChange={e => patch({ goal: e.target.value })} /><button className="ad-icon-button" aria-label={c.remove} disabled={thread.busy} onClick={() => { setShowGoal(false); patch({ goal: "" }); }}><X size={14} /></button></label>}
        {!!attachments.length && <div className="ad-attachments">{attachments.map((file, index) => <div className="ad-attachment" key={file.path}>{file.preview ? <img src={file.preview} alt={file.name} /> : <FileText size={22} />}<span><strong>{file.name}</strong><small>{Math.ceil(file.size / 1024)} KB</small></span><button className="ad-icon-button" aria-label={`${c.removeAttachment}: ${file.name}`} onClick={() => { if (file.preview) URL.revokeObjectURL(file.preview); setAttachments(files => files.filter((_, i) => i !== index)); }}><X size={14} /></button></div>)}</div>}
        <CommandTextarea visible={visible} inputRef={inputRef} runner={session.runner} workdir={session.worktreePath || session.workdir} projectPath={session.workdir} browse={browse} onCatalogue={setCatalogue} disabled={nativeLive} rows={2} aria-label={t("session.promptTitle")} placeholder={thread.messages.length ? t("chat.followup") : t("session.promptPlaceholder")} value={thread.draft} onValueChange={value => patch({ draft: value })} onPaste={e => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); void addFiles(files); } }} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } if (e.key === "Escape") setMenu(false); }} />
        <div className="ad-composer-footer"><div className="ad-add-context"><button className="ad-icon-button ad-add-button" aria-label={c.add} title={c.add} disabled={uploading} aria-expanded={menu} onClick={() => setMenu(!menu)}><Plus size={19} /></button>{menu && <><button className="ad-menu-dismiss" tabIndex={-1} aria-label={c.cancel} onClick={() => setMenu(false)} /><div className="ad-context-menu"><small>{c.add}</small><button onClick={() => { filesRef.current?.click(); setMenu(false); }}><ImagePlus size={16} />{c.files}<kbd>+</kbd></button><button onClick={() => { setShowGoal(!showGoal); setMenu(false); }}><Target size={16} />{c.goal}</button><button onClick={() => { setSketch(true); setMenu(false); }}><Pencil size={16} />{c.sketch}</button><button onClick={() => { setMenu(false); void invoke<string | null>("pick_folder").then(path => { if (path) patch({ draft: `${thread.draft}\n\n@${JSON.stringify(path)}`.trim() }); }).catch(e => setError(String(e))); }}><FolderOpen size={16} />{c.folder}</button></div></>}</div>
          <input hidden ref={filesRef} type="file" multiple onChange={e => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} aria-label={c.attach} />
          <AgentModelPicker runner={session.runner} workdir={session.worktreePath || session.workdir} disabled={thread.busy || nativeLive} onChange={value => useSessionStore.getState().updateSession(session.id, { runner: { ...session.runner, ...value } })} />
          {thread.busy && <button className="ad-button ad-chat-send" aria-label={c.stop} title={c.stop} onClick={() => void stopChatTurn(session.id)}><Square size={16} fill="currentColor" /></button>}
          <button className="ad-button ad-button-primary ad-chat-send" aria-label={thread.busy ? w.supplement : t("chat.send")} title={thread.busy ? w.supplement : t("chat.send")} disabled={nativeLive || uploading || !worktreeReady || (!thread.draft.trim() && !attachments.length)} onClick={() => void submit()}>{uploading ? <LoaderCircle size={18} className="ad-spin" /> : <ArrowUp size={19} />}</button>
        </div>
      </div>
      <div className="ad-chat-footnote"><span>{uploading ? c.upload : thread.busy ? w.liveHint : c.footer}</span><span title={session.runner.fullAccess !== false ? w.fullHint : c.nativeHint}><ShieldCheck size={12} />{session.runner.mode === "plan" ? c.readOnly : session.runner.fullAccess !== false ? w.fullAccess : c.code}</span></div>
      {!thread.messages.length && <div className="ad-native-entry"><button className="ad-button ad-button-ghost" onClick={() => onNative()}><TerminalSquare size={14} />{c.openNative}</button><span>{c.nativeHint}</span></div>}
    </div>
    {dragging && <div className="ad-drop-overlay"><Paperclip size={32} /><strong>{c.drop}</strong></div>}
    {sketch && <SketchDialog onClose={() => setSketch(false)} onAttach={file => void addFiles([file])} />}
  </section>;
}
