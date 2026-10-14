import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Bot, CheckCircle2, Crosshair, GripVertical, Pause, Play, Radio, Terminal, Wrench } from "lucide-react";
import type { AgentNode } from "./AgentObservatory";
import { ProviderIcon } from "../ProviderIcon";
import { GraphViewport } from "../graph/GraphViewport";
import { graphCopy } from "../graph/graphCopy";
import { agentMonitorMessages, agentPhaseLabel } from "./agentMonitorMessages";
import { agentWorking, layoutAgents, taskColumn } from "./agentGraph";
import "../graph/knowledgeGraph.css";
import "./agentFlowMap.css";
import { SortableCollection, ArrangementControls } from "../ordering/SortableCollection";
import { orderingCopy } from "../ordering/orderingCopy";
import { presentationKey, usePresentationStore, type VisualPoint } from "../../store/presentationStore";

function PositionedAgent({ node, position, selected, active, locale, onCommit, children }: {
  node: AgentNode; position: VisualPoint; selected: boolean; active: boolean; locale: string;
  onCommit: (id: string, point: VisualPoint) => void; children: ReactNode;
}) {
  const [preview, setPreview] = useState<VisualPoint | null>(null), [dragging, setDragging] = useState(false);
  const start = useRef<{ point: VisualPoint; x: number; y: number; scale: number; moved: boolean } | null>(null);
  const pending = useRef<VisualPoint | null>(null);
  const point = preview ?? position, c = orderingCopy(locale);
  const cancel = () => { start.current = null; pending.current = null; setPreview(null); setDragging(false); };
  return <div className="ad-flow-node" style={{ left: point.x, top: point.y }} data-phase={node.status} data-active={active} data-selected={selected} data-position-dragging={dragging}>
    <button type="button" className="ad-reorder-handle ad-flow-drag-handle" aria-label={`${c.drag}: ${node.name}`} title={c.mapHint}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.stopPropagation(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { point: position, x: event.clientX, y: event.clientY, scale: Number(event.currentTarget.closest('.ad-graph-world')?.getAttribute('data-scale')) || 1, moved: false };
        setDragging(true);
      }} onPointerMove={event => {
        const initial = start.current; if (!initial) return;
        const dx = event.clientX - initial.x, dy = event.clientY - initial.y;
        if (!initial.moved && Math.hypot(dx, dy) < 7) return;
        initial.moved = true;
        const next = { x: Math.max(0, initial.point.x + dx / initial.scale), y: Math.max(0, initial.point.y + dy / initial.scale) };
        pending.current = next; setPreview(next);
      }} onPointerUp={event => {
        event.stopPropagation(); if (start.current?.moved && pending.current) onCommit(node.key, pending.current);
        cancel();
      }} onPointerCancel={cancel} onClick={event => event.stopPropagation()} onKeyDown={event => {
        if (event.key === "Escape" && start.current) { event.preventDefault(); event.stopPropagation(); cancel(); }
        else if (event.key.startsWith("Arrow")) {
          event.preventDefault(); event.stopPropagation(); const step = event.shiftKey ? 40 : 16;
          onCommit(node.key, { x: Math.max(0, position.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0)), y: Math.max(0, position.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0)) });
        }
      }}><GripVertical size={15} /></button>{children}
  </div>;
}

export function AgentFlowMap({ nodes, allNodes = nodes, selectedKey, onSelect, locale, board = false }: {
  nodes: AgentNode[]; allNodes?: AgentNode[]; selectedKey?: string; onSelect: (key: string) => void; locale: string; board?: boolean;
}) {
  const g = graphCopy(locale), m = agentMonitorMessages(locale), c = orderingCopy(locale);
  const [sessionId, setSessionId] = useState("all"); const [paused, setPaused] = useState(false);
  const [focusCount, setFocusCount] = useState(0);
  const manualBoard = usePresentationStore(state => state.views["agent-board"] === "manual");
  const setManualBoard = (manual: boolean) => usePresentationStore.getState().setView("agent-board", manual ? "manual" : "status");
  const savedPositions = usePresentationStore(state => state.layouts[presentationKey("agent-map", "all")]?.positions);
  const markerId = useId().replace(/:/g, "");
  const roots = nodes.filter(node => node.isRoot);
  const effectiveSession = roots.some(node => node.session.id === sessionId) ? sessionId : "all";
  const visible = useMemo(() => nodes.filter(node => effectiveSession === "all" || node.session.id === effectiveSession), [nodes, effectiveSession]);
  const automaticLayout = useMemo(() => layoutAgents(allNodes), [allNodes]);
  const layout = useMemo(() => {
    const positions = new Map(automaticLayout.positions);
    for (const [id, point] of Object.entries(savedPositions ?? {})) if (positions.has(id)) positions.set(id, point);
    return { ...automaticLayout, positions, width: Math.max(automaticLayout.width, ...[...positions.values()].map(point => point.x + 300)), height: Math.max(automaticLayout.height, ...[...positions.values()].map(point => point.y + 230)) };
  }, [automaticLayout, savedPositions]);
  const commitPosition = (id: string, point: VisualPoint) => usePresentationStore.getState().setPositions("agent-map", "all", { ...Object.fromEntries(layout.positions), ...savedPositions, [id]: point });
  const selectedPosition = selectedKey ? layout.positions.get(selectedKey) : undefined;
  const centerLabel = locale.startsWith("pt") ? "Centralizar agente selecionado" : locale.startsWith("es") ? "Centrar agente seleccionado" : "Center selected agent";
  const rootStatus = new Map(roots.map(root => [root.session.id, root.status]));
  const executing = (node: AgentNode) => agentWorking(node.status) && (node.isRoot || agentWorking(rootStatus.get(node.session.id) ?? ""));
  return <section className="ad-flow-panel" aria-label={board ? g.tasks : g.map} data-paused={paused}>
    <div className="ad-flow-controls"><select aria-label={m.sessions} value={effectiveSession} onChange={event => setSessionId(event.target.value)}><option value="all">{m.all} · {roots.length} {m.sessions.toLocaleLowerCase()}</option>{roots.map(root => <option key={root.key} value={root.session.id}>{root.name}</option>)}</select><span>{visible.length} {g.visible}</span>{!board && <button type="button" className="ad-monitor-icon-button" aria-label={paused ? g.resume : g.pause} title={paused ? g.resume : g.pause} aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? <Play size={15} /> : <Pause size={15} />}</button>}</div>
    {board && <div className="ad-flow-board-mode" role="group" aria-label={c.arrange}><button type="button" className="ad-button" aria-pressed={!manualBoard} onClick={() => setManualBoard(false)}>{c.status}</button><button type="button" className="ad-button" aria-pressed={manualBoard} onClick={() => setManualBoard(true)}>{c.manual}</button></div>}
    {board ? manualBoard ? <SortableCollection surface="agent-board-manual" context="all" className="ad-board-manual" items={visible} allIds={allNodes.map(node => node.key)} getId={node => node.key} getLabel={node => node.name} render={(node, handle) => <div className="ad-board-arrange-row">{handle}<button type="button" className="ad-board-task" aria-pressed={selectedKey === node.key} onClick={() => onSelect(node.key)}><span><ProviderIcon provider={node.session.runner.type} size={14} />{node.name}</span><strong>{node.task || m.noTask}</strong><small>{agentPhaseLabel(node.status, locale)} · {node.events.length} {m.tools}</small>{node.parentKey && <small>{m.childOf} {allNodes.find(parent => parent.key === node.parentKey)?.name ?? node.parentKey}</small>}</button></div>} /> : <div className="ad-task-board">{(["waiting", "running", "attention", "completed"] as const).map(column => {
      const items = visible.filter(node => taskColumn(node.status) === column);
      return <section key={column} className="ad-task-column" data-column={column}><header><i className="ad-monitor-dot" data-phase={column === "attention" ? "waiting" : column === "completed" ? "done" : column} /><h3>{g[column]}</h3><span>{items.length}</span></header><SortableCollection surface="agent-board-column" context={column} items={items} allIds={allNodes.filter(node => taskColumn(node.status) === column).map(node => node.key)} getId={node => node.key} getLabel={node => node.name} render={(node, handle) => <div className="ad-board-arrange-row">{handle}<button type="button" className="ad-board-task" aria-pressed={selectedKey === node.key} onClick={() => onSelect(node.key)}><span><ProviderIcon provider={node.session.runner.type} size={14} />{node.name}</span><strong>{node.task || m.noTask}</strong><small>{agentPhaseLabel(node.status, locale)} · {node.events.length} {m.tools}</small>{!node.isRoot && <small>{g.recorded}</small>}</button></div>} /></section>;
    })}</div> : <>
      <div className="ad-flow-focus"><button type="button" className="ad-button" disabled={!selectedPosition} onClick={() => setFocusCount(count => count + 1)}><Crosshair size={13} />{centerLabel}</button><ArrangementControls surface="agent-map" context="all" /></div>
      <GraphViewport width={layout.width} height={layout.height} label={g.map} controls={g} resetKey={effectiveSession} focusTarget={focusCount && selectedPosition ? { x: selectedPosition.x + 126, y: selectedPosition.y + 100, key: `${selectedKey}:${focusCount}` } : undefined}>
        <svg className="ad-flow-connectors" width={layout.width} height={layout.height} aria-hidden="true">
          <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
          {visible.map(node => {
            const position = layout.positions.get(node.key); if (!position) return null;
            const from = node.parentKey ? layout.positions.get(node.parentKey) : undefined;
            const active = executing(node), related = node.key === selectedKey || node.parentKey === selectedKey;
            const path = from ? `M ${from.x + 252} ${from.y + 40} C ${from.x + 291} ${from.y + 40}, ${position.x - 39} ${position.y + 40}, ${position.x} ${position.y + 40}` : "";
            const task = `M ${position.x + 126} ${position.y + 80} L ${position.x + 126} ${position.y + 106}`;
            return <g key={node.key} data-active={active} data-related={related}>
              {from && <><path className="ad-flow-edge" markerEnd={`url(#${markerId})`} d={path} /><path className="ad-flow-signal" d={path} /></>}
              <path className="ad-flow-edge" d={task} /><path className="ad-flow-signal" d={task} />
            </g>;
          })}
        </svg>
        {layout.lanes.map(lane => <div key={lane.key} className="ad-flow-lane" style={{ top: lane.y, width: layout.width - 64, height: lane.height }}><span>{lane.title}</span></div>)}
        {visible.map(node => {
          const position = layout.positions.get(node.key); if (!position) return null;
          const active = executing(node), recent = node.events[node.events.length - 1];
          return <PositionedAgent key={node.key} node={node} position={position} selected={selectedKey === node.key} active={active} locale={locale} onCommit={commitPosition}>
            <button type="button" className="ad-flow-agent-card" aria-label={`${node.name} · ${agentPhaseLabel(node.status, locale)}`} aria-pressed={selectedKey === node.key} onClick={() => onSelect(node.key)}>
              <span className="ad-flow-avatar">{node.isRoot ? <ProviderIcon provider={node.session.runner.type} size={22} /> : <Bot size={22} />}</span><span className="ad-flow-agent-name"><strong>{node.name}</strong><small>{node.agent?.role || (node.isRoot ? m.root : m.subagents)}</small></span><span className="ad-flow-status"><i className="ad-monitor-dot" data-phase={node.status} />{agentPhaseLabel(node.status, locale)}</span>
            </button>
            <button type="button" className="ad-flow-task-card" aria-label={`${g.task}: ${node.task || m.noTask}`} onClick={() => onSelect(node.key)}>
              <span><Terminal size={12} />{g.task}{!node.isRoot && <small>{g.recorded}</small>}</span><strong>{node.task || m.noTask}</strong><small>{recent ? <><Wrench size={11} />{recent.title}<span>{node.events.length}</span></> : <>{node.status === "done" ? <CheckCircle2 size={12} /> : <Radio size={12} />}{node.isRoot ? m.live : m.native}</>}</small>
            </button>
          </PositionedAgent>;
        })}
      </GraphViewport>
      <div className="ad-flow-legend"><span><i className="ad-monitor-dot" data-phase="running" />{g.running}</span><span><i className="ad-monitor-dot" data-phase="waiting" />{g.attention}</span><span><i className="ad-monitor-dot" data-phase="done" />{g.completed}</span><span className="ad-flow-legend-line" />{g.delegation}<small>{g.mapHint}</small></div>
    </>}
  </section>;
}
