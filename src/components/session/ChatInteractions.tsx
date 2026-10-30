import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ShieldCheck, MessageCircleQuestion } from "lucide-react";
import { useAppI18n } from "../../i18n";
import type { ChatInteraction } from "../../services/chatInteraction";
import { useChatStore } from "../../store/chatStore";
import { recordChatAttention } from "../../store/attentionStore";

export function ChatInteractions({ sessionId, turnId, requests }: { sessionId: string; turnId: string; requests: ChatInteraction[] }) {
  return <div className="ad-chat-interactions">{requests.map(request => <Interaction key={request.id} sessionId={sessionId} turnId={turnId} request={request} />)}</div>;
}
function Interaction({ sessionId, turnId, request }: { sessionId: string; turnId: string; request: ChatInteraction }) {
  const { locale } = useAppI18n();
  const pt = locale.startsWith("pt"), es = locale.startsWith("es");
  const c = pt ? { approval: "Aprovação necessária", question: "O agente tem uma pergunta", waiting: "Esta ação aguarda sua decisão.", optional: "Pergunta opcional: o agente pode continuar enquanto você responde.", accept: "Aprovar esta ação", deny: "Recusar e parar", send: "Enviar resposta", choose: "Selecione uma opção", answer: "Sua resposta" }
    : es ? { approval: "Aprobación necesaria", question: "El agente tiene una pregunta", waiting: "Esta acción espera tu decisión.", optional: "Pregunta opcional: el agente puede continuar mientras respondes.", accept: "Aprobar esta acción", deny: "Rechazar y detener", send: "Enviar respuesta", choose: "Selecciona una opción", answer: "Tu respuesta" }
    : { approval: "Approval required", question: "The agent has a question", waiting: "This action is waiting for your decision.", optional: "Optional question: the agent may continue while you answer.", accept: "Approve this action", deny: "Decline and stop", send: "Send answer", choose: "Choose an option", answer: "Your answer" };
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const changes = useChatStore(state => request.action === "fileChange" && request.itemId ? state.threads[sessionId]?.messages.find(message => message.turnId === turnId && message.role === "tool" && message.id.endsWith(`:${request.itemId}`))?.text : undefined);
  const [sending, setSending] = useState(false), [error, setError] = useState("");
  const respond = async (response: object) => {
    if (sending) return; setSending(true); setError("");
    try {
      await invoke("respond_chat_interaction", { sessionId, turnId, requestId: request.id, response });
      const current = useChatStore.getState().threads[sessionId];
      if (current?.turnId === turnId && current.interactions?.some(item => item.id === request.id)) {
        useChatStore.getState().patch(sessionId, { interactions: current.interactions.filter(item => item.id !== request.id) });
        recordChatAttention({ sessionId, turnId, kind: "interaction", status: "resolved", itemId: request.id });
      }
    }
    catch (failure) { setError(String(failure)); setSending(false); }
  };
  return <section className="ad-chat-interaction" aria-label={request.kind === "approval" ? c.approval : c.question}>
    <strong>{request.kind === "approval" ? <ShieldCheck size={16} /> : <MessageCircleQuestion size={16} />}{request.kind === "approval" ? c.approval : c.question}</strong>
    <p>{request.blocking ? c.waiting : c.optional}</p>
    {request.reason && <p>{request.reason}</p>}{request.command && <pre>{request.command}</pre>}{request.cwd && <small>{request.cwd}</small>}
    {request.action === "fileChange" && <p>{pt ? "Alteração de arquivos" : es ? "Cambio de archivos" : "File changes"}</p>}
    {request.action === "permissions" && <p>{pt ? "Permissões adicionais somente para esta resposta. Recusar não interrompe o agente." : es ? "Permisos adicionales solo para esta respuesta. Rechazar no detiene al agente." : "Additional permissions for this response only. Declining does not stop the agent."}</p>}
    {request.grantRoot && <p>{pt ? "Pasta solicitada" : es ? "Carpeta solicitada" : "Requested directory"}: <code>{request.grantRoot}</code></p>}
    {changes && <pre>{changes}</pre>}
    {request.kind === "approval" ? <div className="ad-chat-interaction-actions"><button className="ad-button ad-button-primary" disabled={sending} onClick={() => void respond({ decision: "accept" })}>{c.accept}</button>{request.action === "permissions"
      ? <button className="ad-button" disabled={sending} onClick={() => void respond({ decision: "decline" })}>{pt ? "Recusar" : es ? "Rechazar" : "Decline"}</button>
      : <button className="ad-button" disabled={sending} onClick={() => void respond({ decision: "cancel" })}>{c.deny}</button>}</div>
      : <form onSubmit={event => { event.preventDefault(); void respond({ answers: Object.fromEntries((request.questions ?? []).map(question => [question.id, { answers: [answers[question.id]] }])) }); }}>
        {(request.questions ?? []).map(question => <label key={question.id}><span>{question.question}</span>
          {question.options?.length && !question.isSecret ? <select required aria-label={question.question} value={answers[question.id] ?? ""} disabled={sending} onChange={event => setAnswers(old => ({ ...old, [question.id]: event.target.value }))}><option value="">{c.choose}</option>{question.options.map(option => <option key={option.label} value={option.label}>{option.label} — {option.description}</option>)}</select>
            : <input required type={question.isSecret ? "password" : "text"} autoComplete="off" aria-label={question.question} placeholder={c.answer} value={answers[question.id] ?? ""} disabled={sending} onChange={event => setAnswers(old => ({ ...old, [question.id]: event.target.value }))} />}
        </label>)}<button className="ad-button ad-button-primary" disabled={sending || !(request.questions?.length) || request.questions.some(question => !answers[question.id]?.trim())}>{c.send}</button>
      </form>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
