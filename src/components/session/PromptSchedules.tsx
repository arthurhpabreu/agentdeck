import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarClock, X } from "lucide-react";
import { useAppI18n } from "../../i18n";
import type { ClaudeSession } from "../../store/sessionStore";
import { useChatStore } from "../../store/chatStore";
import { usePromptScheduleStore } from "../../store/promptScheduleStore";
import { dateInZone, nextScheduleRun, validScheduleTiming } from "../../services/promptScheduleTime";
import { scheduledSessionIdentity } from "../../services/promptScheduler";
import { chatInputError } from "../../services/chatInput";
import { scheduleCopy } from "./scheduleCopy";
import "./promptSchedules.css";

export function PromptSchedules({ session }: { session: ClaudeSession }) {
  const { locale } = useAppI18n(), c = scheduleCopy(locale);
  const [open, setOpen] = useState(false);
  const count = usePromptScheduleStore(state => state.schedules.filter(item => item.sessionId === session.id && item.enabled && item.nextRunAt !== undefined).length);
  return <><button type="button" className="ad-icon-button ad-schedule-trigger" aria-label={c.title} title={c.title} onClick={() => setOpen(true)}><CalendarClock size={17} />{count > 0 && <small>{count}</small>}</button>
    {open && <ScheduleDialog session={session} onClose={() => setOpen(false)} />}</>;
}
function ScheduleDialog({ session, onClose }: { session: ClaudeSession; onClose: () => void }) {
  const { locale } = useAppI18n(), c = scheduleCopy(locale);
  const dialog = useRef<HTMLDialogElement>(null), previousFocus = useRef(document.activeElement as HTMLElement | null);
  const [prompt, setPrompt] = useState(() => useChatStore.getState().threads[session.id]?.draft ?? "");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const today = dateInZone(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [startDate, setStartDate] = useState(today), [endDate, setEndDate] = useState(new Date(Date.parse(today) + 30 * 86_400_000).toISOString().slice(0, 10));
  const [time, setTime] = useState("07:00"), [weekdays, setWeekdays] = useState([0, 1, 2, 3, 4, 5, 6]), [error, setError] = useState("");
  const schedules = usePromptScheduleStore(state => state.schedules);
  const current = schedules.filter(item => item.sessionId === session.id);
  const supported = session.runner.type !== "gemini";
  const timing = { startDate, endDate, time, weekdays, timezone };
  const next = nextScheduleRun(timing, Date.now());
  useEffect(() => { dialog.current?.showModal(); return () => previousFocus.current?.focus(); }, []);
  const save = () => {
    if (!supported || !prompt.trim() || chatInputError(prompt) || !validScheduleTiming(timing) || nextScheduleRun(timing, Date.now()) === undefined) { setError(c.invalid); return; }
    try {
      usePromptScheduleStore.getState().add({ ...timing, sessionId: session.id, identity: scheduledSessionIdentity(session), prompt: prompt.trim() });
      setError(""); setPrompt("");
    } catch (failure) { setError(String(failure)); }
  };
  return createPortal(<dialog ref={dialog} className="ad-schedule-dialog" aria-label={c.schedules} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div><CalendarClock size={20} /><h2>{c.schedules}</h2></div><button type="button" className="ad-icon-button" aria-label={c.close} onClick={onClose}><X size={18} /></button></header>
    <p className="ad-schedule-destination">{session.name}</p><p className="ad-schedule-hint">{c.hint}</p>
    <form onSubmit={event => { event.preventDefault(); save(); }}>
      <label>{c.prompt}<textarea autoFocus rows={3} required maxLength={100_000} value={prompt} disabled={!supported} onChange={event => setPrompt(event.target.value)} /></label>
      <small>{supported ? c.draft : c.unsupported}</small>
      <div className="ad-schedule-fields"><label>{c.time}<input required type="time" value={time} onChange={event => setTime(event.target.value)} /></label>
        <label>{c.start}<input required type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></label>
        <label>{c.end}<input required type="date" min={startDate} value={endDate} onChange={event => setEndDate(event.target.value)} /></label></div>
      <fieldset><legend>{c.days}</legend><div className="ad-schedule-days">{c.weekdays.map((day, index) => <label key={index}><input type="checkbox" checked={weekdays.includes(index)} onChange={event => setWeekdays(old => event.target.checked ? [...old, index] : old.filter(value => value !== index))} />{day}</label>)}</div></fieldset>
      <label>{c.timezone}<input required value={timezone} onChange={event => setTimezone(event.target.value)} placeholder="America/Sao_Paulo" /></label>
      {next !== undefined && <p className="ad-schedule-next">{c.next}: <strong>{new Date(next).toLocaleString(locale, { timeZone: timezone })}</strong></p>}
      {error && <p className="ad-schedule-error" role="alert">{error}</p>}
      <button type="submit" className="ad-button ad-button-primary" disabled={!supported}>{c.save}</button>
    </form>
    <div className="ad-schedule-list">{!current.length && <p>{c.empty}</p>}{current.map(item => <article key={item.id}>
      <strong>{item.prompt}</strong><span>{item.time} · {item.weekdays.map(day => c.weekdays[day]).join(", ")} · {item.timezone}</span><small>{item.startDate} — {item.endDate}</small>
      <span>{!item.enabled ? c.paused : item.nextRunAt !== undefined ? `${c.next}: ${new Date(item.nextRunAt).toLocaleString(locale, { timeZone: item.timezone })}` : c.finished}</span>
      {item.lastResult && <small role="status">{item.error === "destination" ? c.destination : item.lastResult === "missed" ? c.missed : item.lastResult === "failed" || item.lastResult === "interrupted" ? c.failed : `${c.started}: ${new Date(item.lastRunAt!).toLocaleString(locale, { timeZone: item.timezone })}`}</small>}
      <div><button type="button" className="ad-button" disabled={item.enabled && !item.nextRunAt} onClick={() => {
        const nextRunAt = nextScheduleRun(item, Date.now());
        usePromptScheduleStore.getState().update(item.id, { enabled: !item.enabled && nextRunAt !== undefined, nextRunAt, error: undefined });
      }}>{item.enabled ? c.pause : c.resume}</button><button type="button" className="ad-button" onClick={() => usePromptScheduleStore.getState().remove(item.id)}>{c.remove}</button></div>
    </article>)}</div>
  </dialog>, document.body);
}
