import { useId, useMemo, useState } from "react";
import { Bot, CheckCircle2, Crosshair, Pause, Play, Radio, Terminal, Wrench } from "lucide-react";
import type { AgentNode } from "./AgentObservatory";
import { ProviderIcon } from "../ProviderIcon";
import { GraphViewport } from "../graph/GraphViewport";
import { graphCopy } from "../graph/graphCopy";
import { agentMonitorMessages, agentPhaseLabel } from "./agentMonitorMessages";
import { agentWorking, layoutAgents, taskColumn } from "./agentGraph";
import "../graph/knowledgeGraph.css";
import "./agentFlowMap.css";

export function AgentFlowMap({ nodes, selectedKey, onSelect, locale, board = false }: {
  nodes: AgentNode[]; selectedKey?: string; onSelect: (key: string) => void; locale: string; board?: boolean;
}) {
  const g = graphCopy(locale), m = agentMonitorMessages(locale);
  const [sessionId, setSessionId] = useState("all"); const [paused, setPaused] = useState(false);
  const [focusCount, setFocusCount] = useState(0);
  const markerId = useId().replace(/:/g, "");
  const roots = nodes.filter(node => node.isRoot);
  const effectiveSession = roots.some(node => node.session.id === sessionId) ? sessionId : "all";
  const visible = useMemo(() => nodes.filter(node => effectiveSession === "all" || node.session.id === effectiveSession), [nodes, effectiveSession]);
  const layout = useMemo(() => layoutAgents(visible), [visible]);
  const selectedPosition = selectedKey ? layout.positions.get(selectedKey) : undefined;
  const centerLabel = locale.startsWith("pt") ? "Centralizar agente selecionado" : locale.startsWith("es") ? "Centrar agente seleccionado" : "Center selected agent";
  const rootStatus = new Map(roots.map(root => [root.session.id, root.status]));
  const executing = (node: AgentNode) => agentWorking(node.status) && (node.isRoot || agentWorking(rootStatus.get(node.session.id) ?? ""));
  return <section className="ad-flow-panel" aria-label={board ? g.tasks : g.map} data-paused={paused}>
    <div className="ad-flow-controls"><select aria-label={m.sessions} value={effectiveSession} onChange={event => setSessionId(event.target.value)}><option value="all">{m.all} · {roots.length} {m.sessions.toLocaleLowerCase()}</option>{roots.map(root => <option key={root.key} value={root.session.id}>{root.name}</option>)}</select><span>{visible.length} {g.visible}</span>{!board && <button type="button" className="ad-monitor-icon-button" aria-label={paused ? g.resume : g.pause} title={paused ? g.resume : g.pause} aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? <Play size={15} /> : <Pause size={15} />}</button>}</div>
    {board ? <div className="ad-task-board">{(["waiting", "running", "attention", "completed"] as const).map(column => {
      const items = visible.filter(node => taskColumn(node.status) === column);
      return <section key={column} className="ad-task-column" data-column={column}><header><i className="ad-monitor-dot" data-phase={column === "attention" ? "waiting" : column === "completed" ? "done" : column} /><h3>{g[column]}</h3><span>{items.length}</span></header>{items.map(node => <button key={node.key} type="button" className="ad-board-task" aria-pressed={selectedKey === node.key} onClick={() => onSelect(node.key)}><span><ProviderIcon provider={node.session.runner.type} size={14} />{node.name}</span><strong>{node.task || m.noTask}</strong><small>{agentPhaseLabel(node.status, locale)} · {node.events.length} {m.tools}</small>{!node.isRoot && <small>{g.recorded}</small>}</button>)}</section>;
    })}</div> : <>
      <div className="ad-flow-focus"><button type="button" className="ad-button" disabled={!selectedPosition} onClick={() => setFocusCount(count => count + 1)}><Crosshair size={13} />{centerLabel}</button></div>
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
          return <div key={node.key} className="ad-flow-node" style={{ left: position.x, top: position.y }} data-phase={node.status} data-active={active} data-selected={selectedKey === node.key}>
            <button type="button" className="ad-flow-agent-card" aria-label={`${node.name} · ${agentPhaseLabel(node.status, locale)}`} aria-pressed={selectedKey === node.key} onClick={() => onSelect(node.key)}>
              <span className="ad-flow-avatar">{node.isRoot ? <ProviderIcon provider={node.session.runner.type} size={22} /> : <Bot size={22} />}</span><span className="ad-flow-agent-name"><strong>{node.name}</strong><small>{node.agent?.role || (node.isRoot ? m.root : m.subagents)}</small></span><span className="ad-flow-status"><i className="ad-monitor-dot" data-phase={node.status} />{agentPhaseLabel(node.status, locale)}</span>
            </button>
            <button type="button" className="ad-flow-task-card" aria-label={`${g.task}: ${node.task || m.noTask}`} onClick={() => onSelect(node.key)}>
              <span><Terminal size={12} />{g.task}{!node.isRoot && <small>{g.recorded}</small>}</span><strong>{node.task || m.noTask}</strong><small>{recent ? <><Wrench size={11} />{recent.title}<span>{node.events.length}</span></> : <>{node.status === "done" ? <CheckCircle2 size={12} /> : <Radio size={12} />}{node.isRoot ? m.live : m.native}</>}</small>
            </button>
          </div>;
        })}
      </GraphViewport>
      <div className="ad-flow-legend"><span><i className="ad-monitor-dot" data-phase="running" />{g.running}</span><span><i className="ad-monitor-dot" data-phase="waiting" />{g.attention}</span><span><i className="ad-monitor-dot" data-phase="done" />{g.completed}</span><span className="ad-flow-legend-line" />{g.delegation}<small>{g.mapHint}</small></div>
    </>}
  </section>;
}
