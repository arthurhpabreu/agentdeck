import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useAppI18n } from "../../i18n";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useSessionStore } from "../../store/sessionStore";
import { recoveryPathKey as pathKey, uniqueRecoveryPaths, useWorktreeRecoveryStore } from "../../store/worktreeRecoveryStore";
import { worktreeRecoveryCommands as api, type RecoverableWorktree } from "../../services/worktreeRecoveryCommands";
import { worktreeCopy } from "./worktreeCopy";
import "../memory/contextSources.css";

export function WorktreeRecovery() {
  const { locale } = useAppI18n(); const c = worktreeCopy(locale);
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const sessions = useSessionStore(state => state.sessions);
  const { repositories, notices, remember, resolved } = useWorktreeRecoveryStore();
  const choices = uniqueRecoveryPaths([...workspaces.map(workspace => workspace.path), ...repositories]);
  const [open, setOpen] = useState(false), [workdir, setWorkdir] = useState(choices[0] ?? "");
  const [rows, setRows] = useState<RecoverableWorktree[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const [confirm, setConfirm] = useState<RecoverableWorktree | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null), sequence = useRef(0), running = useRef(false);
  const close = () => { if (running.current) return; sequence.current++; dialog.current?.close(); setOpen(false); setConfirm(null); trigger.current?.focus(); };
  const load = async () => {
    const request = ++sequence.current; setConfirm(null); setError(""); setRows([]);
    if (!workdir) return;
    setBusy(true);
    try {
      const values = await api.list(workdir);
      if (!Array.isArray(values)) throw new Error("Invalid worktree list");
      if (request === sequence.current) { setRows(values); remember(workdir); }
    } catch (cause) { if (request === sequence.current) setError(String(cause)); }
    finally { if (request === sequence.current) setBusy(false); }
  };
  useEffect(() => { if (open) { dialog.current?.showModal(); void load(); } return () => { sequence.current++; }; }, [open, workdir]);
  const act = async (action: () => Promise<void>) => {
    if (running.current) return; running.current = true; setBusy(true); setError(""); setFeedback("");
    try { await action(); } catch (cause) { setError(String(cause)); }
    finally { running.current = false; setBusy(false); }
  };
  const attached = (row: RecoverableWorktree) => sessions.some(session => session.worktreePath && pathKey(session.worktreePath) === pathKey(row.path));
  return <>
    <button type="button" ref={trigger} className="ad-button" onClick={() => { setWorkdir(current => current || choices[0] || ""); setOpen(true); }}>{c.title}{notices.length ? ` (${notices.length})` : ""}</button>
    {notices.length > 0 && <p role="status" className="ad-worktree-notice">{c.notice}</p>}
    {open && createPortal(<dialog ref={dialog} className="ad-context-dialog ad-worktree-dialog" aria-label={c.title} onCancel={event => { event.preventDefault(); close(); }}>
      <header><h2>{c.title}</h2><button type="button" className="ad-button" disabled={busy} onClick={close}>{c.close}</button></header><p>{c.hint}</p>
      <label>{c.repository}<select value={workdir} disabled={busy} onChange={event => { setFeedback(""); setWorkdir(event.target.value); }}><option value="">—</option>{choices.map(path => <option key={path} value={path}>{path}</option>)}</select></label>
      <div className="ad-worktree-actions"><button type="button" className="ad-button" disabled={busy} onClick={() => void act(async () => { const path = await invoke<string | null>("pick_folder"); if (path) { remember(path); setWorkdir(path); } })}>{c.choose}</button><button type="button" className="ad-button" disabled={busy || !workdir} onClick={() => void load()}>{c.refresh}</button></div>
      {busy && <p role="status">{c.loading}</p>}{error && <p role="alert">{error}</p>}{feedback && <p role="status">{feedback}</p>}
      {!workdir && <p>{c.noRepository}</p>}{!busy && !error && workdir && !rows.length && <p>{c.empty}</p>}
      {notices.filter(notice => pathKey(notice.workdir) === pathKey(workdir)).map(notice => <details key={notice.path}><summary>{notice.path}</summary><p>{notice.message || c.notice}</p></details>)}
      {rows.map(row => { const active = attached(row); return <article key={row.path}><strong>{row.branch || row.head}</strong><p><code>{row.path}</code></p><p>{c[active ? "in_use" : row.reason]}</p>
        <div className="ad-worktree-actions"><button type="button" className="ad-button" disabled={busy} onClick={() => void act(async () => { await navigator.clipboard.writeText(row.path); setFeedback(c.copied); })}>{c.copy}</button><button type="button" className="ad-button" disabled={busy || row.reason === "unavailable"} onClick={() => void act(() => api.open(workdir, row.path))}>{c.open}</button><button type="button" className="ad-button" disabled={busy || active || !row.canRemove} onClick={() => setConfirm(row)}>{c.cleanAction}</button></div>
        {confirm?.path === row.path && <div className="ad-source-warning"><p>{c.confirmHint}</p><code>{confirm.path}</code><div className="ad-worktree-actions"><button type="button" className="ad-button" disabled={busy} onClick={() => void act(async () => { if (attached(row)) throw new Error(c.in_use); await api.remove(workdir, confirm); resolved(confirm.path); setConfirm(null); setFeedback(c.removed); await load(); })}>{c.confirm}</button><button type="button" className="ad-button" disabled={busy} onClick={() => setConfirm(null)}>{c.cancel}</button></div></div>}
      </article>; })}
    </dialog>, document.body)}
  </>;
}
