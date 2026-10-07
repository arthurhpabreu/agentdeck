import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, BookOpenText, Check, ChevronDown, CircleAlert, Copy, Database, Download, Folder, Globe, Info, LoaderCircle, Pencil, Pin, PinOff, Plus, RefreshCw, RotateCcw, Search, Settings2, ShieldCheck, Trash2, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAppI18n } from "../../i18n";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useSessionStore } from "../../store/sessionStore";
import { RUNNER_LABELS, type RunnerType } from "../../store/settingsStore";
import { useSharedMemoryStore, emptyProjectMemory } from "../../store/sharedMemoryStore";
import { useMemoryRuntimeEvents, useMemoryRuntimeStore } from "../../store/memoryRuntimeStore";
import { GLOBAL_MEMORY_KEY, memoryCommands, type MemoryConfiguration, type MemoryDraft, type MemoryKind, type MemoryRecord } from "../../services/memoryCommands";
import { showSessionSurface } from "../../services/workbenchCommands";
import { ProviderIcon } from "../ProviderIcon";
import { memoryCopy } from "./memoryCopy";
import { MemoryIntelligencePanel, MemoryNoteHistory } from "./MemoryIntelligencePanel";
import { curationCopy } from "./MemoryCurationControl";
import "./sharedMemory.css";

const emptyDraft = (): MemoryDraft => ({ title: "", content: "", kind: "fact", pinned: false });
const knownProvider = (provider?: string | null): provider is RunnerType => provider === "codex" || provider === "claude-code" || provider === "gemini";

export function SharedMemoryPanel() {
  const activeWorkspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const scope = useSharedMemoryStore(state => state.memoryScope);
  return <ProjectMemoryPanel key={`${scope}:${activeWorkspaceId ?? "no-project"}`} />;
}

function ProjectMemoryPanel() {
  useMemoryRuntimeEvents();
  const { locale } = useAppI18n();
  const m = memoryCopy(locale);
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const project = workspaces.find(workspace => workspace.id === activeWorkspaceId);
  const scope = useSharedMemoryStore(state => state.memoryScope);
  const global = scope === "global";
  const path = global ? GLOBAL_MEMORY_KEY : project?.path ?? "";
  const sessions = useSessionStore(state => state.sessions);
  const activeSessionId = useSessionStore(state => state.activeSessionId);
  const activeSession = sessions.find(session => session.id === activeSessionId && session.workspaceId === project?.id);
  const memory = useSharedMemoryStore(state => state.projects[path] ?? emptyProjectMemory);
  const changes = useMemoryRuntimeStore(state => memory.status?.projectKey ? state.changes[memory.status.projectKey] ?? 0 : 0);
  const { load, save, setPinned, remove, configure, resetSession, clearError } = useSharedMemoryStore();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<MemoryKind | "all">("all");
  const [selected, setSelected] = useState<MemoryRecord | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MemoryDraft>(emptyDraft);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Null follows the saved setting; every string, including empty, is an intentional draft.
  const [budget, setBudget] = useState<string | null>(null);
  const [validation, setValidation] = useState("");
  const [feedback, setFeedback] = useState("");
  const [exporting, setExporting] = useState(false);
  const [storageError, setStorageError] = useState("");
  const currentPath = useRef(path);
  currentPath.current = path;
  const titleInput = useRef<HTMLInputElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const newNoteButton = useRef<HTMLButtonElement>(null);
  const noteButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnToNote = useRef<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const editorId = useId();
  const desktop = "__TAURI_INTERNALS__" in window;
  const searchLabel = global ? m.globalSearch : m.search;
  const enabledLabel = global ? m.globalEnabled : m.enabled;
  const scopeLabel = global ? m.global : project?.name ?? m.projectScope;
  const exportNotes = async () => {
    setStorageError("");
    try {
      const destination = await invoke<string | null>("pick_folder");
      if (typeof destination !== "string") return;
      setExporting(true);
      const result = await memoryCommands.exportMarkdown(path, destination);
      setFeedback(`${m.exported}: ${result.directory}`);
    } catch (error) { setStorageError(`${m.storageError} ${String(error)}`); }
    finally { setExporting(false); }
  };
  const storageAction = async (action: () => Promise<void>, success?: string) => {
    setStorageError("");
    try { await action(); if (success) setFeedback(success); }
    catch (error) { setStorageError(`${m.storageError} ${String(error)}`); }
  };

  useEffect(() => {
    setQuery(""); setKind("all"); setSelected(null); setEditing(false); setDraft(emptyDraft());
    setConfirmDelete(false); setBudget(null); setValidation(""); setFeedback("");
  }, [path]);
  useEffect(() => {
    if (!path || !desktop) return;
    const timer = setTimeout(() => void load(path, query.trim()), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [path, query, load, desktop]);
  useEffect(() => {
    if (!path || !desktop) return;
    const refresh = () => { if (!document.hidden && !useSharedMemoryStore.getState().projects[path]?.saving) void load(path, query.trim()); };
    const timer = window.setInterval(refresh, 20_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [path, query, load, desktop]);
  useEffect(() => { if (editing) titleInput.current?.focus(); }, [editing]);
  useEffect(() => {
    if (editing) return;
    if (selected) detailHeading.current?.focus({ preventScroll: true });
    else if (returnToNote.current !== null) {
      (noteButtons.current.get(returnToNote.current) ?? newNoteButton.current)?.focus({ preventScroll: true });
      returnToNote.current = null;
    }
  }, [selected?.id, editing]);
  useEffect(() => {
    if (!changes || !path) return;
    const timer = setTimeout(() => { if (!useSharedMemoryStore.getState().projects[path]?.saving) void load(path, query.trim()); }, 400);
    return () => clearTimeout(timer);
  }, [changes, path, query, load]);
  useEffect(() => {
    if (!selected || editing) return;
    const latest = memory.records.find(record => record.id === selected.id);
    if (latest && latest.revision > selected.revision) setSelected(latest);
  }, [memory.records, selected, editing]);

  const formatDate = (at: number) => Number.isFinite(at) ? new Date(at).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  const origin = (record: MemoryRecord) => record.source === "curation" ? curationCopy(locale).automatic : record.source === "capture" ? m.automatic : record.source === "mcp" ? m.mcp : record.source === "manual" ? m.manual : knownProvider(record.provider) ? RUNNER_LABELS[record.provider] : "—";
  const kindLabel = (value: string) => value === "handoff" ? m.handoff : value === "decision" ? m.decision : m.fact;
  const records = memory.records.filter(record => kind === "all" || record.kind === kind).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  const clearMutationError = () => {
    const failed = useSharedMemoryStore.getState().projects[path]?.failedAction;
    if (failed && failed.type !== "load") clearError(path);
  };

  const openEditor = (record?: MemoryRecord) => {
    clearMutationError();
    returnToNote.current = record?.id ?? "";
    setSelected(record ?? null); setEditing(true); setConfirmDelete(false); setValidation(""); setFeedback("");
    setDraft(record ? { id: record.id, title: record.title, content: record.content, kind: record.kind, pinned: record.pinned, sourceSessionId: record.sourceSessionId, provider: record.provider } : emptyDraft());
    panelRef.current?.scrollTo({ top: 0 });
  };
  const openRecord = (record: MemoryRecord) => { clearMutationError(); returnToNote.current = record.id; setSelected(record); setEditing(false); setConfirmDelete(false); setFeedback(""); setValidation(""); panelRef.current?.scrollTo({ top: 0 }); };
  const back = () => { clearMutationError(); setSelected(null); setEditing(false); setConfirmDelete(false); setValidation(""); };
  const cancelEditor = () => { clearMutationError(); setEditing(false); setValidation(""); };
  const cancelDelete = () => { if (memory.failedAction?.type === "delete") clearError(path); setConfirmDelete(false); };
  const saveDraft = async (value = draft) => {
    if (!value.title.trim() || !value.content.trim()) { setValidation(m.validation); return; }
    if (new TextEncoder().encode(value.title.trim()).length > 240) { setValidation(m.titleTooLong); return; }
    if (new TextEncoder().encode(value.content.trim()).length > 12000) { setValidation(m.contentTooLong); return; }
    const requestedPath = path;
    setValidation("");
    const record = await save(requestedPath, { ...value, title: value.title.trim(), content: value.content.trim() });
    if (record && currentPath.current === requestedPath) { setSelected(record); setEditing(false); setFeedback(m.saved); }
  };
  const pinRecord = async (id: string, pinned: boolean) => {
    const requestedPath = path;
    const saved = await setPinned(requestedPath, id, pinned);
    if (saved && currentPath.current === requestedPath && selected?.id === id) setSelected(saved);
  };
  const deleteRecord = async (id = selected?.id) => {
    if (!id) return;
    const requestedPath = path;
    if (await remove(requestedPath, id) && currentPath.current === requestedPath) { back(); setFeedback(m.deleted); }
  };
  const changeConfiguration = async (patch: Partial<MemoryConfiguration>) => {
    if (!memory.status) return;
    const requestedPath = path;
    const configuration = { enabled: memory.status.enabled, captureEnabled: memory.status.captureEnabled, budgetTokens: memory.status.budgetTokens, ...patch };
    if (await configure(requestedPath, configuration, patch) && currentPath.current === requestedPath) {
      setFeedback(m.configurationSaved);
      if (patch.budgetTokens !== undefined) setBudget(null);
    }
  };
  const applyBudget = () => {
    if (memory.saving || !memory.status || budget === null) return;
    const amount = Number(budget);
    if (!budget.trim() || !Number.isInteger(amount) || amount < 256 || amount > 2000) { setValidation(m.budgetInvalid); return; }
    setValidation(""); void changeConfiguration({ budgetTokens: amount });
  };
  const cancelBudget = () => { if (memory.failedAction?.type === "configure" && memory.failedAction.patch.budgetTokens !== undefined) clearError(path); setBudget(null); setValidation(""); };
  const recall = async (sessionId: string, provider: string) => {
    const requestedPath = path;
    if (await resetSession(path, sessionId, provider) && currentPath.current === requestedPath) setFeedback(m.recalled);
  };
  const retryFailedAction = () => {
    const action = memory.failedAction;
    if (!action || action.type === "load") { void load(path, query); return; }
    if (action.type === "save") void saveDraft(editing ? draft : action.draft);
    else if (action.type === "pin") void pinRecord(action.id, action.pinned);
    else if (action.type === "delete") void deleteRecord(action.id);
    else if (action.type === "recall") void recall(action.sessionId, action.provider);
    else if (action.type === "configure") {
      if (action.patch.budgetTokens !== undefined && budget !== null) applyBudget();
      else void changeConfiguration(action.patch);
    }
  };

  return <section className="ad-memory-panel" ref={panelRef} aria-label={m.title}>
    <header className="ad-memory-heading"><h2>{m.title}</h2><p>{m.intro}</p></header>
    <div className="ad-memory-scopes" role="group" aria-label={m.scopeLabel}><button type="button" aria-pressed={global} disabled={memory.saving || exporting} onClick={() => useSharedMemoryStore.getState().setMemoryScope("global")}><Globe size={14} />{m.global}</button><button type="button" aria-pressed={!global} disabled={memory.saving || exporting} onClick={() => useSharedMemoryStore.getState().setMemoryScope("project")}><Folder size={14} />{m.projectScope}</button></div>
    <p className="ad-memory-scope-hint">{global ? m.globalHint : m.projectHint}</p>
    {!global && !!workspaces.length && <label className="ad-memory-project"><Folder size={14} /><select aria-label={m.project} value={activeWorkspaceId ?? ""} onChange={event => useWorkspaceStore.getState().setActiveWorkspace(event.target.value)}>{!activeWorkspaceId && <option value="">{m.noProject}</option>}{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select><ChevronDown size={12} /></label>}
    {!project && !global ? <div className="ad-memory-empty"><Folder size={29} /><p>{m.noProject}</p></div> : !desktop ? <div className="ad-memory-empty"><Database size={29} /><p>{m.desktop}</p></div> : <>
      {!selected && !editing && <>
        <MemoryIntelligencePanel path={path} />
        <div className="ad-memory-overview"><span><Database size={12} />{memory.status?.recordCount ?? "—"} {m.notes.toLocaleLowerCase()}</span><span data-enabled={memory.status?.enabled === true}><i />{memory.status ? memory.status.enabled ? m.on : m.off : m.loading}</span></div>
        <details className="ad-memory-preferences"><summary><Settings2 size={13} /><span>{m.preferences}</span><ChevronDown size={12} /></summary><div>
          <div className="ad-memory-setting"><label><strong>{enabledLabel}</strong><small>{m.enabledHint}</small></label><button type="button" role="switch" className="ad-memory-switch" aria-label={enabledLabel} aria-checked={memory.status?.enabled === true} disabled={!memory.status || memory.saving} onClick={() => void changeConfiguration({ enabled: !memory.status?.enabled })}><span /></button></div>
          {!global && <div className="ad-memory-setting"><label><strong>{m.capture}</strong><small>{m.captureHint}</small></label><button type="button" role="switch" className="ad-memory-switch" aria-label={m.capture} aria-checked={memory.status?.captureEnabled === true} disabled={!memory.status || memory.saving} onClick={() => void changeConfiguration({ captureEnabled: !memory.status?.captureEnabled })}><span /></button></div>}
          <p className="ad-memory-scope-hint">{global ? m.globalBudgetHint : m.projectBudgetHint}</p>
          <div className="ad-memory-budget"><label htmlFor={`${editorId}-budget`}>{m.budget}</label><div><input id={`${editorId}-budget`} type="number" min={256} max={2000} step={1} aria-label={m.budget} aria-describedby={`${editorId}-budget-hint`} aria-invalid={validation === m.budgetInvalid} value={budget ?? String(memory.status?.budgetTokens ?? 800)} disabled={!memory.status || memory.saving} onChange={event => setBudget(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); applyBudget(); } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelBudget(); } }} /><span>{m.tokens}</span><button type="button" className="ad-memory-budget-apply" aria-label={m.apply} title={m.apply} disabled={budget === null || !memory.status || memory.saving} onClick={applyBudget}><Check size={14} /></button>{budget !== null && <button type="button" className="ad-memory-icon" aria-label={m.cancel} title={m.cancel} disabled={memory.saving} onClick={cancelBudget}><X size={14} /></button>}</div><small id={`${editorId}-budget-hint`}>{m.budgetHint} {m.budgetRange}</small></div>
        </div></details>
      </>}
      {memory.error && <div className="ad-memory-error" role="alert"><CircleAlert size={14} /><div><strong>{m.loadError}</strong><p>{memory.error}</p><button type="button" onClick={retryFailedAction} disabled={memory.saving || (memory.loading && memory.failedAction?.type === "load")}>{m.retry}</button></div></div>}
      {validation && <p className="ad-memory-validation" role="alert">{validation}</p>}
      {feedback && <p className="ad-memory-feedback" role="status"><Check size={13} />{feedback}</p>}
      {editing ? <div className="ad-memory-editor">
        <div className="ad-memory-detail-heading"><button type="button" className="ad-memory-icon" aria-label={m.back} onClick={cancelEditor} disabled={memory.saving}><ArrowLeft size={16} /></button><h3>{draft.id ? m.edit : m.newNote}</h3></div>
        <p className="ad-memory-scope-hint">{m.scopeSaved}: <strong>{scopeLabel}</strong></p>
        <label htmlFor={`${editorId}-title`}>{m.titleField}</label><input ref={titleInput} id={`${editorId}-title`} value={draft.title} maxLength={180} placeholder={m.titlePlaceholder} disabled={memory.saving} onChange={event => setDraft(value => ({ ...value, title: event.target.value }))} />
        <label htmlFor={`${editorId}-kind`}>{m.kindField}</label><select id={`${editorId}-kind`} value={draft.kind} disabled={memory.saving} onChange={event => setDraft(value => ({ ...value, kind: event.target.value as MemoryKind }))}><option value="fact">{m.fact}</option><option value="decision">{m.decision}</option><option value="handoff">{m.handoff}</option></select>
        <label htmlFor={`${editorId}-content`}>{m.contentField}</label><textarea id={`${editorId}-content`} rows={11} value={draft.content} placeholder={global ? m.globalPlaceholder : m.contentPlaceholder} disabled={memory.saving} onChange={event => setDraft(value => ({ ...value, content: event.target.value }))} />
        <label className="ad-memory-pin-field"><input type="checkbox" checked={draft.pinned} disabled={memory.saving} onChange={event => setDraft(value => ({ ...value, pinned: event.target.checked }))} /><Pin size={12} />{m.pinned}</label>
        {global && <p className="ad-memory-scope-hint">{m.pinHint}</p>}
        <div className="ad-memory-editor-actions"><button type="button" className="ad-memory-primary" disabled={memory.saving || !draft.title.trim() || !draft.content.trim()} onClick={() => void saveDraft()}>{memory.saving ? <LoaderCircle size={14} className="ad-memory-spinning" /> : <Check size={14} />}{memory.saving ? m.saving : m.save}</button><button type="button" className="ad-memory-button" disabled={memory.saving} onClick={cancelEditor}>{m.cancel}</button></div>
      </div> : selected ? <article className="ad-memory-detail" key={selected.id}>
        <div className="ad-memory-detail-heading"><button type="button" className="ad-memory-icon" aria-label={m.back} title={m.back} onClick={back} disabled={memory.saving}><ArrowLeft size={16} /></button><span className="ad-memory-kind" data-kind={selected.kind}>{kindLabel(selected.kind)}</span><span className="ad-memory-detail-spacer" /><button type="button" className="ad-memory-icon" aria-label={selected.pinned ? m.unpin : m.pin} title={selected.pinned ? m.unpin : m.pin} disabled={memory.saving} onClick={() => void pinRecord(selected.id, !selected.pinned)}>{selected.pinned ? <PinOff size={14} /> : <Pin size={14} />}</button><button type="button" className="ad-memory-icon" aria-label={m.edit} title={m.edit} disabled={memory.saving} onClick={() => openEditor(selected)}><Pencil size={14} /></button><button type="button" className="ad-memory-icon ad-memory-danger" aria-label={m.delete} title={m.delete} disabled={memory.saving} onClick={() => setConfirmDelete(true)}><Trash2 size={14} /></button></div>
        <h3 ref={detailHeading} tabIndex={-1}>{selected.title}</h3><div className="ad-memory-note-metadata"><span>{origin(selected)}</span><time>{formatDate(selected.updatedAt)}</time>{selected.pinned && <span><Pin size={12} />{m.pinned}</span>}</div>
        <span className="ad-memory-verification" data-verified={selected.verification === "user-confirmed"}>{selected.verification === "user-confirmed" ? <ShieldCheck size={11} /> : <Info size={11} />}{selected.verification === "user-confirmed" ? m.confirmed : selected.verification === "auto-selected" ? curationCopy(locale).automatic : m.unverified}</span>
        {confirmDelete && <div className="ad-memory-delete-confirm" role="alert"><strong>{m.confirmDelete}</strong><p>{m.deleteHint}</p><div><button type="button" className="ad-memory-button ad-memory-danger" disabled={memory.saving} onClick={() => void deleteRecord()}><Trash2 size={12} />{m.delete}</button><button type="button" className="ad-memory-button" disabled={memory.saving} onClick={cancelDelete}>{m.cancel}</button></div></div>}
        <div className="ad-memory-note-content">{selected.content || m.noContent}</div>
        <MemoryNoteHistory path={path} note={selected} onChanged={async () => { await load(path, query); const records = useSharedMemoryStore.getState().projects[path]?.records ?? []; const latest = records.find(record => record.id === selected.id); if (latest) setSelected(latest); else back(); }} />
        <dl className="ad-memory-provenance"><dt>{m.revision}</dt><dd>{selected.revision}</dd>{selected.provider && <><dt>{m.provider}</dt><dd>{knownProvider(selected.provider) && <ProviderIcon provider={selected.provider} size={12} />}{knownProvider(selected.provider) ? RUNNER_LABELS[selected.provider] : selected.provider}</dd></>}{selected.sourceSessionId && <><dt>{m.sourceSession}</dt><dd><code>{selected.sourceSessionId}</code></dd></>}</dl>
        {selected.sourceSessionId && sessions.some(session => session.id === selected.sourceSessionId) && <button type="button" className="ad-memory-button" onClick={() => showSessionSurface(selected.sourceSessionId!)}>{m.openSession}<ArrowUpRight size={12} /></button>}
      </article> : <>
        <div className="ad-memory-list-actions"><h3>{m.notes}</h3><button type="button" className="ad-memory-icon" aria-label={m.refresh} title={m.refresh} disabled={memory.loading || memory.saving} onClick={() => void load(path, query)}><RefreshCw size={14} className={memory.loading ? "ad-memory-spinning" : ""} /></button><button type="button" ref={newNoteButton} className="ad-memory-primary" disabled={memory.saving} onClick={() => openEditor()}><Plus size={14} />{m.newNote}</button></div>
        <label className="ad-memory-search"><Search size={13} /><input type="search" aria-label={searchLabel} placeholder={searchLabel} value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label={m.clearSearch} onClick={() => setQuery("")}><X size={12} /></button>}</label>
        <select className="ad-memory-kind-filter" aria-label={m.kindField} value={kind} onChange={event => setKind(event.target.value as MemoryKind | "all")}><option value="all">{m.all}</option><option value="handoff">{m.handoff}</option><option value="decision">{m.decision}</option><option value="fact">{m.fact}</option></select>
        {memory.loading && !memory.updatedAt && <p className="ad-memory-loading" role="status"><LoaderCircle size={14} className="ad-memory-spinning" />{m.loading}</p>}
        {!records.length && !memory.loading && !memory.error && <div className="ad-memory-empty"><strong>{query || kind !== "all" ? m.noResults : global ? m.globalEmpty : m.empty}</strong>{!query && kind === "all" ? <p>{global ? m.globalEmptyHint : m.emptyHint}</p> : <button type="button" className="ad-memory-button" onClick={() => { setQuery(""); setKind("all"); }}>{m.clearSearch}</button>}</div>}
        <div className="ad-memory-notes">{records.map(record => <button type="button" key={record.id} ref={element => { if (element) noteButtons.current.set(record.id, element); else noteButtons.current.delete(record.id); }} className="ad-memory-note" onClick={() => openRecord(record)}><BookOpenText className="ad-memory-note-symbol" size={17} /><span className="ad-memory-note-body"><span className="ad-memory-note-title"><strong>{record.title}</strong>{record.pinned && <Pin size={12} aria-label={m.pinned} />}{knownProvider(record.provider) && <ProviderIcon provider={record.provider} size={14} />}</span><span className="ad-memory-note-top"><span className="ad-memory-kind" data-kind={record.kind}>{kindLabel(record.kind)}</span><span>{origin(record)}</span></span><span className="ad-memory-note-bottom"><time>{formatDate(record.updatedAt)}</time>{record.verification !== "user-confirmed" && <span className="ad-memory-note-unverified"><Info size={11} />{record.verification === "auto-selected" ? curationCopy(locale).automatic : m.unverified}</span>}</span></span></button>)}</div>
      </>}
      {!editing && !selected && <footer className="ad-memory-footer"><div className="ad-memory-storage"><strong><Database size={13} />{m.storageTitle}</strong><p>{m.storageHint}</p>{memory.status?.storagePath && <code>{memory.status.storagePath}</code>}<div><button type="button" className="ad-memory-button" onClick={() => void storageAction(memoryCommands.openStorage)}><Folder size={13} />{m.openStorage}</button><button type="button" className="ad-memory-button" disabled={!memory.status?.storagePath} onClick={() => void storageAction(() => navigator.clipboard.writeText(memory.status!.storagePath!), m.copiedPath)}><Copy size={13} />{m.copyPath}</button></div><button type="button" className="ad-memory-button" disabled={exporting || memory.saving || !memory.status?.recordCount} title={m.exportHint} onClick={() => void exportNotes()}>{exporting ? <LoaderCircle size={13} className="ad-memory-spinning" /> : <Download size={13} />}{m.exportMarkdown}</button><p>{m.exportHint}</p>{storageError && <p role="alert" className="ad-memory-validation">{storageError}</p>}</div><details><summary><Info size={12} />{m.readMore}</summary><p>{m.retrieval}</p><p>{m.captureReview}</p></details>{activeSession && !global && <button type="button" className="ad-memory-button" title={m.recallHint} disabled={memory.saving || !memory.status?.enabled} onClick={() => void recall(activeSession.id, activeSession.runner.type)}><RotateCcw size={12} />{m.recall}</button>}</footer>}
    </>}
  </section>;
}
