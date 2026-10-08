import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Gauge, X, Zap } from "lucide-react";
import type { RunnerConfig, ReasoningEffort } from "../../store/settingsStore";
import { useAppI18n } from "../../i18n";
import { executionCapabilities, executionOptions, loadAgentModels } from "../../services/agentExecution";
import { effortCopy } from "./effortCopy";
import { useCliUpdateStore } from "../../store/cliUpdateStore";
import "./effort.css";

export function AgentEffortControl({ runner, onChange, disabled = false, native = false, workdir = "", compact = false }: { runner: RunnerConfig; onChange: (patch: Partial<RunnerConfig>) => void; disabled?: boolean; native?: boolean; workdir?: string; compact?: boolean }) {
  const { locale } = useAppI18n(); const c = effortCopy(locale);
  const [open, setOpen] = useState(false);
  const [, refresh] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const revision = useCliUpdateStore(state => state.revision);
  useEffect(() => { let active = true; void loadAgentModels(runner.type, runner.cliPath, false, workdir).then(() => { if (active) refresh(v => v + 1); }).catch(() => {}); return () => { active = false; }; }, [runner.type, runner.cliPath, workdir, revision]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const move = () => {
      const rect = trigger.current?.getBoundingClientRect();
      const height = panel.current?.offsetHeight ?? 390;
      if (rect) setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 352)), top: Math.max(12, rect.top > height + 20 ? rect.top - height - 8 : Math.min(rect.bottom + 8, window.innerHeight - height - 12)) });
    };
    move(); panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === "Tab" && panel.current) {
        const nodes = Array.from(panel.current.querySelectorAll<HTMLElement>("button:not(:disabled), select:not(:disabled)"));
        const first = nodes[0]; const last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const observer = new ResizeObserver(move); if (panel.current) observer.observe(panel.current);
    document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", key, true); window.addEventListener("resize", move);
    return () => { observer.disconnect(); document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", key, true); window.removeEventListener("resize", move); };
  }, [open]);
  useEffect(() => { setOpen(false); }, [runner.type, disabled]);
  if (runner.type === "gemini") return null;
  const cap = executionCapabilities(runner, workdir); const value = executionOptions(runner, workdir);
  const codexUltra = runner.type === "codex" && value.ultraMode;
  const level = !cap.efforts.length ? "—" : codexUltra ? c.ultraCodex : c[value.effort];
  return <>
    <button ref={trigger} type="button" className="ad-effort-trigger" aria-label={`${c.effort}: ${level}${value.fastMode ? " · Fast" : ""}`} aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog" title={disabled && native ? c.nativeHint : compact ? `${c.title} · ${level}${value.fastMode ? " · Fast" : ""}` : c.title} onClick={() => setOpen(!open)}>
      <Gauge size={14} /><span>{!compact && <>{c.effort} </>}<strong>{level}</strong></span>{value.ultraMode && !codexUltra && <small>{c.ultraClaude}</small>}{value.fastMode && <Zap size={12} />}
    </button>
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-modal="true" aria-label={c.title} className="ad-effort-panel" style={position}>
      <header><strong>{c.title}</strong><button className="ad-icon-button" aria-label={c.close} onClick={close}><X size={16} /></button></header>
      <label className="ad-effort-level">{c.effort}<select aria-label={c.effort} disabled={disabled || !cap.efforts.length} value={codexUltra ? "ultra" : value.effort} onChange={e => e.target.value === "ultra" ? onChange({ ultraMode: true }) : onChange({ effort: e.target.value as ReasoningEffort, ...(runner.type === "codex" ? { ultraMode: false } : {}) })}>{cap.efforts.map(level => <option key={level} value={level}>{c[level]}</option>)}{runner.type === "codex" && cap.ultra && <option value="ultra">{c.ultraCodex}</option>}</select></label>
      <p>{!cap.efforts.length ? c.noEffort : codexUltra ? c.highHint : ["none", "minimal", "low"].includes(value.effort) ? c.lowHint : value.effort === "medium" ? c.mediumHint : c.highHint}</p>
      <div className="ad-effort-option"><div><strong>{runner.type === "codex" ? c.ultraCodex : c.ultraClaude}</strong><p>{cap.ultra ? runner.type === "codex" ? c.ultraHintCodex : c.ultraHintClaude : c.unsupported}</p></div><button type="button" role="switch" aria-label={runner.type === "codex" ? c.ultraCodex : c.ultraClaude} aria-checked={value.ultraMode} disabled={disabled || !cap.ultra} className="ad-effort-switch" onClick={() => onChange({ ultraMode: !value.ultraMode })}><i /></button></div>
      <div className="ad-effort-option"><div><strong><Zap size={13} /> {c.fast}</strong><p>{cap.fast ? c.fastHint : c.unsupported}</p></div><button type="button" role="switch" aria-label={c.fast} aria-checked={value.fastMode} disabled={disabled || !cap.fast} className="ad-effort-switch" onClick={() => onChange({ fastMode: !value.fastMode })}><i /></button></div>
      <footer>{disabled && native ? c.nativeHint : runner.type === "codex" && !cap.known ? c.unknown : c.saved}</footer>
    </div>, document.body)}
  </>;
}
