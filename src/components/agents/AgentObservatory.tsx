import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Activity, ArrowUpRight, Bot, Check, CheckCircle2, CircleAlert, Clock3, GitBranch, Network, RefreshCw, Search, Terminal, Wrench, X } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { useSessionStore, type ClaudeSession } from "../../store/sessionStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { RUNNER_LABELS } from "../../store/settingsStore";
import { emptyActivity, useAgentActivityStore } from "../../store/agentActivityStore";
import { useAgentObservabilityStore, type AgentObservation, type AgentToolEvent, type ObservedAgent } from "../../store/agentObservabilityStore";
import { getAgentAdapter } from "../../services/agentAdapters";
import { ProviderIcon } from "../ProviderIcon";
import { agentMonitorMessages, agentPhaseLabel } from "./agentMonitorMessages";
import { AgentFlowMap } from "./AgentFlowMap";
import { normalizeAgentParents } from "./agentGraph";
import { graphCopy } from "../graph/graphCopy";
import "./agentObservatory.css";

export interface AgentNode {
  key: string;
  session: ClaudeSession;
  agent?: ObservedAgent;
  isRoot: boolean;
  name: string;
  parentKey?: string;
  status: string;
  task: string;
  events: AgentToolEvent[];
  updatedAt?: number;
  source: "live" | "native";
}

type StatusFilter = "all" | "working" | "attention" | "completed" | "subagents";
const working = (status: string) => ["starting", "connected", "running"].includes(status);
const attention = (status: string) => ["waiting", "error"].includes(status);

export function AgentObservatory({ onOpenSession, onClose }: { onOpenSession: (sessionId: string) => void; onClose: () => void }) {
  const { locale, t } = useAppI18n();
  const m = agentMonitorMessages(locale);
  const g = graphCopy(locale);
  const [view, setView] = useState<"map" | "list" | "tasks">("map");
  const sessions = useSessionStore(state => state.sessions);
  const activeSessionId = useSessionStore(state => state.activeSessionId);
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const activities = useAgentActivityStore(state => state.sessions);
  const { observations, live, updatedAt, setObservations } = useAgentObservabilityStore();
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(activeSessionId ? `${activeSessionId}:main` : null);
  const [refreshCount, setRefreshCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [chromeInsets, setChromeInsets] = useState({ top: 44, bottom: 45 });
  const dialog = useRef<HTMLElement>(null);
  const closeHandler = useRef(onClose);
  closeHandler.current = onClose;
  const desktop = "__TAURI_INTERNALS__" in window;
  const requestKey = JSON.stringify(sessions.map(session => ({ sessionId: session.id, provider: session.runner.type, providerSessionId: session.providerSessionId, workdir: session.worktreePath ?? session.workdir })));

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeHandler.current(); }
      if (event.key === "Tab") {
        const focusable = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, summary, [tabindex="0"]');
        if (!focusable?.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        const outside = !dialog.current?.contains(document.activeElement) || document.activeElement === dialog.current;
        if (event.shiftKey && (document.activeElement === first || outside)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || outside)) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => { document.removeEventListener("keydown", keydown, true); previousFocus?.focus(); };
  }, []);

  useEffect(() => {
    const titlebar = document.querySelector(".ad-titlebar");
    const footer = document.querySelector(".provider-usage-bar");
    const measure = () => setChromeInsets({ top: titlebar?.getBoundingClientRect().bottom ?? 44, bottom: footer ? window.innerHeight - footer.getBoundingClientRect().top : 45 });
    measure();
    const observer = new ResizeObserver(measure);
    if (titlebar) observer.observe(titlebar);
    if (footer) observer.observe(footer);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (cancelled || pending || document.hidden) return;
      pending = true;
      setLoading(true);
      try {
        const result = await invoke<AgentObservation[]>("observe_agent_sessions", { sessions: JSON.parse(requestKey) });
        if (!cancelled) { setObservations(result); setError(""); setNow(Date.now()); }
      } catch (cause) {
        if (!cancelled) setError(String(cause));
      } finally {
        pending = false;
        if (!cancelled) { setLoading(false); timer = setTimeout(() => void refresh(), 8000); }
      }
    };
    const visibilityChanged = () => {
      if (timer) clearTimeout(timer);
      if (!document.hidden) void refresh();
    };
    void refresh();
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => { cancelled = true; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", visibilityChanged); };
  }, [requestKey, desktop, refreshCount, setObservations]);

  const nodes = useMemo<AgentNode[]>(() => normalizeAgentParents(sessions.flatMap(session => {
    const observation = observations[session.id];
    const native = observation?.agents.find(agent => agent.id === session.providerSessionId);
    const activity = activities[session.id] ?? emptyActivity;
    const streaming = live[session.id];
    const root: AgentNode = {
      key: `${session.id}:main`, session, agent: native, isRoot: true, name: session.name,
      status: activity.phase === "idle" ? session.status : activity.phase,
      task: session.currentTask || native?.task || "", events: streaming?.tools.length ? streaming.tools : native?.events ?? [],
      updatedAt: Math.max(streaming?.updatedAt ?? 0, activity.lastOutputAt ?? 0, native?.updatedAt ?? 0) || undefined,
      source: streaming?.tools.length ? "live" : "native",
    };
    const children = observation?.agents.filter(agent => agent.id !== session.providerSessionId) ?? [];
    return [root, ...children.map(agent => ({
      key: `${session.id}:${agent.id}`, session, agent, isRoot: false, name: agent.name,
      parentKey: agent.parentId === session.providerSessionId || !children.some(child => child.id === agent.parentId) ? root.key : `${session.id}:${agent.parentId}`,
      status: agent.status, task: agent.task, events: agent.events, updatedAt: agent.updatedAt, source: "native" as const,
    }))];
  })), [sessions, observations, activities, live]);

  const visibleNodes = useMemo(() => {
    const included = new Set<string>();
    const normalized = query.toLocaleLowerCase().trim();
    for (const node of nodes) {
      const project = workspaces.find(workspace => workspace.id === node.session.workspaceId)?.name ?? "";
      if (provider !== "all" && node.session.runner.type !== provider) continue;
      if (statusFilter === "working" && !working(node.status)) continue;
      if (statusFilter === "attention" && !attention(node.status)) continue;
      if (statusFilter === "completed" && node.status !== "done") continue;
      if (statusFilter === "subagents" && node.isRoot) continue;
      if (normalized && !`${node.name} ${node.task} ${project} ${node.agent?.role ?? ""}`.toLocaleLowerCase().includes(normalized)) continue;
      included.add(node.key);
      let parent = node.parentKey;
      for (let depth = 0; parent && depth < 12; depth += 1) { included.add(parent); parent = nodes.find(candidate => candidate.key === parent)?.parentKey; }
    }
    return nodes.filter(node => included.has(node.key));
  }, [nodes, workspaces, provider, statusFilter, query]);

  const selected = visibleNodes.find(node => node.key === selectedKey) ?? visibleNodes[0];
  const selectedParent = nodes.find(node => node.key === selected?.parentKey);
  const selectedActivity = selected ? activities[selected.session.id] ?? emptyActivity : emptyActivity;
  const selectedObservation = selected ? observations[selected.session.id] : undefined;
  const roots = nodes.filter(node => node.isRoot);
  const relativeTime = (timestamp?: number) => {
    if (!timestamp) return "—";
    const minutes = Math.floor(Math.max(0, now - timestamp) / 60000);
    return minutes < 1 ? m.justNow : minutes < 60 ? `${minutes} ${m.minutes}` : new Date(timestamp).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  };
  const metrics: { filter: StatusFilter; label: string; count: number }[] = [
    { filter: "all", label: m.sessions, count: roots.length },
    { filter: "working", label: m.working, count: nodes.filter(node => working(node.status)).length },
    { filter: "attention", label: m.attention, count: nodes.filter(node => attention(node.status)).length },
    { filter: "completed", label: m.completed, count: nodes.filter(node => node.status === "done").length },
    { filter: "subagents", label: m.subagents, count: nodes.length - roots.length },
  ];
  const clearFilters = () => { setQuery(""); setProvider("all"); setStatusFilter("all"); };

  const renderNode = (node: AgentNode, depth = 0): React.ReactNode => <div key={node.key} className={depth ? "ad-monitor-branch" : "ad-monitor-root"}>
    <button className="ad-monitor-agent" data-selected={selected?.key === node.key} aria-pressed={selected?.key === node.key} onClick={() => setSelectedKey(node.key)} title={m.showDetails}>
      <span className="ad-monitor-avatar" data-child={!node.isRoot}>{node.isRoot ? <ProviderIcon provider={node.session.runner.type} size={20} /> : <Bot size={18} />}</span>
      <span className="ad-monitor-agent-copy"><strong>{node.name}</strong><span>{node.agent?.role || (node.isRoot ? workspaces.find(workspace => workspace.id === node.session.workspaceId)?.name || getAgentAdapter(node.session.runner.type).name : m.subagents)}</span><small>{node.task || m.noTask}</small></span>
      <span className="ad-monitor-node-side"><span className="ad-monitor-node-status"><i className="ad-monitor-dot" data-phase={node.status} />{agentPhaseLabel(node.status, locale)}</span><time>{relativeTime(node.updatedAt)}</time></span>
    </button>
    {depth < 10 && visibleNodes.filter(child => child.parentKey === node.key).map(child => renderNode(child, depth + 1))}
  </div>;

  return <div className="ad-monitor-backdrop" style={chromeInsets} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="ad-agent-observatory" role="dialog" aria-modal="true" aria-labelledby="agent-monitor-title" tabIndex={-1} ref={dialog}>
      <header className="ad-monitor-header">
        <div className="ad-monitor-brand"><h1 id="agent-monitor-title">{m.title}</h1><p>{m.subtitle}</p></div>
        <div className="ad-monitor-header-actions"><span className="ad-monitor-sync"><i />{updatedAt ? `${m.updated} ${relativeTime(updatedAt)}` : m.live}</span><button className="ad-monitor-icon-button" disabled={loading || !desktop} onClick={() => setRefreshCount(count => count + 1)} title={m.refresh} aria-label={m.refresh}><RefreshCw size={17} className={loading ? "ad-monitor-spinning" : ""} /></button><button className="ad-monitor-icon-button" onClick={onClose} title={m.close} aria-label={m.close}><X size={20} /></button></div>
      </header>

      <div className="ad-monitor-metrics" role="group" aria-label={m.activity}>
        {metrics.map(metric => <button key={metric.filter} className="ad-monitor-metric" aria-pressed={statusFilter === metric.filter} data-attention={metric.filter === "attention" && metric.count > 0} onClick={() => setStatusFilter(metric.filter)}><span>{metric.label}</span><strong>{metric.count}</strong></button>)}
      </div>

      <div className="ad-monitor-controls"><div className="ad-graph-segments" role="group" aria-label={m.title}>{(["map", "tasks", "list"] as const).map(value => <button type="button" key={value} aria-pressed={view === value} onClick={() => setView(value)}>{g[value]}</button>)}</div><label className="ad-monitor-search"><Search size={17} /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={m.search} aria-label={m.search} /></label><select value={provider} onChange={event => setProvider(event.target.value)} aria-label={m.allProviders}><option value="all">{m.allProviders}</option>{Object.entries(RUNNER_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></div>
      {error && <div className="ad-monitor-notice" role="alert"><CircleAlert size={15} /><span>{m.loadError} {error}</span></div>}
      {!desktop && <div className="ad-monitor-notice"><Activity size={15} /><span>{m.browser}</span></div>}

      {sessions.length === 0 ? <div className="ad-monitor-empty"><span><Network size={44} /></span><h2>{m.noSessions}</h2><p>{m.noSessionsDetail}</p></div>
        : visibleNodes.length === 0 ? <div className="ad-monitor-empty"><Search size={36} /><h2>{m.noResults}</h2><button className="ad-monitor-primary" onClick={clearFilters}>{m.clear}</button></div>
        : <div className="ad-monitor-body" data-view={view}>
          {view === "list" ? <nav className="ad-monitor-tree" aria-label={m.title}>{visibleNodes.filter(node => node.isRoot).map(node => renderNode(node))}</nav> : <AgentFlowMap nodes={visibleNodes} selectedKey={selected?.key} onSelect={setSelectedKey} locale={locale} board={view === "tasks"} />}
          {selected && <article className="ad-monitor-detail" key={selected.key}>
            <header className="ad-monitor-detail-header"><div><h2>{selected.name}</h2><div className="ad-monitor-breadcrumb"><ProviderIcon provider={selected.session.runner.type} size={14} />{getAgentAdapter(selected.session.runner.type).name}<span>{selected.isRoot ? m.root : m.subagents}</span>{selectedParent && <button className="ad-monitor-parent" onClick={() => setSelectedKey(selectedParent.key)}><GitBranch size={12} />{m.childOf} {selectedParent.name}</button>}</div><div className="ad-monitor-detail-status"><span className="ad-monitor-badge" data-phase={selected.status}><i className="ad-monitor-dot" data-phase={selected.status} />{agentPhaseLabel(selected.status, locale)}</span>{selected.agent?.role && <span className="ad-monitor-role">{selected.agent.role}</span>}<span><Clock3 size={12} />{relativeTime(selected.updatedAt)}</span></div></div><button className="ad-monitor-primary" onClick={() => onOpenSession(selected.session.id)}>{m.openChat}<ArrowUpRight size={15} /></button></header>
            {!selected.isRoot && <p className="ad-monitor-history-note"><Clock3 size={13} />{m.history}</p>}
            <section className="ad-monitor-task"><span className="ad-monitor-section-label"><Terminal size={14} />{m.task}</span><p>{selected.task || m.noTask}</p></section>
            <div className="ad-monitor-detail-grid"><section className="ad-monitor-timeline"><div className="ad-monitor-section-heading"><h3><Wrench size={16} />{m.toolsLabel}</h3><span>{selected.events.length} {m.tools}</span></div><p className="ad-monitor-source">{m[selected.source]}</p>
              {selected.events.length ? <ol>{selected.events.slice().reverse().map((event, index) => <li key={`${event.id}-${index}`}><span className="ad-monitor-tool-icon" data-state={event.status}>{event.status === "completed" ? <Check size={13} /> : event.status === "failed" ? <X size={13} /> : <Wrench size={12} />}</span><div><div className="ad-monitor-tool-title"><strong>{event.title}</strong><span>{event.status === "completed" ? m.toolCompleted : event.status === "failed" ? m.toolFailed : event.status === "stopped" ? m.toolStopped : m.toolRunning}</span></div>{event.detail && <details><summary>{event.detail.split("\n")[0].slice(0, 140)}</summary><pre>{event.detail}</pre></details>}{event.timestamp && <time>{new Date(event.timestamp).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>}</div></li>)}</ol> : <div className="ad-monitor-inline-empty"><Wrench size={24} /><p>{m.noEvents}</p></div>}
              {selected.agent?.truncated && <p className="ad-monitor-source">{m.recentOnly}</p>}
            </section><aside className="ad-monitor-facts"><h3>{m.details}</h3><dl><dt>{m.workspace}</dt><dd>{workspaces.find(workspace => workspace.id === selected.session.workspaceId)?.name || "—"}</dd><dt>{m.model}</dt><dd>{selected.agent?.model || selected.session.runner.model || "—"}</dd><dt>{m.directory}</dt><dd>{selected.session.worktreePath || selected.session.workdir}</dd>{selected.isRoot && <><dt>{m.files}</dt><dd>{selected.session.diffFiles.length}</dd><dt>{m.process}</dt><dd>{selectedActivity.pid ? `PID ${selectedActivity.pid}` : "—"}</dd></>}<dt>{m.nativeId}</dt><dd><code>{selected.agent?.id || selected.session.providerSessionId || "—"}</code></dd><dt>{m.lastActivity}</dt><dd>{selected.updatedAt ? new Date(selected.updatedAt).toLocaleString(locale) : "—"}</dd></dl>
              {selected.isRoot && <div className="ad-monitor-subagent-note"><GitBranch size={16} /><p>{selected.session.runner.type === "gemini" ? m.unsupported : !selected.session.providerSessionId ? m.unbound : !selectedObservation?.available ? m.unavailable : selectedObservation.agents.length <= 1 ? m.noSubagents : `${selectedObservation.agents.length - 1} ${m.subagents.toLocaleLowerCase()}`}</p></div>}
            </aside></div>
            {selected.agent?.lastMessage && <section className="ad-monitor-message"><h3><CheckCircle2 size={16} />{m.message}</h3><p>{selected.agent.lastMessage}</p></section>}
            {selected.isRoot && selectedActivity.events.length > 0 && <section className="ad-monitor-execution"><h3><Activity size={16} />{m.eventsLabel}</h3><ol>{selectedActivity.events.slice(-12).reverse().map((event, index) => <li key={index}><time>{new Date(event.at).toLocaleTimeString(locale)}</time><span>{t(event.key)}{event.detail ? ` · ${event.detail}` : ""}</span></li>)}</ol></section>}
          </article>}
        </div>}
      <footer className="ad-monitor-footer"><span><i className="ad-monitor-dot" data-phase="connected" />{m.localOnly}</span><span>Agentdeck <Network size={12} /></span></footer>
    </section>
  </div>;
}
