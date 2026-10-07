import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Activity, Square } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { useAgentActivityStore, emptyActivity } from "../../store/agentActivityStore";
import { getAgentAdapter, createAgentSessionArgs } from "../../services/agentAdapters";
import type { ClaudeSession } from "../../store/sessionStore";
import { useSessionStore } from "../../store/sessionStore";
import { usePtyRuntimeStore } from "../../store/ptyRuntimeStore";
import { AgentEffortControl } from "./AgentEffortControl";

export function AgentSessionToolbar({ session, visible, onStop }: { session: ClaudeSession; visible: boolean; onStop: () => void }) {
  const { t, locale } = useAppI18n();
  const activity = useAgentActivityStore(s => s.sessions[session.id] ?? emptyActivity);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState("");
  const runtime = usePtyRuntimeStore(s => s.sessions[session.id]);
  const live = !!activity.startedAt && !activity.endedAt;
  useEffect(() => {
    if (!visible || !live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible, live]);
  // Before the first launch the welcome composer explains everything; a bar of disabled controls only adds noise.
  if (activity.phase === "idle" && !activity.error) return null;
  const seconds = activity.startedAt ? Math.max(0, Math.floor(((activity.endedAt ?? now) - activity.startedAt) / 1000)) : 0;
  const command = async (value: string) => {
    if (!value) return;
    try { setError(""); await invoke("send_pty_query", { sessionId: session.id, query: value }); }
    catch (e) { setError(String(e)); }
  };
  return <>
    <div className="ad-session-toolbar">
      <span className="ad-status" role="status">
        <i className="ad-status-dot" data-phase={activity.phase} /><span>{t(`activity.${activity.phase}`)}</span>
        {activity.startedAt && <time>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</time>}
      </span>
      <span style={{ flex: 1 }} />
      <AgentEffortControl runner={session.runner} workdir={session.workdir} native disabled={!!runtime} onChange={patch => useSessionStore.getState().updateSession(session.id, { runner: { ...session.runner, ...patch } })} />
      {live && <label className="ad-field"><select aria-label={t("chat.commands")} value="" onChange={e => void command(e.target.value)}><option value="">{t("chat.commands")}</option>{getAgentAdapter(session.runner.type).commands.map(c => <option key={c} value={c}>{c}</option>)}</select></label>}
      <button className="ad-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><Activity size={14} />{t("activity.title")}</button>
      {live && <button className="ad-button ad-button-stop" title={t("activity.stop")} aria-label={t("activity.stop")} onClick={onStop}><Square size={13} />{t("activity.stopShort")}</button>}
    </div>
    {(error || activity.error) && <div className="ad-notice" role="alert" style={{ margin: 0, borderRadius: 0 }}>{error || activity.error}</div>}
    {expanded && <section className="ad-activity" aria-label={t("activity.title")}>
      <dl>
        <dt>{t("activity.process")}</dt><dd>{activity.pid ? `PID ${activity.pid}` : t("activity.notStarted")}</dd>
        <dt>{t("activity.command")}</dt><dd><code>{[activity.command ?? getAgentAdapter(session.runner.type).executable, ...createAgentSessionArgs(session.runner.type, session.providerSessionId, session.runner.model, session.runner.mode, session.runner, session.workdir)].join(" ")}</code></dd>
        <dt>{t("activity.directory")}</dt><dd>{session.workdir}</dd>
        <dt>{t("activity.lastOutput")}</dt><dd>{activity.lastOutputAt ? new Date(activity.lastOutputAt).toLocaleTimeString(locale) : t("activity.noOutput")}</dd>
        <dt>{t("activity.received")}</dt><dd>{(activity.bytes / 1024).toFixed(1)} KB</dd>
        <dt>{t("activity.filesChanged")}</dt><dd>{session.diffFiles.length}</dd>
        {activity.exitCode !== undefined && <><dt>{t("activity.exitCode")}</dt><dd>{activity.exitCode}</dd></>}
      </dl>
      <p className="ad-hint">{t("activity.explanation")}</p>
      <ol>{activity.events.map((event, index) => <li key={index}><time>{new Date(event.at).toLocaleTimeString(locale)}</time><span>{t(event.key)}{event.detail ? ` — ${event.detail}` : ""}</span></li>)}</ol>
    </section>}
  </>;
}
