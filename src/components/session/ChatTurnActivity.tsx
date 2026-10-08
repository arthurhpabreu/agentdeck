import { useEffect, useState } from "react";
import { Activity, LoaderCircle, RefreshCw, Square } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { refreshChatTurnStatus, stopChatTurn, type ChatThread } from "../../store/chatStore";
import { chatActivityCopy } from "./chatActivityCopy";
import { chatCopy } from "./chatCopy";
import { contextCopy } from "./contextCopy";
import "./chatActivity.css";

const SILENCE_NOTICE_MS = 120_000;
const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export function ChatTurnActivity({ thread, sessionId, visible }: { thread: ChatThread; sessionId: string; visible: boolean }) {
  const { locale } = useAppI18n(); const c = chatActivityCopy(locale);
  const [now, setNow] = useState(Date.now()); const [checking, setChecking] = useState(false); const [checkNotice, setCheckNotice] = useState("");
  useEffect(() => { setNow(Date.now()); if (!visible) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [visible, thread.turnId]);
  const started = thread.turnStartedAt ?? thread.messages.find(m => m.turnId === thread.turnId)?.at ?? now;
  const lastActivity = thread.lastEventAt ?? started;
  const elapsed = Math.max(0, Math.floor((now - started) / 1000));
  const silent = now - lastActivity >= SILENCE_NOTICE_MS;
  useEffect(() => {
    if (!visible || !silent) return;
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void refreshChatTurnStatus(sessionId).catch(() => { /* Manual verification stays available. */ }).finally(() => { pending = false; });
    }, 15_000);
    return () => clearInterval(timer);
  }, [visible, silent, sessionId]);
  const activeTools = thread.messages.filter(m => m.turnId === thread.turnId && m.role === "tool" && ["running", "in_progress", "inProgress", "started"].includes(m.status ?? "running"));
  const latestTool = activeTools[activeTools.length - 1];
  const label = thread.compacting ? contextCopy(locale).compacting : thread.status === "blocked" ? c.blocked : thread.status === "reasoning" ? c.thinking : latestTool ? `${latestTool.title || c.command} · ${c.running}` : thread.status === "finishing" ? c.finishing : thread.status === "responding" ? c.responding : thread.status === "starting" ? c.starting : c.working;
  const detail = latestTool?.command || thread.activity;
  const check = async () => {
    setChecking(true); setCheckNotice("");
    try { const status = await refreshChatTurnStatus(sessionId); if (status?.running) setCheckNotice(c.alive); }
    catch { setCheckNotice(c.checkFailed); }
    finally { setChecking(false); }
  };
  return <div className={`ad-turn-activity ${silent ? "is-silent" : ""}`}>
    <div className="ad-chat-progress" role="status"><LoaderCircle size={16} className="ad-spin" /><span>{label}</span><time>{duration(elapsed)}</time></div>
    <div className="ad-turn-activity-detail"><Activity size={12} /><span title={detail}>{detail || c.activity}</span>{thread.pid && <code>{c.pid} {thread.pid}</code>}<small title={c.lastUpdate}>{Math.max(0, Math.floor((now - lastActivity) / 1000))}{c.seconds} {c.ago}</small></div>
    {silent && <div className="ad-chat-stall"><p><strong>{c.silent} {duration(Math.max(0, Math.floor((now - lastActivity) / 1000)))}</strong><span>{c.silentHint}</span></p><div><button type="button" className="ad-button ad-button-ghost" disabled={checking} onClick={() => void check()}><RefreshCw size={13} className={checking ? "ad-spin" : ""} />{checking ? c.checking : c.check}</button><button type="button" className="ad-button ad-button-ghost" onClick={() => void stopChatTurn(sessionId)}><Square size={12} />{chatCopy(locale).stop}</button></div>{checkNotice && <small role="status">{checkNotice}</small>}</div>}
  </div>;
}
