import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArchiveRestore } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAppI18n } from "../../i18n";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useSessionStore } from "../../store/sessionStore";
import { recoveryPathKey as pathKey, uniqueRecoveryPaths, useWorktreeRecoveryStore } from "../../store/worktreeRecoveryStore";
import { worktreeRecoveryCommands as api, type RecoverableWorktree } from "../../services/worktreeRecoveryCommands";
import { worktreeCopy } from "./worktreeCopy";
import "../memory/contextSources.css";
import { SortableCollection } from "../ordering/SortableCollection";

function formatBytes(bytes: number, locale: string) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024 ** index)} ${units[index]}`;
}

export function WorktreeRecovery() {
  const { locale } = useAppI18n(); const c = worktreeCopy(locale);
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const activePath = useWorkspaceStore(state => state.workspaces.find(workspace => workspace.id === state.activeWorkspaceId)?.path);
  const sessions = useSessionStore(state => state.sessions);
  const { repositories, notices, remember, resolved } = useWorktreeRecoveryStore();
  const choices = uniqueRecoveryPaths([...workspaces.map(workspace => workspace.path), ...repositories]);
  const [open, setOpen] = useState(false), [workdir, setWorkdir] = useState(choices[0] ?? "");
  const [rows, setRows] = useState<RecoverableWorktree[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const [confirm, setConfirm] = useState<{ row: RecoverableWorktree; action: "remove" | "caches" } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false), [progress, setProgress] = useState("");
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null), sequence = useRef(0), running = useRef(false);
  const close = () => { if (running.current) return; sequence.current++; dialog.current?.close(); setOpen(false); setConfirm(null); setConfirmAll(false); trigger.current?.focus(); };
  const load = async () => {
    const request = ++sequence.current; setConfirm(null); setConfirmAll(false); setError(""); setRows([]);
    if (!workdir) return;
    setBusy(true);
    try {
      const values = await api.list(workdir);
      if (!Array.isArray(values)) throw new Error("Invalid worktree list");
      if (request === sequence.current) {
        setRows(values); remember(workdir);
        // Folders removed outside the app no longer need a recovery notice.
        const listed = new Set(values.map(row => pathKey(row.path)));
        notices.filter(notice => pathKey(notice.workdir) === pathKey(workdir) && !listed.has(pathKey(notice.path))).forEach(notice => resolved(notice.path));
      }
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
  const canCleanCaches = (row: RecoverableWorktree) => !attached(row) && ["clean", "dirty"].includes(row.reason) && (row.reclaimableBytes ?? 0) > 0;
  const archivable = rows.filter(row => !attached(row) && ["clean", "dirty", "detached"].includes(row.reason));
  const cleanAll = () => void act(async () => {
    setConfirmAll(false);
    const failed: string[] = []; let removed = 0, freed = 0, stashed = 0;
    for (const [index, row] of archivable.entries()) {
      setProgress(`${c.cleaning} ${index + 1}/${archivable.length}…`);
      try {
        if (attached(row)) throw new Error(c.in_use);
        const outcome = await api.archive(workdir, row);
        removed += 1; freed += row.sizeBytes ?? 0; if (outcome?.stashed) stashed += 1;
        resolved(row.path);
      } catch (cause) { failed.push(`${row.branch || row.path}: ${String(cause)}`); }
    }
    setProgress("");
    await load();
    setFeedback([`${c.cleanAllDone}: ${removed}`, freed ? `${c.cachesCleaned}: ${formatBytes(freed, locale)}` : "", stashed ? `${c.stashed}: ${stashed}` : ""].filter(Boolean).join(" · "));
    if (failed.length) setError(`${c.cleanAllFailed}: ${failed.join("; ")}`);
  });
  return <>
    <button type="button" ref={trigger} className="ad-icon-button ad-worktree-trigger" data-notices={notices.length > 0}
      aria-label={`${c.title}${notices.length ? ` (${notices.length})` : ""}`} title={notices.length ? `${c.title} (${notices.length}) · ${c.notice}` : c.title}
      onClick={() => { setWorkdir(current => activePath || current || choices[0] || ""); setOpen(true); }}><ArchiveRestore size={15} aria-hidden="true" />{notices.length > 0 && <b aria-hidden="true">{notices.length}</b>}</button>
    {open && createPortal(<dialog ref={dialog} className="ad-context-dialog ad-worktree-dialog" aria-label={c.title} onCancel={event => { event.preventDefault(); close(); }}>
      <header><h2>{c.title}</h2><button type="button" className="ad-button" disabled={busy} onClick={close}>{c.close}</button></header><p>{c.hint}</p>
      <label>{c.repository}<select value={workdir} disabled={busy} onChange={event => { setFeedback(""); setWorkdir(event.target.value); }}><option value="">—</option>{choices.map(path => <option key={path} value={path}>{path}</option>)}</select></label>
      <div className="ad-worktree-actions"><button type="button" className="ad-button" disabled={busy} onClick={() => void act(async () => { const path = await invoke<string | null>("pick_folder"); if (path) { remember(path); setWorkdir(path); } })}>{c.choose}</button><button type="button" className="ad-button" disabled={busy || !workdir} onClick={() => void load()}>{c.refresh}</button></div>
      {busy && <p role="status">{progress || c.loading}</p>}{error && <p role="alert">{error}</p>}{feedback && <p role="status">{feedback}</p>}
      {!workdir && <p>{c.noRepository}</p>}{!busy && !error && workdir && !rows.length && <p>{c.empty}</p>}
      {rows.some(row => row.sizeBytes !== undefined) && <p className="ad-worktree-storage" role="status">{c.size}: <strong>{formatBytes(rows.reduce((total, row) => total + (row.sizeBytes ?? 0), 0), locale)}</strong> · {c.reclaimable}: <strong>{formatBytes(rows.reduce((total, row) => total + (canCleanCaches(row) ? row.reclaimableBytes ?? 0 : 0), 0), locale)}</strong></p>}
      {archivable.length > 0 && <div className="ad-worktree-actions"><button type="button" className="ad-button" disabled={busy} onClick={() => setConfirmAll(true)}>{c.cleanAll} ({archivable.length}{archivable.some(row => row.sizeBytes) ? ` · ${formatBytes(archivable.reduce((total, row) => total + (row.sizeBytes ?? 0), 0), locale)}` : ""})</button></div>}
      {confirmAll && <div className="ad-source-warning"><p>{c.cleanAllHint}</p><ul>{archivable.map(row => <li key={row.path}><code>{row.branch || row.path}</code></li>)}</ul><div className="ad-worktree-actions"><button type="button" className="ad-button" disabled={busy} onClick={cleanAll}>{c.cleanAllConfirm}</button><button type="button" className="ad-button" disabled={busy} onClick={() => setConfirmAll(false)}>{c.cancel}</button></div></div>}
      <SortableCollection surface="worktree-notices" context={pathKey(workdir)} items={notices.filter(notice => pathKey(notice.workdir) === pathKey(workdir))} allIds={notices.map(notice => notice.path)} getId={notice => notice.path} getLabel={notice => notice.path} toolbar={false} render={(notice, handle) => <div style={{ display: "flex", gap: 4 }}>{handle}<details><summary>{notice.path}</summary><p>{notice.message || c.notice}</p></details></div>} />
      <SortableCollection surface="recoverable-worktrees" context={pathKey(workdir)} items={rows} getId={row => row.path} getLabel={row => row.branch || row.path} render={(row, handle) => { const active = attached(row); return <article><div style={{ display: "flex", gap: 4, alignItems: "center" }}>{handle}<strong>{row.branch || row.head}</strong></div><p><code>{row.path}</code></p><p>{c[active ? "in_use" : row.reason]}</p>
        {row.sizeBytes !== undefined && <p className="ad-worktree-storage">{c.size}: <strong>{formatBytes(row.sizeBytes, locale)}</strong> · {c.reclaimable}: <strong>{formatBytes(row.reclaimableBytes ?? 0, locale)}</strong></p>}
        {row.storageError && <p className="ad-context-hint" title={row.storageError}>{c.partialSize}</p>}
        <div className="ad-worktree-actions"><button type="button" className="ad-button" disabled={busy} onClick={() => void act(async () => { await navigator.clipboard.writeText(row.path); setFeedback(c.copied); })}>{c.copy}</button><button type="button" className="ad-button" disabled={busy || row.reason === "unavailable"} onClick={() => void act(() => api.open(workdir, row.path))}>{c.open}</button><button type="button" className="ad-button" disabled={busy || active || !row.canRemove} onClick={() => setConfirm({ row, action: "remove" })}>{c.cleanAction}</button>{(row.reclaimableBytes ?? 0) > 0 && <button type="button" className="ad-button" disabled={busy || !canCleanCaches(row)} onClick={() => setConfirm({ row, action: "caches" })}>{c.cachesAction}</button>}</div>
        {confirm?.row.path === row.path && <div className="ad-source-warning"><p>{confirm.action === "caches" ? c.cachesHint : c.confirmHint}</p><code>{confirm.row.path}</code>{confirm.action === "caches" && <ul>{confirm.row.cachePaths?.map(path => <li key={path}><code>{path}</code></li>)}</ul>}<div className="ad-worktree-actions"><button type="button" className="ad-button" disabled={busy} onClick={() => void act(async () => {
          if (attached(row)) throw new Error(c.in_use);
          if (confirm.action === "caches") {
            const freed = await api.cleanCaches(workdir, confirm.row);
            setFeedback(`${c.cachesCleaned}: ${formatBytes(freed, locale)}`);
          } else {
            await api.remove(workdir, confirm.row); resolved(confirm.row.path); setFeedback(c.removed);
          }
          setConfirm(null); await load();
        })}>{confirm.action === "caches" ? c.cachesConfirm : c.confirm}</button><button type="button" className="ad-button" disabled={busy} onClick={() => setConfirm(null)}>{c.cancel}</button></div></div>}
      </article>; }} />
    </dialog>, document.body)}
  </>;
}
