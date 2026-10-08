import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppI18n } from "../../i18n";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useSharedMemoryStore } from "../../store/sharedMemoryStore";
import { GLOBAL_MEMORY_KEY, type MemoryRecord } from "../../services/memoryCommands";
import { intelligenceCommands as api, type CatalogProject, type ExportPlan, type MemoryMetadata, type MemoryVersion, type ProfileCandidate, type RetrievalHit } from "../../services/memoryIntelligenceCommands";
import { intelligenceCopy } from "./intelligenceCopy";
import "./memoryIntelligence.css";
import { MemoryCurationControl, curationCopy } from "./MemoryCurationControl";
import { KnowledgeWarnings } from "./KnowledgeWarnings";
import type { KnowledgeWarning } from "../../services/knowledgeCommands";

function useAction() {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const alive = useRef(true), running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true; setBusy(true); setError("");
    try { await action(); } catch (e) { if (alive.current) setError(String(e)); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  };
  return { busy, error, run };
}
type Tab = "profile" | "catalog" | "search" | "archive" | "sync";
export function MemoryIntelligencePanel({ path }: { path: string }) {
  const { locale } = useAppI18n(); const c = intelligenceCopy(locale);
  const [open, setOpen] = useState(false), [tab, setTab] = useState<Tab>("profile");
  return <><MemoryCurationControl key={path} path={path} /><details className="ad-memory-intelligence" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>{c.title}</summary>
    {open && <><nav aria-label={c.title}>{(["profile", "catalog", "search", "archive", "sync"] as const).map(value => <button type="button" key={value} aria-pressed={value === tab} onClick={() => setTab(value)}>{c[value]}</button>)}</nav>
      {tab === "profile" && <Profile />}{tab === "catalog" && <Catalog />}
      {tab === "search" && <Search />}{tab === "archive" && <Archive path={path} />}
      {tab === "sync" && <Sync key={path} path={path} />}</>}
  </details></>;
}
function Profile() {
  const { locale } = useAppI18n(); const c = intelligenceCopy(locale);
  const [rows, setRows] = useState<ProfileCandidate[]>([]); const { busy, error, run } = useAction();
  const projects = useWorkspaceStore(s => s.workspaces);
  const [catalog, setCatalog] = useState<CatalogProject[]>([]);
  const [history,setHistory]=useState(false);const a=curationCopy(locale);
  const refresh = async () => { const [profile, projectsList] = await Promise.all([api.profile(), api.catalog(projects.map(p => ({ name: p.name, path: p.path })))]); setRows(profile); setCatalog(projectsList); };
  useEffect(() => { void run(refresh); }, []);
  const review = (id: string, accept: boolean) => run(async () => { await api.review(id, accept); await refresh(); await useSharedMemoryStore.getState().load(GLOBAL_MEMORY_KEY); });
  return <div><p>{c.profileHint}</p><button type="button" disabled={busy} onClick={() => void run(refresh)}>{c.refresh}</button>{error && <p role="alert">{error}</p>}
    <label className="ad-intelligence-check"><input type="checkbox" checked={history} onChange={e=>setHistory(e.target.checked)} />{a.history}</label>
    {!rows.filter(row=>history||row.status==="candidate").length && !busy && <p>{c.empty}</p>}{rows.filter(row=>history||row.status==="candidate").map(row => <article key={row.id}><strong>{row.statement}</strong><p>{row.status === "candidate" ? c.pending : row.status === "accepted" ? c.accepted : row.status === "forgotten" ? c.forgotten : c.rejected} · {row.projectCount} · {row.appliesTo.join(", ") || "*"}</p>
      {row.status === "candidate" && <p>{row.eligible ? c.eligible : c.single}</p>}
      {row.status === "candidate" && rows.some(other => other.topic === row.topic && other.status === "accepted" && other.recordId) && <p>{c.replaces}</p>}
      <ul>{row.evidence.map(e => <li key={`${e.projectKey}:${e.eventId}`}><b>{catalog.find(p => p.id === e.projectKey)?.name ?? e.projectKey}</b>: {e.quote}<small><time>{new Date(e.observedAt).toLocaleString(locale)}</time></small></li>)}</ul>
      {row.status === "candidate" && <div className="ad-intelligence-actions"><button type="button" disabled={busy || !row.evidence.length} onClick={() => void review(row.id, true)}>{c.approve}</button><button type="button" disabled={busy} onClick={() => void review(row.id, false)}>{c.reject}</button></div>}
    </article>)}</div>;
}
function Catalog() {
  const { locale } = useAppI18n(); const c = intelligenceCopy(locale);
  const projects = useWorkspaceStore(s => s.workspaces);
  const [rows, setRows] = useState<CatalogProject[]>([]), [query, setQuery] = useState("");
  const { busy, error, run } = useAction();
  const refresh = async () => setRows(await api.catalog(projects.map(p => ({ name: p.name, path: p.path }))));
  useEffect(() => { void run(refresh); }, []);
  return <div><p>{c.catalogHint}</p><input aria-label={c.query} type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={c.query} /><button type="button" disabled={busy} onClick={() => void run(refresh)}>{c.refresh}</button>{error && <p role="alert">{error}</p>}
    {rows.filter(row => `${row.name} ${row.description} ${row.stack.join(" ")}`.toLowerCase().includes(query.toLowerCase())).map(row => <ProjectCard key={row.id} project={row} onChange={refresh} />)}
  </div>;
}
function ProjectCard({ project, onChange }: { project: CatalogProject; onChange: () => Promise<void> }) {
  const { locale } = useAppI18n(); const c = intelligenceCopy(locale);
  const [draft, setDraft] = useState(project); const { busy, error, run } = useAction();
  useEffect(() => setDraft(project), [project]);
  const associate = () => run(async () => { const path = await invoke<string | null>("pick_folder"); if (!path) return; await api.attachProject(project.id, path); await onChange(); });
  return <article><strong>{project.name}</strong><code>{project.id}</code><p>{project.stack.join(" · ")} · {project.recordCount}</p>{project.repositoryIdentity && <code>{project.repositoryIdentity}</code>}
    {project.paths.map(path => <code key={path}>{path}</code>)}
    <label>{c.name}<input value={draft.name} maxLength={120} disabled={busy} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
    <label>{c.description}<textarea value={draft.description} maxLength={2000} disabled={busy} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
    {(["contribute", "consume", "discovery", "visible"] as const).map(key => <label className="ad-intelligence-check" key={key}><input type="checkbox" checked={draft.settings[key]} disabled={busy} onChange={e => setDraft({ ...draft, settings: { ...draft.settings, [key]: e.target.checked } })} />{c[key]}</label>)}
    <div className="ad-intelligence-actions"><button type="button" disabled={busy || !draft.name.trim()} onClick={() => void run(async () => { await api.updateProject(draft); await onChange(); })}>{c.save}</button><button type="button" disabled={busy} onClick={() => void associate()}>{c.associate}</button></div>{error && <p role="alert">{error}</p>}
  </article>;
}
function Search() {
  const { locale } = useAppI18n(); const c = intelligenceCopy(locale);
  const projects = useWorkspaceStore(s => s.workspaces), active = useWorkspaceStore(s => s.activeWorkspaceId);
  const path = projects.find(p => p.id === active)?.path;
  const [query, setQuery] = useState(""), [rows, setRows] = useState<RetrievalHit[]>([]);
  const [warnings, setWarnings] = useState<KnowledgeWarning[]>([]);
  const sequence = useRef(0);
  useEffect(() => { sequence.current++; setRows([]); setWarnings([]); }, [path]);
  const { busy, error, run } = useAction();
  return <div><p>{c.searchHint}</p><form onSubmit={e => { e.preventDefault(); if (path) void run(async () => { const request = ++sequence.current; setRows([]); setWarnings([]); const result = await api.search(path, query); if (request === sequence.current) { setRows(result.hits); setWarnings(result.warnings); } }); }}><input type="search" aria-label={c.query} placeholder={c.query} value={query} maxLength={2000} onChange={e => { sequence.current++; setQuery(e.target.value); setRows([]); setWarnings([]); }} /><button type="submit" disabled={busy || !path || !query.trim()}>{c.search}</button></form>
    {error && <p role="alert">{error}</p>}<KnowledgeWarnings warnings={warnings} />{rows.map(row => <article key={row.id}><strong>{row.title}</strong><p>{row.source} · {row.scope} · {row.score.toFixed(5)}</p><code>{row.path ?? row.id}</code><p>{row.reason}</p><pre>{row.excerpt.slice(0, 1600)}</pre></article>)}
  </div>;
}
function Archive({ path }: { path: string }) {
  const { locale } = useAppI18n(); const c = intelligenceCopy(locale);
  const [rows, setRows] = useState<MemoryRecord[]>([]), [preview, setPreview] = useState<MemoryRecord[] | null>(null);
  const { busy, error, run } = useAction();
  const refresh = async () => setRows(await api.inactive(path));
  useEffect(() => { void run(refresh); }, [path]);
  const restore = (id: string) => run(async () => { const metadata = await api.metadata(path, id); await api.setMetadata(path, id, { ...metadata, state: "active", supersededBy: null }); await refresh(); await useSharedMemoryStore.getState().load(path); });
  return <div><p>{c.maintenanceHint}</p><div className="ad-intelligence-actions"><button type="button" disabled={busy} onClick={() => void run(refresh)}>{c.refresh}</button><button type="button" disabled={busy} onClick={() => void run(async () => setPreview(await api.maintain(path, false)))}>{c.maintain}</button></div>
    {preview && <article><strong>{c.maintain}: {preview.length}</strong><ul>{preview.map(note => <li key={note.id}>{note.title}</li>)}</ul><button type="button" disabled={busy || !preview.length} onClick={() => void run(async () => { await api.maintain(path, true); setPreview(null); await refresh(); await useSharedMemoryStore.getState().load(path); })}>{c.applyMaintenance}</button></article>}
    {error && <p role="alert">{error}</p>}{!rows.length && !busy && <p>{c.empty}</p>}{rows.map(note => <article key={note.id}><strong>{note.title}</strong><pre>{note.content}</pre><button type="button" disabled={busy} onClick={() => void restore(note.id)}>{c.restore}</button><MemoryNoteHistory path={path} note={note} onChanged={refresh} /></article>)}
  </div>;
}
function Sync({ path }: { path: string }) {
  const { locale } = useAppI18n(); const c = intelligenceCopy(locale);
  const [preview, setPreview] = useState<{ destination: string; plan: ExportPlan } | null>(null);
  const plan = preview?.plan;
  const { busy, error, run } = useAction();
  return <div><p>{c.syncHint}</p><button type="button" disabled={busy} onClick={() => void run(async () => { setPreview(null); const folder = await invoke<string | null>("pick_folder"); if (!folder) return; const plan = await api.export(path, folder, false); setPreview({ destination: folder, plan }); })}>{c.preview}</button>
    {error && <p role="alert">{error}</p>}{plan && <article><code>{plan.directory}</code><p>{plan.recordCount}</p>{plan.conflicts.length > 0 && <p role="alert">{c.conflicts}</p>}
      <ul>{plan.changes.map(change => <li key={change.path}><b>{change.action}</b>: {change.path}</li>)}</ul>
      {plan.applied ? <p role="status">{c.exported}</p> : <button type="button" disabled={busy || !!plan.conflicts.length} onClick={() => void run(async () => { if (!preview) return; const plan = await api.export(path, preview.destination, true); setPreview({ ...preview, plan }); })}>{c.applyExport}</button>}
    </article>}
  </div>;
}
export function MemoryNoteHistory({ path, note, onChanged }: { path: string; note: MemoryRecord; onChanged: () => Promise<void> }) {
  const { locale } = useAppI18n(); const c = intelligenceCopy(locale);
  const [open, setOpen] = useState(false), [metadata, setMetadata] = useState<MemoryMetadata | null>(null), [versions, setVersions] = useState<MemoryVersion[]>([]);
  const [tags, setTags] = useState(""); const { busy, error, run } = useAction();
  const refresh = async () => { const [meta, history] = await Promise.all([api.metadata(path, note.id), api.versions(path, note.id)]); setMetadata(meta); setTags(meta.appliesTo.join(", ")); setVersions(history); };
  useEffect(() => { if (open) void run(refresh); }, [open, note.id, note.revision]);
  const split = (value: string) => [...new Set(value.split(",").map(s => s.trim()).filter(Boolean))];
  return <details className="ad-memory-intelligence" onToggle={e => setOpen(e.currentTarget.open)}><summary>{c.history}</summary>{open && <>
    {error && <p role="alert">{error}</p>}{metadata && <><label>{c.category}<select value={metadata.category} disabled={busy} onChange={e => setMetadata({ ...metadata, category: e.target.value })}><option value="">—</option>{(["preference", "procedure", "gotcha", "lesson"] as const).map(key => <option key={key} value={key}>{c[key]}</option>)}</select></label>
      <label>{c.tags}<input value={tags} maxLength={640} disabled={busy} onChange={e => setTags(e.target.value)} /></label>
      <label>{c.feedback}<select value={metadata.feedback} disabled={busy} onChange={e => setMetadata({ ...metadata, feedback: e.target.value })}><option value="">—</option><option value="helpful">{c.helpful}</option><option value="not-helpful">{c.notHelpful}</option><option value="wrong">{c.wrong}</option></select></label>
      <label>{c.state}<select value={metadata.state} disabled={busy} onChange={e => setMetadata({ ...metadata, state: e.target.value })}>{(["active", "archived", "stale", "superseded"] as const).map(key => <option key={key} value={key}>{c[key]}</option>)}</select></label>
      {metadata.state === "superseded" && <label>{c.replacement}<input value={metadata.supersededBy ?? ""} disabled={busy} onChange={e => setMetadata({ ...metadata, supersededBy: e.target.value || null })} /></label>}
      <p>{c.relations}</p>{["fixes", "causes", "contradicts"].map(kind => <label key={kind}>{kind}<input value={(metadata.relations[kind] ?? []).join(", ")} disabled={busy} onChange={e => setMetadata({ ...metadata, relations: { ...metadata.relations, [kind]: split(e.target.value) } })} /></label>)}
      <p>{c.usage}: {metadata.accessCount}</p><button type="button" disabled={busy} onClick={() => void run(async () => { await api.setMetadata(path, note.id, { ...metadata, appliesTo: split(tags), supersededBy: metadata.state === "superseded" ? metadata.supersededBy : null }); await refresh(); await onChanged(); })}>{c.save}</button>
    </>}
    <p>{c.versions}</p>{versions.map(version => <article key={version.record.revision}><b>r{version.record.revision}</b> · <time>{new Date(version.recordedAt).toLocaleString(locale)}</time><pre>{version.record.content}</pre><button type="button" disabled={busy || version.record.content === note.content} onClick={() => void run(async () => { await api.restoreVersion(path, note.id, version.record.revision); await refresh(); await onChanged(); })}>{c.restore}</button></article>)}
  </>}</details>;
}
