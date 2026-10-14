import { useEffect } from "react";
import { TerminalSquare, X } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { dismissMcpAuthWarning } from "../../store/chatStore";
import { contextCopy } from "./contextCopy";
import { chatCopy } from "./chatCopy";

/** A live error notice expires at receipt time, including while its chat is hidden. */
export function McpAuthNotice({ sessionId, warning, deadline, busy, onNative }: {
  sessionId: string; warning?: string; deadline?: number; busy: boolean; onNative: () => void;
}) {
  const { locale } = useAppI18n();
  const c = contextCopy(locale), chat = chatCopy(locale);
  useEffect(() => {
    if (!warning || deadline === undefined) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) { dismissMcpAuthWarning(sessionId, deadline); return; }
    const timer = setTimeout(() => dismissMcpAuthWarning(sessionId, deadline), remaining);
    return () => clearTimeout(timer);
  }, [sessionId, warning, deadline]);
  if (!warning || deadline === undefined || deadline <= Date.now()) return null;
  return <div className="ad-chat-warning" role="status">
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <strong>{c.mcpWarning}</strong>
      <button type="button" className="ad-icon-button" style={{ marginTop: 0, width: 24, height: 24 }} aria-label={c.dismissMcpWarning} title={c.dismissMcpWarning} onClick={() => dismissMcpAuthWarning(sessionId, deadline)}><X size={14} /></button>
    </div>
    <p>{warning}</p><small>{c.mcpHint}</small>
    <button type="button" className="ad-button ad-button-ghost" disabled={busy} onClick={onNative}><TerminalSquare size={14} />{chat.native}</button>
  </div>;
}
