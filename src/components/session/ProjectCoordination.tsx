import { useEffect, useRef, useState } from "react";
import { MessagesSquare, RefreshCw } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { useSessionStore, type ClaudeSession } from "../../store/sessionStore";
import { coordinationCall, syncProjectCoordination, type ProjectNote, type ProjectPeer } from "../../services/projectCoordination";
import { showSessionSurface } from "../../services/workbenchCommands";
import "./projectCoordination.css";

const copies = {
  pt: { title:"Chats do projeto", enabled:"Compartilhar atividade e receber notas", hint:"Atividade e notas curtas entre chats deste projeto. Mensagens ficam na caixa de entrada para consulta do agente.", refresh:"Atualizar coordenação", peers:"Outros chats", empty:"Nenhum outro chat disponível neste projeto.", stale:"Atividade desatualizada", inbox:"Notas recebidas", send:"Enviar nota", recipient:"Chat de destino", message:"Nota de coordenação", sent:"Nota guardada na caixa de entrada do chat.", summary:"Meu resumo de trabalho", save:"Salvar resumo", saved:"Resumo salvo.", disable:"A coordenação está desativada para este chat.", previous:"Ler notas anteriores", next:"Mais notas" },
  en: { title:"Project chats", enabled:"Share activity and receive notes", hint:"Activity and short notes between chats in this project. Messages stay in the inbox for the agent to consult.", refresh:"Refresh coordination", peers:"Other chats", empty:"No other chats available in this project.", stale:"Activity is stale", inbox:"Received notes", send:"Send note", recipient:"Recipient chat", message:"Coordination note", sent:"Note stored in the chat inbox.", summary:"My work summary", save:"Save summary", saved:"Summary saved.", disable:"Coordination is disabled for this chat.", previous:"Read earlier notes", next:"More notes" },
  es: { title:"Chats del proyecto", enabled:"Compartir actividad y recibir notas", hint:"Actividad y notas breves entre chats de este proyecto. Los mensajes quedan en la bandeja para consulta del agente.", refresh:"Actualizar coordinación", peers:"Otros chats", empty:"No hay otros chats disponibles en este proyecto.", stale:"Actividad desactualizada", inbox:"Notas recibidas", send:"Enviar nota", recipient:"Chat de destino", message:"Nota de coordinación", sent:"Nota guardada en la bandeja del chat.", summary:"Mi resumen de trabajo", save:"Guardar resumen", saved:"Resumen guardado.", disable:"La coordinación está desactivada para este chat.", previous:"Leer notas anteriores", next:"Más notas" },
};
export function ProjectCoordination({ session, visible }: { session: ClaudeSession; visible: boolean }) {
  const { locale } = useAppI18n(); const c = locale.startsWith("pt") ? copies.pt : locale.startsWith("es") ? copies.es : copies.en;
  const enabled = session.coordinationEnabled !== false;
  const [open, setOpen] = useState(false); const [peers, setPeers] = useState<ProjectPeer[]>([]); const [notes, setNotes] = useState<ProjectNote[]>([]); const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [recipient, setRecipient] = useState(""); const [message, setMessage] = useState(""); const [summary, setSummary] = useState("");
  const [pending, setPending] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const cursor = useRef(0); const generation = useRef(0);
  useEffect(() => { generation.current++; cursor.current = 0; setPeers([]); setNotes([]); setNextOffset(null); setMessage(""); setSummary(""); setError(""); setNotice(""); setPending(false); }, [session.id, enabled]);
  const refresh = async (reset = false) => {
    const current = generation.current;
    setPending(true); setError("");
    try {
      await syncProjectCoordination();
      const [board, inbox] = await Promise.all([
        coordinationCall<{ peers: ProjectPeer[]; nextOffset?: number | null }>(session, "project_peers"),
        coordinationCall<{ messages: ProjectNote[]; cursor: number }>(session, "project_inbox", { after: reset ? 0 : cursor.current }),
      ]);
      if (current !== generation.current) return;
      setPeers(board.peers); setNextOffset(board.nextOffset ?? null); cursor.current = inbox.cursor;
      setNotes(old => [...new Map([...(reset ? [] : old), ...inbox.messages].map(note => [note.seq, note])).values()].slice(-100));
      setRecipient(old => board.peers.some(peer => peer.sessionId === old) ? old : board.peers[0]?.sessionId || "");
    } catch (failure) { if (current === generation.current) setError(String(failure)); }
    finally { if (current === generation.current) setPending(false); }
  };
  useEffect(() => { if (open && visible && enabled) void refresh(); }, [open, visible, enabled, session.id]);
  const morePeers = async () => {
    if (nextOffset === null || pending) return;
    const current = generation.current; setPending(true); setError("");
    try {
      const board = await coordinationCall<{ peers: ProjectPeer[]; nextOffset: number | null }>(session, "project_peers", { offset:nextOffset });
      if (current === generation.current) { setPeers(old => [...new Map([...old, ...board.peers].map(peer => [peer.sessionId, peer])).values()]); setNextOffset(board.nextOffset); }
    } catch (failure) { if (current === generation.current) setError(String(failure)); }
    finally { if (current === generation.current) setPending(false); }
  };
  const action = async (name: string, input: Record<string, unknown>, result: string) => {
    const current = generation.current; setPending(true); setError(""); setNotice("");
    try { await syncProjectCoordination(); await coordinationCall(session, name, input); if (current === generation.current) { setNotice(result); if (name === "project_send") setMessage(""); } }
    catch (failure) { if (current === generation.current) setError(String(failure)); }
    finally { if (current === generation.current) setPending(false); }
  };
  return <div className="ad-project-coordination">
    <button type="button" className="ad-button ad-button-ghost" aria-expanded={open} onClick={() => setOpen(value => !value)}><MessagesSquare size={14}/>{c.title}</button>
    {open && <section aria-label={c.title}>
      <label><input type="checkbox" checked={enabled} onChange={event => useSessionStore.getState().updateSession(session.id, { coordinationEnabled: event.target.checked })}/>{c.enabled}</label>
      {enabled ? <>
        <p className="ad-hint">{c.hint}</p>
        <button type="button" className="ad-button ad-button-ghost" disabled={pending} onClick={() => void refresh()}><RefreshCw size={13}/>{c.refresh}</button>
        <h4>{c.peers}</h4>
        {!peers.length && <p className="ad-hint">{c.empty}</p>}
        <ul>{peers.map(peer => <li key={peer.sessionId}><button type="button" onClick={() => showSessionSurface(peer.sessionId)}>{peer.name}</button><small>{peer.provider} · {peer.status}{peer.stale ? ` · ${c.stale}` : ""}</small><p>{peer.summary || peer.activity}</p><code title={peer.workdir}>{peer.workdir}</code></li>)}</ul>
        {nextOffset !== null && <button type="button" className="ad-button ad-button-ghost" disabled={pending} onClick={() => void morePeers()}>{c.peers} +</button>}
        <label>{c.summary}<textarea rows={2} value={summary} onChange={event => setSummary(event.target.value)}/></label>
        <button type="button" className="ad-button" disabled={pending || !summary.trim()} onClick={() => void action("project_status", { summary }, c.saved)}>{c.save}</button>
        {!!peers.length && <div className="ad-project-note-form"><label>{c.recipient}<select value={recipient} onChange={event => setRecipient(event.target.value)}>{peers.map(peer => <option key={peer.sessionId} value={peer.sessionId}>{peer.name}</option>)}</select></label><label>{c.message}<textarea rows={2} value={message} onChange={event => setMessage(event.target.value)}/></label><button type="button" className="ad-button" disabled={pending || !recipient || !message.trim()} onClick={() => void action("project_send", { sessionId:recipient, message }, c.sent)}>{c.send}</button></div>}
        <h4>{c.inbox}</h4>
        <ol>{notes.map(note => <li key={note.seq}><small>{peers.find(peer => peer.sessionId === note.sender)?.name || note.sender} · {new Date(note.createdAt).toLocaleString(locale)}</small><p>{note.message}</p></li>)}</ol>
        <button type="button" className="ad-button ad-button-ghost" disabled={pending} onClick={() => void refresh(true)}>{c.previous}</button><button type="button" className="ad-button ad-button-ghost" disabled={pending} onClick={() => void refresh()}>{c.next}</button>
      </> : <p className="ad-hint">{c.disable}</p>}
      {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    </section>}
  </div>;
}
