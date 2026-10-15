import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, BookOpen, BrainCircuit, Search, X } from "lucide-react";
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
import { SortableCollection } from "./ordering/SortableCollection";
import { KnowledgeHealth } from "./memory/KnowledgeHealth";

export function KnowledgePanel() {
  const { t, locale } = useAppI18n(); const m = memoryCopy(locale);
  const tab = useSharedMemoryStore(state => state.memoryTab), setTab = useSharedMemoryStore(state => state.setMemoryTab);
  const id = useId();
  return <div className="ad-knowledge-panel"><div className="ad-knowledge-tabs" role="tablist" aria-label={t("knowledge.title")} onKeyDown={event => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault(); const next = event.key === "Home" ? "documents" : event.key === "End" ? "memory" : tab === "memory" ? "documents" : "memory";
      setTab(next); document.getElementById(`${id}-${next}`)?.focus();
    }
  }}><button type="button" role="tab" id={`${id}-documents`} aria-controls={`${id}-panel`} tabIndex={tab === "documents" ? 0 : -1} aria-selected={tab === "documents"} onClick={() => setTab("documents")}><BookOpen size={13} />{m.documents}</button><button type="button" role="tab" id={`${id}-memory`} aria-controls={`${id}-panel`} tabIndex={tab === "memory" ? 0 : -1} aria-selected={tab === "memory"} onClick={() => setTab("memory")}><BrainCircuit size={13} />{m.title}</button></div><div className="ad-knowledge-content" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>{tab === "memory" ? <SharedMemoryPanel /> : <KnowledgeDocumentsPanel />}</div></div>;
}

function KnowledgeDocumentsPanel() {
  const { locale } = useAppI18n(); const copy = knowledgeCopy(locale);
  const workspaces = useWorkspaceStore(state => state.workspaces), activeWorkspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const session = useSessionStore(state => state.sessions.find(item => item.id === state.activeSessionId));
  // The open conversation owns its policy, even when sidebar focus is elsewhere.
  const project = workspaces.find(workspace => workspace.id === (session?.workspaceId ?? activeWorkspaceId));
  const [scope, setScope] = useState<"global" | "project">(project ? "project" : "global");
  return <div className="ad-memory-panel ad-documents-panel"><header className="ad-memory-heading ad-documents-heading"><h2>{scope === "global" ? copy.catalogTitle : session ? copy.conversationTitle : copy.sourcesTitle}</h2>{scope === "project" && session && <p className="ad-documents-context">{copy.conversation}<strong title={session.name}>{session.name}</strong></p>}</header><KnowledgeScopeControls scope={scope} onChange={setScope} labels={copy} projectId={project?.id} locked={!!session} projectFirst />
    {scope === "global" || project ? <ScopedDocuments key={`${scope}:${project?.path}:${session?.id}`} projectPath={scope === "project" ? project?.path : undefined} sessionId={scope === "project" ? session?.id : undefined} /> : <p>{copy.noProject}</p>}
  </div>;
}
function displayPath(path: string) { try { return path.startsWith("doc:") ? (JSON.parse(path.slice(4)) as string[])[1] : path; } catch { return path; } }
function ScopedDocuments({ projectPath, sessionId }: { projectPath?: string; sessionId?: string }) {
  const { t, locale } = useAppI18n(); const copy = knowledgeCopy(locale);
  const [sourceId, setSourceId] = useState<string>(); const [sourceName, setSourceName] = useState(""); const [query, setQuery] = useState("");
  const [exploring, setExploring] = useState(false), [diagnostics, setDiagnostics] = useState(false);
  const [results, setResults] = useState<KnowledgeResult[]>([]); const [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [searched, setSearched] = useState(false), [revision, setRevision] = useState(0);
  const request = useRef(0), mounted = useRef(true); const searchId = useId();
  useEffect(() => {
    mounted.current = true;
    const changed = () => { request.current++; setResults([]); setSearched(false); setSourceId(undefined); setSourceName(""); setRevision(value => value + 1); };
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
    <SourcePolicyControls presentation="knowledge" projectPath={projectPath} sessionId={sessionId} catalog={!projectPath} onInspect={(id, name) => { request.current++; setSourceId(id); setSourceName(name ?? ""); setResults([]); setSearched(false); }} />
    {projectPath && sessionId && <details className="ad-knowledge-disclosure ad-project-source-defaults"><summary>{copy.projectDefaults}</summary><SourcePolicyControls presentation="knowledge" projectPath={projectPath} /></details>}
    {sourceId && <div className="ad-documents-inspector" role="status"><div><span>{copy.inspecting}</span><strong>{sourceName}</strong></div><button type="button" className="ad-memory-icon" aria-label={copy.closeInspector} onClick={() => { request.current++; setSourceId(undefined); setSourceName(""); setResults([]); setSearched(false); }}><X size={15} /></button><p>{copy.inspectorHint}</p></div>}
    <form className="ad-documents-search" onSubmit={event => { event.preventDefault(); void search(); }}><label htmlFor={searchId}>{t("knowledge.search")}</label><div className="ad-memory-search"><Search size={16} /><input id={searchId} value={query} disabled={!projectPath && !sourceId} onChange={event => { request.current++; setQuery(event.target.value); setResults([]); setSearched(false); }} placeholder={t("knowledge.searchPlaceholder")} /><button type="submit" className="ad-memory-icon" aria-label={t("knowledge.search")} disabled={(!projectPath && !sourceId) || !query.trim() || busy}><ArrowRight size={16} /></button></div></form>
    {busy && <span role="status">{t("knowledge.indexing")}</span>}{error && <div role="alert"><p>{error}</p><button type="button" className="ad-button" disabled={busy || !query.trim()} onClick={() => void search()}>{copy.retry}</button></div>}
    {searched && <div className="ad-documents-results"><h3>{copy.results} <span>{results.length}</span></h3>{!results.length && <p>{copy.noMatches}</p>}<SortableCollection surface="knowledge-notes" context={`${projectPath ?? "catalog"}:${sessionId ?? "project"}:${sourceId ?? "selected"}`} items={results} getId={item => item.path} getLabel={item => item.title} render={(item, handle) => <div>{handle}<details><summary data-drag-primary="true"><strong>{item.title}</strong><span>{displayPath(item.path)}</span></summary><p aria-label={copy.preview}>{item.excerpt}</p></details></div>} /></div>}
    {(projectPath || sourceId) && <details className="ad-knowledge-disclosure ad-documents-explore" open={exploring} onToggle={event => setExploring(event.currentTarget.open)}><summary>{copy.explore}</summary>{exploring && <NoteGraph key={`${projectPath}:${sessionId}:${sourceId}:${revision}`} projectPath={projectPath} sessionId={sessionId} sourceId={sourceId} />}</details>}
    <details className="ad-knowledge-disclosure ad-documents-diagnostics" open={diagnostics} onToggle={event => setDiagnostics(event.currentTarget.open)}><summary>{copy.diagnostics}</summary>{diagnostics && (projectPath || sourceId) && <KnowledgeHealth key={`health:${projectPath}:${sessionId}:${sourceId}:${revision}`} projectPath={projectPath} sessionId={sessionId} sourceId={sourceId} />}<footer><p>{t("knowledge.localOnly")}</p><p>{copy.original}</p></footer></details>
  </section>;
}
