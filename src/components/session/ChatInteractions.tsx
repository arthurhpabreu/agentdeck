import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ShieldCheck, MessageCircleQuestion, ClipboardList } from "lucide-react";
import { useAppI18n } from "../../i18n";
import type { ChatInteraction } from "../../services/chatInteraction";
import { useChatStore } from "../../store/chatStore";
import { useSessionStore } from "../../store/sessionStore";
import { recordChatAttention } from "../../store/attentionStore";
import { ChatMarkdown } from "./ChatMarkdown";

const copy = {
  pt: { approval: "Aprovação necessária", question: "O agente tem uma pergunta", plan: "Plano pronto para revisão", waiting: "Esta ação aguarda sua decisão.", optional: "Pergunta opcional: o agente pode continuar enquanto você responde.", accept: "Aprovar esta ação", session: "Aprovar nesta sessão", decline: "Recusar e continuar", deny: "Recusar e parar", declineOnly: "Recusar", approvePlan: "Aprovar plano", keepPlanning: "Continuar planejando", planHint: "Ao aprovar, o agente sai do modo planejamento e começa a implementar este plano.", send: "Enviar resposta", choose: "Selecione uma opção", answer: "Sua resposta", files: "Alteração de arquivos", permissions: "Permissões adicionais somente para esta resposta. Recusar não interrompe o agente.", folder: "Pasta solicitada", subagent: "Subagente" },
  es: { approval: "Aprobación necesaria", question: "El agente tiene una pregunta", plan: "Plan listo para revisar", waiting: "Esta acción espera tu decisión.", optional: "Pregunta opcional: el agente puede continuar mientras respondes.", accept: "Aprobar esta acción", session: "Aprobar en esta sesión", decline: "Rechazar y continuar", deny: "Rechazar y detener", declineOnly: "Rechazar", approvePlan: "Aprobar plan", keepPlanning: "Seguir planificando", planHint: "Al aprobar, el agente sale del modo planificación y empieza a implementar este plan.", send: "Enviar respuesta", choose: "Selecciona una opción", answer: "Tu respuesta", files: "Cambio de archivos", permissions: "Permisos adicionales solo para esta respuesta. Rechazar no detiene al agente.", folder: "Carpeta solicitada", subagent: "Subagente" },
  en: { approval: "Approval required", question: "The agent has a question", plan: "Plan ready for review", waiting: "This action is waiting for your decision.", optional: "Optional question: the agent may continue while you answer.", accept: "Approve this action", session: "Approve for this session", decline: "Decline and continue", deny: "Decline and stop", declineOnly: "Decline", approvePlan: "Approve plan", keepPlanning: "Keep planning", planHint: "Approving lets the agent leave plan mode and start implementing this plan.", send: "Send answer", choose: "Choose an option", answer: "Your answer", files: "File changes", permissions: "Additional permissions for this response only. Declining does not stop the agent.", folder: "Requested directory", subagent: "Subagent" },
};

export function ChatInteractions({ sessionId, turnId, requests }: { sessionId: string; turnId: string; requests: ChatInteraction[] }) {
  return <div className="ad-chat-interactions">{requests.map(request => <Interaction key={request.id} sessionId={sessionId} turnId={turnId} request={request} />)}</div>;
}
function Interaction({ sessionId, turnId, request }: { sessionId: string; turnId: string; request: ChatInteraction }) {
  const { locale } = useAppI18n();
  const c = copy[locale.startsWith("pt") ? "pt" : locale.startsWith("es") ? "es" : "en"];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const changes = useChatStore(state => request.action === "fileChange" && request.itemId ? state.threads[sessionId]?.messages.find(message => message.turnId === turnId && message.role === "tool" && message.id.endsWith(`:${request.itemId}`))?.text : undefined);
  const [sending, setSending] = useState(false), [error, setError] = useState("");
  const plan = request.action === "plan";
  // Codex can always approve for the session; Claude only when it proposes a rule to remember.
  const remember = request.provider === "claude-code" ? !!request.canRemember : !plan;
  const respond = async (response: { decision?: string; answers?: object }) => {
    if (sending) return; setSending(true); setError("");
    try {
      await invoke("respond_chat_interaction", { sessionId, turnId, requestId: request.id, response });
      // An approved plan ends plan mode, as in Claude Code, so later turns can implement it.
      if (plan && response.decision === "accept") { const session = useSessionStore.getState().sessions.find(item => item.id === sessionId); if (session?.runner.mode === "plan") useSessionStore.getState().updateSession(sessionId, { runner: { ...session.runner, mode: "default" } }); }
      const current = useChatStore.getState().threads[sessionId];
      if (current?.turnId === turnId && current.interactions?.some(item => item.id === request.id)) {
        useChatStore.getState().patch(sessionId, { interactions: current.interactions.filter(item => item.id !== request.id) });
        recordChatAttention({ sessionId, turnId, kind: "interaction", status: "resolved", itemId: request.id });
      }
    }
    catch (failure) { setError(String(failure)); setSending(false); }
  };
  const heading = plan ? c.plan : request.kind === "approval" ? c.approval : c.question;
  return <section className="ad-chat-interaction" aria-label={heading}>
    <strong>{plan ? <ClipboardList size={16} /> : request.kind === "approval" ? <ShieldCheck size={16} /> : <MessageCircleQuestion size={16} />}{heading}{request.title && !plan && <code>{request.title}</code>}{request.subagent && <small className="ad-subagent-label">{c.subagent}</small>}</strong>
    <p>{plan ? c.planHint : request.blocking ? c.waiting : c.optional}</p>
    {request.reason && <p>{request.reason}</p>}
    {request.command && (plan ? <div className="ad-chat-interaction-plan"><ChatMarkdown text={request.command} sessionId={sessionId} /></div> : <pre>{request.command}</pre>)}{request.cwd && <small>{request.cwd}</small>}
    {request.action === "fileChange" && <p>{c.files}</p>}
    {request.action === "permissions" && <p>{c.permissions}</p>}
    {request.grantRoot && <p>{c.folder}: <code>{request.grantRoot}</code></p>}
    {changes && <pre>{changes}</pre>}
    {request.kind === "approval" ? <div className="ad-chat-interaction-actions">
      {plan ? <>
        <button className="ad-button ad-button-primary" disabled={sending} onClick={() => void respond({ decision: "accept" })}>{c.approvePlan}</button>
        <button className="ad-button" disabled={sending} onClick={() => void respond({ decision: "decline" })}>{c.keepPlanning}</button>
      </> : <>
        <button className="ad-button ad-button-primary" disabled={sending} onClick={() => void respond({ decision: "accept" })}>{c.accept}</button>
        {remember && <button className="ad-button" disabled={sending} onClick={() => void respond({ decision: "acceptForSession" })}>{c.session}</button>}
        {request.action === "permissions"
          ? <button className="ad-button" disabled={sending} onClick={() => void respond({ decision: "decline" })}>{c.declineOnly}</button>
          : <>
            <button className="ad-button" disabled={sending} onClick={() => void respond({ decision: "decline" })}>{c.decline}</button>
            <button className="ad-button" disabled={sending} onClick={() => void respond({ decision: "cancel" })}>{c.deny}</button>
          </>}
      </>}
    </div>
      : <form onSubmit={event => { event.preventDefault(); void respond({ answers: Object.fromEntries((request.questions ?? []).map(question => [question.id, { answers: [answers[question.id]] }])) }); }}>
        {(request.questions ?? []).map(question => <label key={question.id}><span>{question.question}</span>
          {question.options?.length && !question.isSecret ? <select required aria-label={question.question} value={answers[question.id] ?? ""} disabled={sending} onChange={event => setAnswers(old => ({ ...old, [question.id]: event.target.value }))}><option value="">{c.choose}</option>{question.options.map(option => <option key={option.label} value={option.label}>{option.label} — {option.description}</option>)}</select>
            : <input required type={question.isSecret ? "password" : "text"} autoComplete="off" aria-label={question.question} placeholder={c.answer} value={answers[question.id] ?? ""} disabled={sending} onChange={event => setAnswers(old => ({ ...old, [question.id]: event.target.value }))} />}
        </label>)}<button className="ad-button ad-button-primary" disabled={sending || !(request.questions?.length) || request.questions.some(question => !answers[question.id]?.trim())}>{c.send}</button>
      </form>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
