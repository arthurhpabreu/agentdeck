import { memo } from "react";
import { Paperclip } from "lucide-react";
import { useAppI18n } from "../../i18n";
import type { ClaudeSession } from "../../store/sessionStore";
import type { ChatMessage } from "../../store/chatStore";
import { RUNNER_LABELS } from "../../store/settingsStore";
import { ProviderIcon } from "../ProviderIcon";
import { SaveResponseToMemory } from "../memory/SaveResponseToMemory";
import { ChatMarkdown, CopyButton } from "./ChatMarkdown";
import { ChatToolCard } from "./ChatToolCard";
import { ChatUserText } from "./ChatUserText";
import { chatCopy } from "./chatCopy";
import { workflowCopy } from "./workflowCopy";

export const ChatMessageRow = memo(function ChatMessageRow({ message, session, busy, turnId, onError }: {
  message: ChatMessage; session: ClaudeSession; busy: boolean; turnId?: string; onError: (error: string) => void;
}) {
  const { locale } = useAppI18n(), c = chatCopy(locale), w = workflowCopy(locale);
  return message.role === "tool" ? <ChatToolCard message={message} active={busy && message.turnId === turnId} /> : <article className={`ad-message ad-message-${message.role}`}>
          <div className="ad-message-meta">{message.role === "assistant" ? <ProviderIcon provider={session.runner.type} size={19} /> : <span className="ad-user-avatar">{message.origin === "team" ? "↔" : c.you.slice(0, 1)}</span>}<strong>{message.origin === "team" ? (locale.startsWith("pt") ? "Equipe de agentes" : locale.startsWith("es") ? "Equipo de agentes" : "Agent team") : message.role === "user" ? c.you : RUNNER_LABELS[session.runner.type]}</strong>{message.parentId && <small className="ad-subagent-label" title={message.parentId}>{locale.startsWith("en") ? "Subagent" : "Subagente"} · {message.parentId.slice(-6)}</small>}<time>{new Date(message.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</time><CopyButton text={message.text} />{message.role === "assistant" && <SaveResponseToMemory session={session} text={message.text} disabled={busy} onError={onError} />}</div>
          <div className="ad-message-body">{message.role === "assistant" ? <ChatMarkdown text={message.text} sessionId={session.id} /> : <ChatUserText text={message.text} />}{message.role === "user" && message.status && <small className="ad-supplement-status" role="status" title={message.title}>{message.status === "accepted" ? w.accepted : message.status === "failed" ? w.failed : message.status === "queued" ? w.queued : w.sending}</small>}{!!message.attachments?.length && <div className="ad-message-files">{message.attachments.map((file, index) => <span key={index}><Paperclip size={13} />{file.name}</span>)}</div>}</div>
        </article>;
});
