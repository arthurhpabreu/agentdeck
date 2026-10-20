import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ChevronDown, MessagesSquare, Plus, RefreshCw, Send, Settings2, Users, X } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { useSessionStore, type ClaudeSession } from "../../store/sessionStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { configureTeam, projectPath, syncProjectCoordination, teamCall, type TeamBoard, type TeamMessage } from "../../services/projectCoordination";
import { showSessionSurface } from "../../services/workbenchCommands";
import { createUuid } from "../../services/ids";
import "./projectCoordination.css";

const copies = {
  pt: {
    title: "Equipe de agentes", connect: "Conectar agentes", team: "Equipe", agents: "agentes", close: "Fechar equipe", refresh: "Atualizar equipe",
    create: "Criar equipe", edit: "Editar equipe", name: "Nome da equipe", objective: "Objetivo compartilhado", objectiveHint: "Descreva o resultado e como dividir o trabalho.",
    members: "Participantes", choose: "Selecione de 2 a 12 chats, de qualquer projeto.", search: "Buscar chat ou projeto", self: "Este chat", optedOut: "Coordenação desativada", unavailable: "Chat indisponível",
    selected: "selecionados", save: "Salvar equipe", cancel: "Cancelar", saving: "Salvando…", loading: "Carregando equipe…", empty: "Conecte chats para dividir tarefas e acompanhar a conversa entre agentes.",
    automatic: "Coordenação automática", automaticHint: "O app entrega solicitações aos chats estruturados de Codex e Claude. No terminal, o agente consulta a equipe na próxima etapa. Pode consumir tokens.",
    automaticOn: "Ativa", automaticOff: "Pausada", saved: "Equipe salva.", disabled: "A coordenação está desativada para este chat.", enable: "Ativar coordenação neste chat",
    conversation: "Conversa da equipe", noMessages: "A conversa da equipe aparecerá aqui.", earlier: "Carregar mensagens anteriores", message: "Mensagem para a equipe", send: "Enviar mensagem", recipient: "Destino", everyone: "Toda a equipe", request: "Solicitar uma tarefa", requestHint: "Escolha uma pessoa para solicitar uma tarefa.",
    queued: "Na fila", delivered: "Entregue", read: "Lida pelo agente", failed: "Falha na entrega", sent: "Mensagem registrada.", you: "Você", member: "Participante", requestLabel: "Solicitação", reply: "Resposta", update: "Atualização", to: "para", stale: "Atividade desatualizada", activity: "Sem atividade informada", claimHint: "Informado pelos agentes; confira o estado atual antes de editar.", leave: "Sair da equipe", left: "Você saiu da equipe.", invalid: "Selecione de 2 a 12 participantes.", none: "Nenhum chat encontrado.",
    bytes: "bytes", limitExceeded: "Limite de envio excedido. Reduza o texto.",
    states: { running: "Trabalhando", busy: "Trabalhando", idle: "Disponível", done: "Concluído", waiting: "Aguardando", error: "Erro", stopped: "Interrompido", starting: "Iniciando" } as Record<string, string>,
  },
  en: {
    title: "Agent team", connect: "Connect agents", team: "Team", agents: "agents", close: "Close team", refresh: "Refresh team",
    create: "Create team", edit: "Edit team", name: "Team name", objective: "Shared objective", objectiveHint: "Describe the result and how to divide the work.",
    members: "Participants", choose: "Choose 2 to 12 chats, from any project.", search: "Find a chat or project", self: "This chat", optedOut: "Coordination disabled", unavailable: "Chat unavailable",
    selected: "selected", save: "Save team", cancel: "Cancel", saving: "Saving…", loading: "Loading team…", empty: "Connect chats to share tasks and follow the conversation between agents.",
    automatic: "Automatic coordination", automaticHint: "The app delivers requests to structured Codex and Claude chats. In a terminal, the agent checks the team at its next step. This may use tokens.",
    automaticOn: "Active", automaticOff: "Paused", saved: "Team saved.", disabled: "Coordination is disabled for this chat.", enable: "Enable coordination for this chat",
    conversation: "Team conversation", noMessages: "The team conversation will appear here.", earlier: "Load earlier messages", message: "Message to the team", send: "Send message", recipient: "Recipient", everyone: "Whole team", request: "Request a task", requestHint: "Choose a person to request a task.",
    queued: "Queued", delivered: "Delivered", read: "Read by agent", failed: "Delivery failed", sent: "Message recorded.", you: "You", member: "Participant", requestLabel: "Request", reply: "Reply", update: "Update", to: "to", stale: "Activity is stale", activity: "No activity shared", claimHint: "Reported by agents; check the current state before editing.", leave: "Leave team", left: "You left the team.", invalid: "Choose 2 to 12 participants.", none: "No chats found.",
    bytes: "bytes", limitExceeded: "Sending limit exceeded. Shorten the text.",
    states: { running: "Working", busy: "Working", idle: "Available", done: "Done", waiting: "Waiting", error: "Error", stopped: "Stopped", starting: "Starting" } as Record<string, string>,
  },
  es: {
    title: "Equipo de agentes", connect: "Conectar agentes", team: "Equipo", agents: "agentes", close: "Cerrar equipo", refresh: "Actualizar equipo",
    create: "Crear equipo", edit: "Editar equipo", name: "Nombre del equipo", objective: "Objetivo compartido", objectiveHint: "Describe el resultado y cómo dividir el trabajo.",
    members: "Participantes", choose: "Selecciona de 2 a 12 chats, de cualquier proyecto.", search: "Buscar chat o proyecto", self: "Este chat", optedOut: "Coordinación desactivada", unavailable: "Chat no disponible",
    selected: "seleccionados", save: "Guardar equipo", cancel: "Cancelar", saving: "Guardando…", loading: "Cargando equipo…", empty: "Conecta chats para repartir tareas y seguir la conversación entre agentes.",
    automatic: "Coordinación automática", automaticHint: "La app entrega solicitudes a los chats estructurados de Codex y Claude. En el terminal, el agente consulta al equipo en su próxima etapa. Puede consumir tokens.",
    automaticOn: "Activa", automaticOff: "Pausada", saved: "Equipo guardado.", disabled: "La coordinación está desactivada para este chat.", enable: "Activar coordinación en este chat",
    conversation: "Conversación del equipo", noMessages: "La conversación del equipo aparecerá aquí.", earlier: "Cargar mensajes anteriores", message: "Mensaje para el equipo", send: "Enviar mensaje", recipient: "Destino", everyone: "Todo el equipo", request: "Solicitar una tarea", requestHint: "Elige a una persona para solicitar una tarea.",
    queued: "En cola", delivered: "Entregado", read: "Leído por el agente", failed: "Error de entrega", sent: "Mensaje registrado.", you: "Tú", member: "Participante", requestLabel: "Solicitud", reply: "Respuesta", update: "Actualización", to: "para", stale: "Actividad desactualizada", activity: "Sin actividad compartida", claimHint: "Informado por los agentes; comprueba el estado actual antes de editar.", leave: "Salir del equipo", left: "Has salido del equipo.", invalid: "Selecciona de 2 a 12 participantes.", none: "No se encontraron chats.",
    bytes: "bytes", limitExceeded: "Límite de envío superado. Acorta el texto.",
    states: { running: "Trabajando", busy: "Trabajando", idle: "Disponible", done: "Completado", waiting: "Esperando", error: "Error", stopped: "Interrumpido", starting: "Iniciando" } as Record<string, string>,
  },
};

const providerNames: Record<string, string> = { codex: "Codex", "claude-code": "Claude", gemini: "Gemini" };
const byteCount = (value: string) => new TextEncoder().encode(value).length;
const pathName = (value: string) => value.split(/[\\/]/).filter(Boolean).pop();
const mergeMessages = (old: TeamMessage[], incoming: TeamMessage[]) => [...new Map([...old, ...incoming].map(message => [message.seq, message])).values()].sort((a, b) => a.seq - b.seq);
interface Candidate { sessionId: string; projectPath: string; projectName: string; name: string; provider: string; workdir: string; disabled: boolean }

export function ProjectCoordination({ session, visible }: { session: ClaudeSession; visible: boolean }) {
  const { locale } = useAppI18n();
  const c = locale.startsWith("pt") ? copies.pt : locale.startsWith("es") ? copies.es : copies.en;
  const sessions = useSessionStore(state => state.sessions);
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const enabled = session.coordinationEnabled !== false;
  const [open, setOpen] = useState(false);
  const [board, setBoard] = useState<TeamBoard | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [automatic, setAutomatic] = useState(true);
  const [selected, setSelected] = useState<string[]>([session.id]);
  const [search, setSearch] = useState("");
  const [recipient, setRecipient] = useState("");
  const [message, setMessage] = useState("");
  const [requestTask, setRequestTask] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const nameOverLimit = byteCount(name.trim()) > 160;
  const objectiveOverLimit = byteCount(objective.trim()) > 2000;
  const messageOverLimit = byteCount(message.trim()) > 3000 || byteCount(JSON.stringify(message.trim())) > 4096;
  const generation = useRef(0);
  const mutation = useRef(0);
  const currentSession = useRef(session);
  const fetching = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const currentVisibility = useRef(visible);
  const restoreTriggerFocus = useRef(true);
  const dialog = useRef<HTMLElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const olderScroll = useRef<{ height: number; top: number } | null>(null);
  const sendKey = useRef<string | null>(null);
  currentSession.current = session;
  currentVisibility.current = visible;
  const jumpToLatest = () => requestAnimationFrame(() => { if (timeline.current) { timeline.current.scrollTop = timeline.current.scrollHeight; followBottom.current = true; } });

  const acceptBoard = useCallback((incoming: TeamBoard, older = false) => {
    setBoard(previous => {
      if (!previous?.team || previous.team.id !== incoming.team?.id) return incoming;
      const keepOlderCursor = !older && previous.beforeCursor != null && (incoming.beforeCursor == null || previous.beforeCursor < incoming.beforeCursor);
      return { ...incoming, messages: mergeMessages(previous.messages, incoming.messages), beforeCursor: keepOlderCursor ? previous.beforeCursor : incoming.beforeCursor, hasMore: keepOlderCursor ? previous.hasMore : incoming.hasMore };
    });
    setLoaded(true);
  }, []);

  const refresh = useCallback(async (before?: number) => {
    if (fetching.current || currentSession.current.coordinationEnabled === false) return;
    const actor = currentSession.current, current = generation.current, revision = mutation.current;
    fetching.current = true;
    setLoading(true);
    try {
      await syncProjectCoordination();
      const incoming = await teamCall<TeamBoard>(actor, "team_board", before == null ? {} : { before });
      if (current === generation.current && revision === mutation.current) acceptBoard(incoming, before != null);
    } catch (failure) {
      if (current === generation.current && revision === mutation.current) setError(String(failure));
    } finally {
      if (current === generation.current) { fetching.current = false; setLoading(false); }
    }
  }, [acceptBoard]);

  useEffect(() => {
    generation.current++; fetching.current = false;
    setBoard(null); setLoaded(false); setLoading(false); setSaving(false); setOpen(false); setEditing(false);
    setSelected([session.id]); setRecipient(""); setMessage(""); setSearch(""); setError(""); setNotice(""); setRequestTask(false); sendKey.current = null;
    followBottom.current = true; olderScroll.current = null;
  }, [session.id]);
  useEffect(() => { if (!enabled) { generation.current++; fetching.current = false; setBoard(null); setLoaded(false); setSaving(false); setLoading(false); } }, [enabled]);
  useEffect(() => { if (visible && enabled) void refresh(); }, [session.id, enabled, visible, refresh]);
  useEffect(() => {
    if (!open || !visible || !enabled) return;
    const changed = () => void refresh();
    window.addEventListener("agentdeck-team-changed", changed);
    const timer = setInterval(changed, 5000);
    return () => { window.removeEventListener("agentdeck-team-changed", changed); clearInterval(timer); };
  }, [open, visible, enabled, refresh]);

  useEffect(() => {
    if (!open || !visible) return;
    // Safari may leave focus on the composer when a button is clicked.
    // The explicit opener remains the return target regardless of that policy.
    const opener = trigger.current;
    dialog.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex='0']") || []].filter(element => element.getClientRects().length > 0);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!first || !last) { event.preventDefault(); return; }
      const outside = !dialog.current?.contains(document.activeElement) || document.activeElement === dialog.current;
      if (event.shiftKey && (outside || document.activeElement === first)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (outside || document.activeElement === last)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      if (restoreTriggerFocus.current && currentVisibility.current && opener?.isConnected && opener.getClientRects().length) opener.focus({ preventScroll: true });
    };
  }, [open, visible]);

  useEffect(() => {
    const container = timeline.current;
    if (!container) return;
    if (olderScroll.current) { container.scrollTop = olderScroll.current.top + container.scrollHeight - olderScroll.current.height; olderScroll.current = null; }
    else if (followBottom.current) container.scrollTop = container.scrollHeight;
  }, [board?.messages, editing, open]);
  useEffect(() => {
    const container = timeline.current;
    if (!container || !open || editing) return;
    const observer = new ResizeObserver(() => { if (followBottom.current) container.scrollTop = container.scrollHeight; });
    observer.observe(container);
    return () => observer.disconnect();
  }, [open, editing, board?.team?.id]);
  useEffect(() => {
    if (recipient && board?.team && !board.members.some(member => member.memberId === recipient)) { setRecipient(""); setRequestTask(false); sendKey.current = null; }
  }, [recipient, board?.members]);

  const candidates: Candidate[] = sessions.map(candidate => {
    const workspace = workspaces.find(workspace => workspace.id === candidate.workspaceId);
    return { sessionId: candidate.id, projectPath: projectPath(candidate), projectName: workspace?.name || pathName(candidate.workdir) || candidate.workdir, name: candidate.name, provider: candidate.runner.type, workdir: candidate.worktreePath || candidate.workdir, disabled: candidate.coordinationEnabled === false };
  });
  for (const member of board?.members || []) if (!candidates.some(candidate => candidate.sessionId === member.sessionId)) {
    candidates.push({ sessionId: member.sessionId, projectPath: member.projectPath, projectName: member.projectName || pathName(member.projectPath) || c.unavailable, name: member.name, provider: member.provider, workdir: member.workdir, disabled: false });
  }
  const filteredCandidates = candidates.filter(candidate => `${candidate.name} ${candidate.projectName} ${providerNames[candidate.provider] || candidate.provider}`.toLocaleLowerCase(locale).includes(search.toLocaleLowerCase(locale)));
  const beginEdit = () => {
    setName(board?.team?.name || `${c.team} · ${workspaces.find(workspace => workspace.id === session.workspaceId)?.name || session.name}`);
    setObjective(board?.team?.objective || ""); setAutomatic(board?.team?.automatic ?? true);
    setSelected(board?.team ? board.members.map(member => member.sessionId) : [session.id]);
    setSearch(""); setEditing(true); setError(""); setNotice("");
  };
  useEffect(() => { if (open && loaded && !board?.team && !editing) beginEdit(); }, [open, loaded, board?.team?.id]);
  useEffect(() => { if (board?.team?.id) setEditing(false); }, [board?.team?.id]);

  const mutate = async (operation: () => Promise<TeamBoard | void>, result: string) => {
    if (saving) return;
    const current = generation.current;
    mutation.current++;
    setSaving(true); setError(""); setNotice("");
    try {
      const incoming = await operation();
      if (current !== generation.current) return;
      if (incoming) acceptBoard(incoming);
      setNotice(result);
    } catch (failure) { if (current === generation.current) setError(String(failure)); throw failure; }
    finally { if (current === generation.current) setSaving(false); }
  };
  const saveTeam = async () => {
    if (selected.length < 2 || selected.length > 12) { setError(c.invalid); return; }
    if (nameOverLimit || objectiveOverLimit) { setError(c.limitExceeded); return; }
    const current = generation.current;
    try {
      await mutate(() => configureTeam(session, { ...(board?.team ? { teamId: board.team.id } : {}), name: name.trim(), objective: objective.trim(), automatic, members: candidates.filter(candidate => selected.includes(candidate.sessionId)).map(candidate => ({ projectPath: candidate.projectPath, sessionId: candidate.sessionId })) }), c.saved);
      if (current === generation.current) setEditing(false);
    } catch { /* Keep the form and selection for retry. */ }
  };
  const toggleAutomatic = async () => {
    if (!board?.team) return;
    try { await mutate(() => configureTeam(session, { teamId: board.team!.id, name: board.team!.name, objective: board.team!.objective, automatic: !board.team!.automatic, members: board.members.map(member => ({ projectPath: member.projectPath, sessionId: member.sessionId })) }), c.saved); } catch { /* Preserve the confirmed team state. */ }
  };
  const send = async () => {
    if (!message.trim() || (requestTask && !recipient)) return;
    if (messageOverLimit) { setError(c.limitExceeded); return; }
    const current = generation.current;
    sendKey.current ||= createUuid();
    try {
      await mutate(async () => {
        await teamCall(session, "team_send", { ...(recipient ? { recipientId: recipient } : {}), message: message.trim(), kind: requestTask ? "request" : "update", idempotencyKey: sendKey.current });
        return await teamCall<TeamBoard>(session, "team_board");
      }, c.sent);
      if (current === generation.current) { setMessage(""); sendKey.current = null; followBottom.current = true; jumpToLatest(); }
    } catch { /* Preserve the draft and idempotency key for retry. */ }
  };
  const leave = async () => {
    try { await mutate(async () => { await teamCall(session, "team_leave"); return { team: null, members: [], messages: [] }; }, c.left); setEditing(false); } catch { /* Preserve the current team on failure. */ }
  };
  const projectName = (path: string, fallback?: string) => fallback || workspaces.find(workspace => workspace.path.replace(/\\/g, "/").toLowerCase() === path.replace(/\\/g, "/").toLowerCase())?.name || pathName(path) || c.unavailable;
  const memberName = (id?: string | null) => board?.members.find(member => member.memberId === id)?.name || c.member;
  const deliveryLabels: Record<string, string> = { queued: c.queued, delivered: c.delivered, read: c.read, failed: c.failed };
  const openMember = (sessionId: string) => { restoreTriggerFocus.current = false; setOpen(false); showSessionSurface(sessionId); };

  return <div className="ad-project-coordination">
    <button ref={trigger} type="button" className="ad-team-trigger" aria-label={c.title} aria-expanded={open} aria-haspopup="dialog" onClick={() => { restoreTriggerFocus.current = true; setOpen(true); if (enabled) void refresh(); }}>
      <Users size={14}/><span>{board?.team ? `${c.team} · ${board.members.length} ${c.agents}` : c.connect}</span>{board?.team && <span className="ad-team-indicator" data-active={board.team.automatic}/>}<ChevronDown size={12}/>
    </button>
    {open && visible && createPortal(<div className="ad-team-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) { event.preventDefault(); setOpen(false); } }}>
      <section ref={dialog} className="ad-team-panel" role="dialog" aria-modal="true" aria-label={c.title} tabIndex={-1}>
        <header className="ad-team-header"><div><span className="ad-team-eyebrow"><Users size={13}/>{c.title}</span><h2>{editing ? board?.team ? c.edit : c.create : board?.team?.name || c.connect}</h2></div><div className="ad-team-header-actions"><button type="button" className="ad-team-icon" disabled={loading || saving || !enabled} aria-label={c.refresh} onClick={() => void refresh()}><RefreshCw size={15} className={loading ? "is-spinning" : ""}/></button><button type="button" className="ad-team-icon" aria-label={c.close} onClick={() => setOpen(false)}><X size={18}/></button></div></header>
        {!enabled ? <div className="ad-team-empty"><MessagesSquare size={28}/><p>{c.disabled}</p><button type="button" className="ad-button" onClick={() => useSessionStore.getState().updateSession(session.id, { coordinationEnabled: true })}>{c.enable}</button></div> : !loaded ? <div className="ad-team-empty" role="status">{loading ? c.loading : c.empty}</div> : editing ? <>
          <div className="ad-team-editor">
            <p className="ad-team-description">{c.empty}</p>
            <label>{c.name}<input aria-label={c.name} autoComplete="off" disabled={saving} maxLength={160} value={name} onChange={event => setName(event.target.value)}/><small className="ad-team-limit" data-over={nameOverLimit}>{byteCount(name.trim())}/160 {c.bytes}{nameOverLimit && ` · ${c.limitExceeded}`}</small></label>
            <label>{c.objective}<textarea aria-label={c.objective} rows={3} disabled={saving} maxLength={2000} placeholder={c.objectiveHint} value={objective} onChange={event => setObjective(event.target.value)}/><small className="ad-team-limit" data-over={objectiveOverLimit}>{byteCount(objective.trim())}/2000 {c.bytes}{objectiveOverLimit && ` · ${c.limitExceeded}`}</small></label>
            <div className="ad-team-setting"><label><strong>{c.automatic}</strong><span>{c.automaticHint}</span></label><button type="button" role="switch" aria-label={c.automatic} aria-checked={automatic} disabled={saving} className="ad-team-switch" onClick={() => setAutomatic(value => !value)}><span/></button></div>
            <div className="ad-team-members-heading"><h3>{c.members}</h3><small>{selected.length}/12 {c.selected}</small></div><p className="ad-team-description">{c.choose}</p>
            <label className="ad-team-search"><span className="sr-only">{c.search}</span><input type="search" placeholder={c.search} value={search} onChange={event => setSearch(event.target.value)}/></label>
            <div className="ad-team-candidates">{filteredCandidates.map(candidate => <label key={candidate.sessionId} className="ad-team-candidate"><input type="checkbox" checked={selected.includes(candidate.sessionId)} disabled={candidate.sessionId === session.id || (candidate.disabled && !selected.includes(candidate.sessionId)) || (!selected.includes(candidate.sessionId) && selected.length >= 12)} onChange={event => setSelected(old => event.target.checked ? [...old, candidate.sessionId] : old.filter(id => id !== candidate.sessionId))}/><span><strong>{candidate.name}{candidate.sessionId === session.id && <small>{c.self}</small>}</strong><span>{projectName(candidate.projectPath, candidate.projectName)} · {providerNames[candidate.provider] || candidate.provider}</span>{candidate.disabled && <em>{c.optedOut}</em>}</span></label>)}{!filteredCandidates.length && <p className="ad-team-description">{c.none}</p>}</div>
          </div>
          <footer className="ad-team-editor-actions">{board?.team && <button type="button" className="ad-button ad-button-ghost" disabled={saving} onClick={() => setEditing(false)}><ArrowLeft size={14}/>{c.cancel}</button>}<button type="button" className="ad-button ad-team-primary" disabled={saving || !name.trim() || nameOverLimit || objectiveOverLimit || selected.length < 2 || selected.length > 12} onClick={() => void saveTeam()}><Plus size={14}/>{saving ? c.saving : board?.team ? c.save : c.create}</button></footer>
        </> : board?.team ? <>
          <div className="ad-team-overview"><p className="ad-team-objective">{board.team.objective || c.objectiveHint}</p><div className="ad-team-setting"><div><strong>{c.automatic}</strong><span>{board.team.automatic ? c.automaticOn : c.automaticOff}</span></div><button type="button" role="switch" aria-label={c.automatic} aria-checked={board.team.automatic} className="ad-team-switch" disabled={saving} onClick={() => void toggleAutomatic()}><span/></button></div><p className="ad-team-description">{c.automaticHint}</p></div>
          <details className="ad-team-member-details"><summary><Users size={14}/>{c.members}<small>{board.members.length}</small><ChevronDown size={12}/></summary><div className="ad-team-members">{board.members.map(member => <article key={member.memberId}><div><button type="button" onClick={() => openMember(member.sessionId)}>{member.name}</button><span data-stale={member.stale}>{member.stale ? c.stale : c.states[member.status] || member.status}</span></div><small>{projectName(member.projectPath, member.projectName)} · {providerNames[member.provider] || member.provider}</small><p>{member.summary || member.activity || c.activity}</p><code title={member.workdir}>{member.workdir}</code>{board.claims?.filter(claim => claim.memberId === member.memberId && claim.expiresAt > Date.now()).map(claim => <span className="ad-team-claim" key={`${claim.memberId}:${claim.projectPath || claim.workdir}:${claim.path}`} title={c.claimHint}>{claim.projectPath ? `${projectName(claim.projectPath, claim.projectName)} · ` : ""}{claim.path}</span>)}</article>)}</div><button type="button" className="ad-button ad-button-ghost" disabled={saving} onClick={beginEdit}><Settings2 size={13}/>{c.edit}</button></details>
          <div ref={timeline} className="ad-team-timeline" role="log" aria-label={c.conversation} aria-live="polite" aria-relevant="additions" onScroll={event => { const element = event.currentTarget; followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60; }}>
            {board.hasMore && board.beforeCursor != null && <button type="button" className="ad-button ad-button-ghost ad-team-earlier" disabled={loading} onClick={() => { if (timeline.current) olderScroll.current = { height: timeline.current.scrollHeight, top: timeline.current.scrollTop }; void refresh(board.beforeCursor!); }}>{c.earlier}</button>}
            {!board.messages.length && <div className="ad-team-empty"><MessagesSquare size={24}/><p>{c.noMessages}</p></div>}
            {board.messages.map(note => <article className="ad-team-message" data-own={note.senderId === board.selfId} key={note.seq}><header><strong>{note.senderId === board.selfId ? c.you : note.senderName || memberName(note.senderId)}</strong><span className="ad-team-message-kind" data-kind={note.kind}>{note.kind === "request" ? c.requestLabel : note.kind === "reply" ? c.reply : c.update}</span><time dateTime={new Date(note.createdAt).toISOString()}>{new Date(note.createdAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</time></header>{note.recipientId && <small>{c.to} {memberName(note.recipientId)}</small>}<p>{note.message}</p>{note.deliveryStatus && deliveryLabels[note.deliveryStatus] && <footer data-failed={note.deliveryStatus === "failed"}>{deliveryLabels[note.deliveryStatus]}</footer>}</article>)}
          </div>
          <form className="ad-team-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
            <div>
              <label><span className="sr-only">{c.recipient}</span><select aria-label={c.recipient} disabled={saving} value={recipient} onChange={event => { setRecipient(event.target.value); if (!event.target.value) setRequestTask(false); sendKey.current = null; }}><option value="">{c.everyone}</option>{board.members.filter(member => member.memberId !== board.selfId).map(member => <option key={member.memberId} value={member.memberId}>{member.name} · {projectName(member.projectPath, member.projectName)}</option>)}</select></label>
              <label className="ad-team-request" title={!recipient ? c.requestHint : undefined}><input type="checkbox" checked={requestTask} disabled={!recipient || saving} onChange={event => { setRequestTask(event.target.checked); sendKey.current = null; }}/>{c.request}</label>
            </div>
            <label><span className="sr-only">{c.message}</span><textarea aria-label={c.message} rows={2} disabled={saving} maxLength={3000} placeholder={c.message} value={message} onChange={event => { setMessage(event.target.value); sendKey.current = null; }}/></label>
            {message && <small className="ad-team-limit" data-over={messageOverLimit}>{byteCount(message.trim())}/3000 {c.bytes}{messageOverLimit && ` · ${c.limitExceeded}`}</small>}
            <div className="ad-team-composer-actions"><button type="button" className="ad-team-leave" disabled={saving} onClick={() => void leave()}>{c.leave}</button><button type="submit" className="ad-button ad-team-primary" disabled={saving || !message.trim() || messageOverLimit || (requestTask && !recipient)}><Send size={14}/>{c.send}</button></div>
          </form>
        </> : <div className="ad-team-empty"><p>{c.empty}</p><button type="button" className="ad-button" onClick={beginEdit}>{c.create}</button></div>}
        {(error || notice) && <div className="ad-team-feedback">{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}</div>}
      </section>
    </div>, document.body)}
  </div>;
}
