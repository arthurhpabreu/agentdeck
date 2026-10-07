import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Ellipsis, RefreshCw, X } from "lucide-react";
import { useAppI18n } from "../../i18n";
import type { AgentModel } from "../../services/agentExecution";
import { RUNNER_LABELS, useSettingsStore, type RunnerConfig } from "../../store/settingsStore";
import { useCliUpdateStore } from "../../store/cliUpdateStore";
import { modelCopy } from "./modelCopy";
import { cliUpdateCopy } from "../cliUpdateCopy";

export function AgentOptionsMenu({ runner, model, loading, disabled, error, onRefresh }: { runner: RunnerConfig; model?: AgentModel; loading: boolean; disabled: boolean; error: string; onRefresh: () => void }) {
  const { locale } = useAppI18n(); const c = modelCopy(locale);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const count = useCliUpdateStore(state => Object.values(state.entries).filter(entry => entry.result?.updateAvailable).length);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const move = () => {
      const rect = trigger.current?.getBoundingClientRect(); const height = panel.current?.offsetHeight ?? 300;
      if (rect) setPosition({ left: Math.max(12, Math.min(rect.right - 340, window.innerWidth - 352)), top: Math.max(12, rect.top > height + 20 ? rect.top - height - 8 : Math.min(rect.bottom + 8, window.innerHeight - height - 12)) });
    };
    move(); panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === "Tab" && panel.current) {
        const nodes = Array.from(panel.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const first = nodes[0]; const last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const observer = new ResizeObserver(move); if (panel.current) observer.observe(panel.current);
    document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", key, true); window.addEventListener("resize", move);
    return () => { observer.disconnect(); document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", key, true); window.removeEventListener("resize", move); };
  }, [open]);
  return <>
    <button ref={trigger} type="button" className="ad-agent-options-trigger" title={c.options} aria-label={c.options} aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog" onClick={() => setOpen(!open)}><Ellipsis size={18} />{count > 0 && <i aria-hidden="true" />}</button>
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-modal="true" aria-label={c.options} className="ad-effort-panel ad-agent-options" style={position}>
      <header><strong>{RUNNER_LABELS[runner.type]}</strong><button type="button" className="ad-icon-button" aria-label={c.close} onClick={close}><X size={16} /></button></header>
      <dl className="ad-model-details"><div><dt>{c.version}</dt><dd><code>{model?.resolvedModel || c.unverified}</code></dd></div><div><dt>{c.cli}</dt><dd><code>{model?.cliVersion || c.unverified}</code></dd></div></dl>
      {error && <p role="status">{error}</p>}
      <div className="ad-agent-options-actions">
        {runner.type !== "gemini" && <button type="button" disabled={disabled || loading} onClick={onRefresh}><RefreshCw size={15} className={loading ? "ad-spin" : undefined} />{loading ? c.loading : c.refresh}</button>}
        <button type="button" aria-label={cliUpdateCopy(locale).link} onClick={() => { setOpen(false); useSettingsStore.getState().setTab("system"); useSettingsStore.getState().openSettings(); }}><Download size={15} />{c.updates}{count > 0 && <small>{count}</small>}</button>
      </div>
    </div>, document.body)}
  </>;
}
