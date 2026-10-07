import { useEffect, useId, useRef, useState } from "react";
import { BookOpen, BrainCircuit, FolderOpen, Search } from "lucide-react";
import { useAppI18n } from "../i18n";
import { knowledgeCommands, type KnowledgeConfig, type KnowledgeResult } from "../services/knowledgeCommands";
import { SharedMemoryPanel } from "./memory/SharedMemoryPanel";
import { memoryCopy } from "./memory/memoryCopy";
import { useSharedMemoryStore } from "../store/sharedMemoryStore";
import "./memory/sharedMemory.css";
import "./knowledge.css";
import { NoteGraph } from "./graph/KnowledgeGraph";
import { knowledgeCopy } from "./knowledgeCopy";
import { useWorkspaceStore } from "../store/workspaceStore";

export function KnowledgePanel() {
  const { locale } = useAppI18n();
  const m = memoryCopy(locale);
  const tab = useSharedMemoryStore(state => state.memoryTab);
  const setTab = useSharedMemoryStore(state => state.setMemoryTab);
  const id = useId();
  return <div className="ad-knowledge-panel"><div className="ad-knowledge-tabs" role="tablist" aria-label={m.title} onKeyDown={event => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? "memory" : event.key === "End" ? "documents" : tab === "memory" ? "documents" : "memory";
      setTab(next); document.getElementById(`${id}-${next}`)?.focus();
    }
  }}><button type="button" role="tab" id={`${id}-memory`} aria-controls={`${id}-panel`} tabIndex={tab === "memory" ? 0 : -1} aria-selected={tab === "memory"} onClick={() => setTab("memory")}><BrainCircuit size={13} />{m.title}</button><button type="button" role="tab" id={`${id}-documents`} aria-controls={`${id}-panel`} tabIndex={tab === "documents" ? 0 : -1} aria-selected={tab === "documents"} onClick={() => setTab("documents")}><BookOpen size={13} />{m.documents}</button></div><div className="ad-knowledge-content" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>{tab === "memory" ? <SharedMemoryPanel /> : <KnowledgeDocumentsPanel />}</div></div>;
}

function KnowledgeDocumentsPanel() {
  const { locale } = useAppI18n(); const copy = knowledgeCopy(locale);
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const project = workspaces.find(workspace => workspace.id === activeWorkspaceId);
  const [scope, setScope] = useState<"global" | "project">(project ? "project" : "global");
  return <div className="ad-documents-panel">
    <div className="ad-documents-scope">
      <div role="group" aria-label={copy.scope} className="ad-documents-scope-buttons">
        <button type="button" className="ad-button" aria-pressed={scope === "global"} onClick={() => setScope("global")}>{copy.global}</button>
        <button type="button" className="ad-button" aria-pressed={scope === "project"} onClick={() => setScope("project")}>{copy.project}</button>
      </div>
      {scope === "project" && <select aria-label={copy.projectLabel} value={activeWorkspaceId ?? ""} onChange={event => useWorkspaceStore.getState().setActiveWorkspace(event.target.value)}>
        {!project && <option value="">{copy.noProject}</option>}
        {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
      </select>}
      <p>{scope === "global" ? copy.globalHint : copy.projectHint}</p>
    </div>
    {scope === "global" || project ? <ScopedDocuments key={`${scope}:${scope === "project" ? project?.path : ""}`} projectPath={scope === "project" ? project?.path : undefined} /> : <p className="ad-documents-description ad-documents-scope">{copy.noProject}</p>}
  </div>;
}

function ScopedDocuments({ projectPath }: { projectPath?: string }) {
  const { t, locale } = useAppI18n(); const copy = knowledgeCopy(locale);
  const [config, setConfig] = useState<KnowledgeConfig | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeResult[]>([]);
  const [error, setError] = useState(""); const [feedback, setFeedback] = useState("");
  const [failedAction, setFailedAction] = useState<"load" | "choose" | "clear" | "search">("load");
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState<"loading" | "choosing" | "clearing" | "searching" | null>("loading");
  const mounted = useRef(false); const request = useRef(0); const active = useRef(false);
  const searchId = useId();
  const load = async () => {
    if (active.current) return;
    active.current = true; setBusy("loading"); setError("");
    try { const value = await knowledgeCommands.config(projectPath); if (mounted.current) setConfig(value); }
    catch (cause) { if (mounted.current) { setError(String(cause)); setFailedAction("load"); } }
    finally { active.current = false; if (mounted.current) setBusy(null); }
  };
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; request.current++; }; }, []);

  const changeSource = async (clear = false) => {
    if (active.current) return;
    active.current = true; setBusy(clear ? "clearing" : "choosing"); setError(""); setFeedback("");
    request.current++;
    try {
      const path = clear ? "" : await knowledgeCommands.pickFolder();
      if (path == null || (!clear && !path)) return;
      if (!mounted.current) return;
      const value = await knowledgeCommands.setSource(path, projectPath);
      if (mounted.current) { setConfig(value); setResults([]); setQuery(""); setSearched(false); setFeedback(clear ? copy.removed : copy.updated); }
    } catch (cause) { if (mounted.current) { setError(String(cause)); setFailedAction(clear ? "clear" : "choose"); } }
    finally { active.current = false; if (mounted.current) setBusy(null); }
  };
  const search = async () => {
    if (!query.trim() || !config?.sourcePath || active.current) return;
    const sequence = ++request.current;
    active.current = true; setBusy("searching"); setError(""); setFeedback(""); setSearched(false);
    try {
      const found = await knowledgeCommands.search(query.trim(), projectPath);
      if (mounted.current && sequence === request.current) { setResults(found); setSearched(true); }
    } catch (cause) { if (mounted.current && sequence === request.current) { setError(String(cause)); setFailedAction("search"); } }
    finally { active.current = false; if (mounted.current) setBusy(null); }
  };

  return <section className="ad-documents" aria-label={t("knowledge.title")} aria-busy={!!busy}>
    <div className="ad-documents-source">
      <button type="button" className="ad-button" disabled={!!busy} onClick={() => void changeSource()}><FolderOpen size={16} />{busy === "choosing" ? copy.choosing : t("knowledge.chooseFolder")}</button>
      {config && <div className="ad-documents-path">{config.sourcePath ? <><span>{t(config.mode === "obsidian" ? "knowledge.obsidian" : "knowledge.markdown")}</span><p title={config.sourcePath}>{config.sourcePath}</p><button type="button" className="ad-button ad-button-ghost" disabled={!!busy} onClick={() => void changeSource(true)}>{busy === "clearing" ? copy.clearing : t("knowledge.clear")}</button></> : <p>{t("knowledge.noSource")}</p>}</div>}
    </div>
    {config?.sourcePath && <NoteGraph key={config.sourcePath} projectPath={projectPath} />}
    <form className="ad-documents-search" onSubmit={event => { event.preventDefault(); void search(); }}>
      <label htmlFor={searchId}>{t("knowledge.search")}</label>
      <div><input id={searchId} value={query} disabled={!config?.sourcePath} onChange={event => { request.current++; setQuery(event.target.value); setResults([]); setSearched(false); }} placeholder={t("knowledge.searchPlaceholder")} />
      <button type="submit" className="ad-icon-button" aria-label={t("knowledge.search")} disabled={!config?.sourcePath || !query.trim() || !!busy}><Search size={16} /></button></div>
      {!config?.sourcePath && <p>{copy.sourceHint}</p>}
    </form>
    {busy && <span role="status" className="ad-documents-status">{busy === "choosing" ? copy.choosing : busy === "clearing" ? copy.clearing : t("knowledge.indexing")}</span>}
    {feedback && <p role="status" className="ad-documents-feedback">{feedback}</p>}
    {error && <div role="alert" className="ad-documents-error"><p>{error}</p><button type="button" className="ad-button" disabled={!!busy || (failedAction === "search" && !query.trim())} onClick={() => void (failedAction === "load" ? load() : failedAction === "search" ? search() : changeSource(failedAction === "clear"))}>{copy.retry}</button></div>}
    {searched && <div className="ad-documents-results" aria-live="polite"><h3>{copy.results} <span>{results.length}</span></h3>
      {!results.length && <p>{copy.noMatches}</p>}
      {results.map(item => <details key={item.path}><summary><strong>{item.title}</strong><span>{item.path}</span></summary><p aria-label={copy.preview}>{item.excerpt}</p></details>)}
    </div>}
    <footer><p>{t("knowledge.localOnly")}</p><p>{copy.original}</p>{config?.storagePath && <details><summary>{copy.storage}</summary><code>{config.storagePath}</code></details>}</footer>
  </section>;
}
