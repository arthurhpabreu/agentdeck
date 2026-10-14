import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Expand, Folder, Network, RefreshCw, Search, X } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { knowledgeCommands, type KnowledgeGraph as Graph, type KnowledgeResult } from "../../services/knowledgeCommands";
import { knowledgeCopy } from "../knowledgeCopy";
import { graphCopy } from "./graphCopy";
import { GraphViewport } from "./GraphViewport";
import { layoutNotes, noteFolder, noteNeighborhood, notePathLabel } from "./knowledgeLayout";
import { SortableCollection } from "../ordering/SortableCollection";
import { usePresentationOrder } from "../../store/presentationStore";
import "./knowledgeGraph.css";

export function NoteGraph({ projectPath, sessionId, sourceId }: { projectPath?: string; sessionId?: string; sourceId?: string }) {
  const { locale } = useAppI18n(); const copy = knowledgeCopy(locale); const g = graphCopy(locale);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<KnowledgeResult | null>(null);
  const [loading, setLoading] = useState(true); const [reading, setReading] = useState(false);
  const [error, setError] = useState(""); const [readError, setReadError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<"folders" | "notes" | "connections">("folders");
  const [query, setQuery] = useState(""); const [folder, setFolder] = useState("*");
  const [noteListOpen, setNoteListOpen] = useState(false), [noteOffset, setNoteOffset] = useState(0);
  const [depth, setDepth] = useState(1); const [budget, setBudget] = useState(350); const [labels, setLabels] = useState(false);
  const mounted = useRef(false); const request = useRef(0); const graphRequest = useRef(0);
  const modal = useRef<HTMLDialogElement>(null); const expandButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const selectId = useId();
  const refresh = async (force = false) => {
    const sequence = ++graphRequest.current; setLoading(true); setError("");
    try {
      const value = await knowledgeCommands.graph(projectPath, force, sessionId, sourceId);
      if (mounted.current && sequence === graphRequest.current) {
        setGraph(value); setSelected(""); setPreview(null); setReadError(""); request.current++;
      }
    } catch (cause) { if (mounted.current && sequence === graphRequest.current) setError(String(cause)); }
    finally { if (mounted.current && sequence === graphRequest.current) { setLoading(false); setReading(false); } }
  };
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; request.current++; graphRequest.current++; }; }, []);
  useEffect(() => {
    if (!expanded) { if (restoreFocus.current) { expandButton.current?.focus(); restoreFocus.current = false; } return; }
    restoreFocus.current = true;
    modal.current?.showModal();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector('[data-dragging="true"]')) { event.preventDefault(); event.stopImmediatePropagation(); setExpanded(false); }
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [expanded]);
  const select = async (path: string) => {
    const sequence = ++request.current; setSelected(path); setPreview(null); setReadError("");
    if (!path) { setReading(false); return; }
    setReading(true);
    try {
      const note = await knowledgeCommands.read(path, projectPath, sessionId, sourceId);
      if (mounted.current && sequence === request.current) setPreview(note);
    } catch (cause) { if (mounted.current && sequence === request.current) setReadError(String(cause)); }
    finally { if (mounted.current && sequence === request.current) setReading(false); }
  };
  const neighborhood = useMemo(() => graph ? noteNeighborhood(graph, selected, depth) : new Set<string>(), [graph, selected, depth]);
  const connections = useMemo(() => graph ? noteNeighborhood(graph, selected, 1) : new Set<string>(), [graph, selected]);
  connections.delete(selected);
  const folders = useMemo(() => [...new Set(graph?.nodes.map(node => noteFolder(node.path)) ?? [])].sort(), [graph]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return (graph?.nodes ?? []).filter(node => (!expanded || folder === "*" || noteFolder(node.path) === folder)
      && (!expanded || !normalized || `${node.title} ${node.path}`.toLocaleLowerCase().includes(normalized))
      && (!expanded || mode !== "connections" || neighborhood.has(node.path)));
  }, [graph, expanded, folder, query, mode, neighborhood]);
  const shown = useMemo(() => {
    const limit = expanded ? budget : 120;
    const ranked = filtered.slice().sort((a, b) => Number(b.path === selected) - Number(a.path === selected) || b.links - a.links || a.path.localeCompare(b.path));
    return ranked.slice(0, limit);
  }, [filtered, selected, expanded, budget]);
  const overview = expanded && mode === "folders" && !query.trim();
  const layout = useMemo(() => layoutNotes(overview ? filtered : shown, overview), [filtered, shown, overview]);
  const positions = new Map(layout.nodes.map(node => [node.path, node]));
  const byPath = new Map(graph?.nodes.map(node => [node.path, node]));
  const orderContext = JSON.stringify([projectPath ?? "catalog", sessionId ?? "project", sourceId ?? "selected"]);
  const orderedNotes = usePresentationOrder("knowledge-note-list", orderContext, graph?.nodes ?? [], node => node.path);
  const includedNotes = new Set(filtered.map(node => node.path));
  const orderedVisibleNotes = orderedNotes.filter(node => includedNotes.has(node.path));
  const noteStart = Math.min(noteOffset, Math.max(0, orderedVisibleNotes.length - 1));
  const folderEdges = useMemo(() => {
    const included = new Set(filtered.map(node => node.path)); const edges = new Map<string, { source: string; target: string; weight: number }>();
    for (const edge of graph?.edges ?? []) {
      if (!included.has(edge.source) || !included.has(edge.target)) continue;
      const pair = [noteFolder(edge.source), noteFolder(edge.target)].sort();
      if (pair[0] === pair[1]) continue;
      const key = JSON.stringify(pair); const value = edges.get(key) ?? { source: pair[0], target: pair[1], weight: 0 };
      value.weight++; edges.set(key, value);
    }
    return [...edges.values()];
  }, [graph, filtered]);
  const inspector = <div className="ad-knowledge-inspector">
    <label htmlFor={selectId}>{copy.chooseNote}</label>
    <select id={selectId} value={selected} disabled={loading} onChange={event => void select(event.target.value)}><option value="">{copy.chooseNote}</option>{orderedNotes.map(node => <option key={node.path} value={node.path}>{node.title} · {notePathLabel(node.path)}</option>)}</select>
    <details onToggle={event => setNoteListOpen(event.currentTarget.open)}><summary>{g.notes}</summary>{noteListOpen && <><SortableCollection surface="knowledge-note-list" context={orderContext} items={orderedVisibleNotes.slice(noteStart,noteStart+80)} allIds={orderedNotes.map(node => node.path)} getId={node => node.path} getLabel={node => node.title} render={(node, handle) => <div>{handle}<button type="button" className="ad-button" onClick={() => void select(node.path)}>{node.title}</button></div>} />{orderedVisibleNotes.length>80&&<div><button type="button" className="ad-button" disabled={noteStart===0} aria-label={`${g.notes}: ${Math.max(1,noteStart-79)}–${noteStart}`} onClick={()=>setNoteOffset(Math.max(0,noteStart-80))}>←</button><span>{noteStart+1}–{Math.min(noteStart+80,orderedVisibleNotes.length)} / {orderedVisibleNotes.length}</span><button type="button" className="ad-button" disabled={noteStart+80>=orderedVisibleNotes.length} aria-label={`${g.notes}: ${noteStart+81}–${Math.min(noteStart+160,orderedVisibleNotes.length)}`} onClick={()=>setNoteOffset(noteStart+80)}>→</button></div>}</>}</details>
    {expanded && selected && <button type="button" className="ad-button" onClick={() => { setQuery(""); setFolder("*"); setMode("connections"); }}>{g.neighborhood}</button>}
    {reading && <p role="status">{copy.preview}…</p>}
    {readError && <div role="alert" className="ad-documents-error"><p>{readError}</p><button type="button" className="ad-button" disabled={reading} onClick={() => void select(selected)}>{copy.retry}</button></div>}
    {preview && <article className="ad-note-preview"><h4>{preview.title}</h4><code>{notePathLabel(preview.path)}</code><p aria-label={copy.preview}>{preview.excerpt}</p>
      <h4>{copy.connections} · {connections.size}</h4>{connections.size ? <SortableCollection surface="knowledge-note-connections" context={`${orderContext}:${selected}`} items={[...connections]} getId={path => path} getLabel={path => byPath.get(path)?.title ?? notePathLabel(path)} render={(path, handle) => <div>{handle}<button type="button" className="ad-button ad-button-ghost" onClick={() => void select(path)}>{byPath.get(path)?.title ?? notePathLabel(path)}</button></div>} /> : <p>{copy.noConnections}</p>}
    </article>}
  </div>;
  const canvas = <div className="ad-knowledge-visual">
    {expanded && <div className="ad-knowledge-graph-controls">
      <div className="ad-graph-segments" role="group" aria-label={copy.graph}>{(["folders", "notes", "connections"] as const).map(view => <button type="button" key={view} aria-pressed={mode === view} onClick={() => setMode(view)}>{view === "folders" ? g.overview : view === "notes" ? g.notes : g.neighborhood}</button>)}</div>
      <label className="ad-knowledge-graph-search"><Search size={15} /><input type="search" aria-label={g.search} placeholder={g.search} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <select aria-label={g.folder} value={folder} onChange={event => { setFolder(event.target.value); setMode("notes"); }}><option value="*">{g.allFolders}</option>{folders.map(name => <option key={name} value={name}>{name || g.rootFolder}</option>)}</select>
      {mode === "connections" && <select aria-label={g.depth} value={depth} onChange={event => setDepth(Number(event.target.value))}>{[1, 2, 3].map(value => <option key={value} value={value}>{value} {g.depth}</option>)}</select>}
      {!overview && <><select aria-label={g.budget} value={budget} onChange={event => setBudget(Number(event.target.value))}>{[150, 350, 700].map(value => <option key={value} value={value}>{value} {g.notes}</option>)}</select><label className="ad-graph-checkbox"><input type="checkbox" checked={labels} onChange={event => setLabels(event.target.checked)} />{g.labels}</label></>}
    </div>}
    <GraphViewport width={layout.width} height={layout.height} label={copy.graph} controls={g} resetKey={`${expanded}:${mode}:${query}:${folder}:${depth}:${mode === "connections" ? selected : ""}`}>
      <svg width={layout.width} height={layout.height} className="ad-note-graph-canvas" role="group" aria-label={copy.graph}>
        {overview ? <>
          {folderEdges.map(edge => {
            const from = layout.folders.find(item => item.name === edge.source), to = layout.folders.find(item => item.name === edge.target);
            return from && to ? <line key={`${edge.source}:${edge.target}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} style={{ strokeWidth: Math.min(8, 1 + Math.log2(edge.weight + 1)) }}><title>{edge.weight} {copy.links}</title></line> : null;
          })}
          {layout.folders.map(group => <g key={group.name} transform={`translate(${group.x},${group.y})`} className="ad-knowledge-folder" data-color={group.color} role="button" tabIndex={0} aria-label={`${group.name || g.rootFolder} · ${group.count} ${copy.notes}`} onClick={() => { setFolder(group.name); setMode("notes"); }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setFolder(group.name); setMode("notes"); } }}>
            <circle r={Math.min(85, 42 + Math.sqrt(group.count))} /><text y={-3} textAnchor="middle">{group.name.length > 30 ? `…${group.name.slice(-29)}` : group.name || g.rootFolder}</text><text y={21} textAnchor="middle" className="ad-folder-count">{group.count} {copy.notes}</text><title>{group.name || g.rootFolder}</title>
          </g>)}
        </> : <>
          {layout.folders.length > 1 && layout.folders.map(group => <g key={group.name} className="ad-knowledge-cluster" data-color={group.color}><circle cx={group.x} cy={group.y} r={group.radius} /><text x={group.x} y={group.y - group.radius - 12} textAnchor="middle">{group.name || g.rootFolder}</text></g>)}
          {graph?.edges.map(edge => {
            const from = positions.get(edge.source), to = positions.get(edge.target);
            const connected = edge.source === selected || edge.target === selected;
            return from && to ? <line key={`${edge.source}:${edge.target}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={`${connected ? "is-connected" : ""}${selected && !connected ? " is-dimmed" : ""}`} /> : null;
          })}
          {layout.nodes.map(node => <g key={node.path} transform={`translate(${node.x},${node.y})`} role="button" tabIndex={loading ? -1 : 0} aria-label={`${node.title} · ${node.links} ${copy.links}`} aria-pressed={selected === node.path} data-color={node.color} className={`ad-note-graph-node${selected === node.path ? " is-selected" : ""}${connections.has(node.path) ? " is-connected" : ""}${selected && selected !== node.path && !connections.has(node.path) ? " is-dimmed" : ""}`} onClick={() => { if (!loading) void select(node.path); }} onKeyDown={event => { if (!loading && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); void select(node.path); } }}>
            <title>{node.title} — {node.path}</title><circle r={Math.min(9, 4 + Math.sqrt(node.links) * .45)} /><circle className="ad-node-hit" r={14} />
            {(layout.nodes.length <= 18 || selected === node.path || (expanded && labels)) && <text y={-15} textAnchor="middle">{node.title.length > 28 ? `${node.title.slice(0, 27)}…` : node.title}</text>}
          </g>)}
        </>}
      </svg>
    </GraphViewport>
    {expanded && <div className="ad-knowledge-graph-summary"><span><Folder size={13} />{overview ? `${layout.folders.length} ${g.overview.toLocaleLowerCase()} · ${filtered.length} ${copy.notes}` : `${shown.length} / ${filtered.length} ${g.visible}`}</span><span>{mode === "connections" && !selected ? g.focusHint : !overview && filtered.length > shown.length ? g.limitHint : copy.graphHint}</span></div>}
    {!filtered.length && expanded && <p role="status">{mode === "connections" && !selected ? g.focusHint : g.empty}</p>}
  </div>;
  const header = <header><Network size={16} /><h3>{copy.graph}</h3><button type="button" className="ad-icon-button" aria-label={copy.refresh} title={copy.refresh} disabled={loading} onClick={() => void refresh(true)}><RefreshCw size={14} /></button>{!expanded && <button ref={expandButton} type="button" className="ad-icon-button" aria-label={g.expand} title={g.expand} disabled={!graph?.noteCount} onClick={() => setExpanded(true)}><Expand size={15} /></button>}</header>;
  const content = <>
    {loading && <p role="status">{copy.refresh}…</p>}
    {error && <div role="alert" className="ad-documents-error"><p>{error}</p><button type="button" className="ad-button" disabled={loading} onClick={() => void refresh(true)}>{copy.retry}</button></div>}
    {graph && <><p className="ad-note-graph-count">{graph.noteCount} {copy.notes} · {graph.linkCount} {copy.links}</p>
      {!graph.noteCount ? <p>{copy.noNotes}</p> : <><div className={expanded ? "ad-knowledge-expanded-body" : "ad-knowledge-compact-body"}>{canvas}{inspector}</div>{!graph.linkCount && <p>{copy.noLinks}</p>}</>}
      {graph.truncated && <p>{copy.graphLimit}</p>}{graph.indexLimited && <p>{copy.indexLimit}</p>}
      <p className="ad-note-graph-footnote">{copy.cacheHint}</p>
    </>}
  </>;
  return <section className="ad-note-graph" aria-label={copy.graph} aria-busy={loading}>
    {!expanded && <>{header}{content}</>}
    {expanded && createPortal(<dialog ref={modal} className="ad-knowledge-graph-dialog ad-note-graph" aria-label={copy.graph} onCancel={event => { event.preventDefault(); setExpanded(false); }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setExpanded(false); } }}>
      <div className="ad-knowledge-expanded-header">{header}<button type="button" className="ad-icon-button" aria-label={g.close} title={g.close} onClick={() => setExpanded(false)}><X size={19} /></button></div>{content}
    </dialog>, document.body)}
  </section>;
}
