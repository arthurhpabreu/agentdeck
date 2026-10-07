import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUp } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { useAgentActivityStore, emptyActivity } from "../../store/agentActivityStore";
import { useSessionStore } from "../../store/sessionStore";
import { CommandTextarea } from "./CommandTextarea";

export function SessionFollowup({ sessionId, visible = true }: { sessionId: string; visible?: boolean }) {
  const { t } = useAppI18n();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const activity = useAgentActivityStore(s => s.sessions[sessionId] ?? emptyActivity);
  const session = useSessionStore(s => s.sessions.find(session => session.id === sessionId));
  const live = !!activity.startedAt && !activity.endedAt;
  // Once the process has ended the terminal shows its own restart action; a dead input box would only repeat it.
  if (activity.endedAt || !session) return null;
  const send = async () => {
    if (!live || sending || !draft.trim()) return;
    setSending(true); setError("");
    try {
      await invoke("send_pty_query", { sessionId, query: draft });
      useAgentActivityStore.getState().record(sessionId, {}, "activity.sent");
      setDraft("");
    } catch (e) { setError(String(e)); } finally { setSending(false); }
  };
  return <div className="ad-followup">
    <div className="ad-composer">
      <CommandTextarea visible={visible} runner={session.runner} workdir={session.worktreePath || session.workdir} projectPath={session.workdir} native rows={1} value={draft} onValueChange={setDraft} disabled={!live || sending}
        aria-label={t("chat.followup")} placeholder={t(live ? "chat.followup" : "activity.starting")}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
      <button className="ad-button ad-button-primary ad-send-button" aria-label={t(sending ? "chat.sending" : "chat.send")} title={t("chat.send")} disabled={!live || sending || !draft.trim()} onClick={() => void send()}><ArrowUp size={16} /></button>
    </div>
    <p className="ad-hint">{t("chat.keyboardHint")} · {t("chat.followupHint")}</p>
    {error && <div className="ad-notice" role="alert" style={{ margin: "8px 0 0" }}>{error}</div>}
  </div>;
}
