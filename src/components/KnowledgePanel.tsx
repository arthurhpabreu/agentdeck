import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, BookOpen, BrainCircuit, Search } from "lucide-react";
import { useAppI18n } from "../i18n";
import { knowledgeCommands, type KnowledgeResult } from "../services/knowledgeCommands";
import { SharedMemoryPanel } from "./memory/SharedMemoryPanel";
import { memoryCopy } from "./memory/memoryCopy";
import { useSharedMemoryStore } from "../store/sharedMemoryStore";
import "./memory/sharedMemory.css";
import "./knowledge.css";
import { NoteGraph } from "./graph/KnowledgeGraph";
import { knowledgeCopy } from "./knowledgeCopy";
import { useWorkspaceStore } from "../store/workspaceStore";
import { useSessionStore } from "../store/sessionStore";
import { KnowledgeScopeControls } from "./memory/KnowledgeScopeControls";
import { SourcePolicyControls } from "./memory/SourcePolicyControls";
import { sourcePolicyCopy } from "./memory/sourcePolicyCopy";
import { SortableCollection } from "./ordering/SortableCollection";
import { KnowledgeHealth } from "./memory/KnowledgeHealth";

export function KnowledgePanel() {
  const { locale } = useAppI18n(); const m = memoryCopy(locale);
  const tab = useSharedMemoryStore(state => state.memoryTab), setTab = useSharedMemoryStore(state => state.setMemoryTab);
  const id = useId();
  return <div className="ad-knowledge-panel"><div className="ad-knowledge-tabs" role="tablist" aria-label={m.title} onKeyDown={event => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault(); const next = event.key === "Home" ? "memory" : event.key === "End" ? "documents" : tab === "memory" ? "documents" : "memory";
      setTab(next); document.getElementById(`${id}-${next}`)?.focus();
    }
  }}><button type="button" role="tab" id={`${id}-memory`} aria-controls={`${id}-panel`} tabIndex={tab === "memory" ? 0 : -1} aria-selected={tab === "memory"} onClick={() => setTab("memory")}><BrainCircuit size={13} />{m.title}</button><button type="button" role="tab" id={`${id}-documents`} aria-controls={`${id}-panel`} tabIndex={tab === "documents" ? 0 : -1} aria-selected={tab === "documents"} onClick={() => setTab("documents")}><BookOpen size={13} />{m.documents}</button></div><div className="ad-knowledge-content" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>{tab === "memory" ? <SharedMemoryPanel /> : <KnowledgeDocumentsPanel />}</div></div>;
}

function KnowledgeDocumentsPanel() {
  const { locale } = useAppI18n(); const copy = knowledgeCopy(locale), m = memoryCopy(locale);
  const workspaces = useWorkspaceStore(state => state.workspaces), activeWorkspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const session = useSessionStore(state => state.sessions.find(item => item.id === state.activeSessionId));
  // The open conversation owns its policy, even when sidebar focus is elsewhere.
  const project = workspaces.find(workspace => workspace.id === (session?.workspaceId ?? activeWorkspaceId));
  const [scope, setScope] = useState<"global" | "project">(project ? "project" : "global");
  return <div className="ad-memory-panel ad-documents-panel"><header className="ad-memory-heading"><h2>{m.documents}</h2><p>{copy.intro}</p></header><KnowledgeScopeControls scope={scope} onChange={setScope} labels={{ ...copy, project: m.projectScope }} projectId={project?.id} locked={!!session} />
    {scope === "global" || project ? <ScopedDocuments key={`${scope}:${project?.path}:${session?.id}`} projectPath={scope === "project" ? project?.path : undefined} sessionId={scope === "project" ? session?.id : undefined} /> : <p>{copy.noProject}</p>}
  </div>;
}
function displayPath(path: string) { try { return path.startsWith("doc:") ? (JSON.parse(path.slice(4)) as string[])[1] : path; } catch { return path; } }
function ScopedDocuments({ projectPath, sessionId }: { projectPath?: string; sessionId?: string }) {
  const { t, locale } = useAppI18n(); const copy = knowledgeCopy(locale), c = sourcePolicyCopy(locale);
  const [sourceId, setSourceId] = useState<string>(); const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeResult[]>([]); const [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [searched, setSearched] = useState(false), [revision, setRevision] = useState(0);
  const request = useRef(0), mounted = useRef(true); const searchId = useId();
  useEffect(() => {
    mounted.current = true;
    const changed = () => { request.current++; setResults([]); setSearched(false); setRevision(value => value + 1); };
    window.addEventListener("agentdeck-source-policy-changed", changed);
    return () => { mounted.current = false; request.current++; window.removeEventListener("agentdeck-source-policy-changed", changed); };
  }, []);
  const search = async () => {
    if (!query.trim() || busy) return;
    const sequence = ++request.current; setBusy(true); setError(""); setSearched(false);
    try { const found = await knowledgeCommands.search(query.trim(), projectPath, sessionId, sourceId); if (mounted.current && sequence === request.current) { setResults(found); setSearched(true); } }
    catch (cause) { if (mounted.current && sequence === request.current) setError(String(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <section className="ad-documents" aria-label={t("knowledge.title")}>
    <SourcePolicyControls projectPath={projectPath} sessionId={sessionId} catalog={!projectPath} onInspect={id => { request.current++; setSourceId(id); setResults([]); setSearched(false); }} />
    {projectPath && sessionId && <details><summary>{c.inherit}</summary><SourcePolicyControls projectPath={projectPath} /></details>}
    {(projectPath || sourceId) && <><KnowledgeHealth key={`health:${projectPath}:${sessionId}:${sourceId}:${revision}`} projectPath={projectPath} sessionId={sessionId} sourceId={sourceId} /><NoteGraph key={`${projectPath}:${sessionId}:${sourceId}:${revision}`} projectPath={projectPath} sessionId={sessionId} sourceId={sourceId} /></>}
    <form className="ad-documents-search" onSubmit={event => { event.preventDefault(); void search(); }}><label htmlFor={searchId}>{t("knowledge.search")}</label><div className="ad-memory-search"><Search size={16} /><input id={searchId} value={query} disabled={!projectPath && !sourceId} onChange={event => { request.current++; setQuery(event.target.value); setResults([]); setSearched(false); }} placeholder={t("knowledge.searchPlaceholder")} /><button type="submit" className="ad-memory-icon" aria-label={t("knowledge.search")} disabled={(!projectPath && !sourceId) || !query.trim() || busy}><ArrowRight size={16} /></button></div></form>
    {busy && <span role="status">{t("knowledge.indexing")}</span>}{error && <div role="alert"><p>{error}</p><button type="button" className="ad-button" disabled={busy || !query.trim()} onClick={() => void search()}>{copy.retry}</button></div>}
    {searched && <div className="ad-documents-results"><h3>{copy.results} <span>{results.length}</span></h3>{!results.length && <p>{copy.noMatches}</p>}<SortableCollection surface="knowledge-notes" context={`${projectPath ?? "catalog"}:${sessionId ?? "project"}:${sourceId ?? "selected"}`} items={results} getId={item => item.path} getLabel={item => item.title} render={(item, handle) => <div>{handle}<details><summary><strong>{item.title}</strong><span>{displayPath(item.path)}</span></summary><p aria-label={copy.preview}>{item.excerpt}</p></details></div>} /></div>}
    <footer><p>{t("knowledge.localOnly")}</p><p>{copy.original}</p></footer>
  </section>;
}
