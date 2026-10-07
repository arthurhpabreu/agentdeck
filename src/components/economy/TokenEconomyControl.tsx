import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Copy, Info, Leaf, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useAppI18n } from "../../i18n";
import type { RunnerType } from "../../store/settingsStore";
import { useChatStore } from "../../store/chatStore";
import { hasEconomyMeasurements, useTokenEconomy, type TokenEconomyScope } from "../../store/tokenEconomyStore";
import { tokenEconomyMessages } from "./tokenEconomyMessages";
import "./tokenEconomy.css";
import { workflowCopy } from "../session/workflowCopy";

const INSTALL_COMMAND = /Win/i.test(navigator.platform) ? "winget install rtk-ai.rtk" : "cargo install --git https://github.com/rtk-ai/rtk";

export function TokenEconomyControl({ disabled = false, visible = true, provider, workdir, sessionId }: { disabled?: boolean; visible?: boolean; provider?: RunnerType; workdir?: string; sessionId?: string }) {
  const { locale } = useAppI18n();
  const m = tokenEconomyMessages(locale);
  const w = workflowCopy(locale);
  const [scope, setScope] = useState<TokenEconomyScope>("agentdeck");
  const { status, refreshing, changing, error, checkedAt, refresh, setEnabled } = useTokenEconomy(visible, workdir, scope);
  const reportedUsage = useChatStore(state => sessionId ? state.threads[sessionId]?.lastUsage : undefined);
  const totalUsage = useChatStore(state => sessionId ? state.threads[sessionId]?.totalUsage : undefined);
  const busy = useChatStore(state => sessionId ? state.threads[sessionId]?.busy : false);
  const wasBusy = useRef(false);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const id = useId();
  const desktop = "__TAURI_INTERNALS__" in window;
  const measured = hasEconomyMeasurements(status);
  const count = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
  const percent = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  const compactCount = (value: number) => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  const cachePercent = totalUsage && totalUsage.inputTokens > 0 ? Math.min(100,totalUsage.cachedInputTokens / totalUsage.inputTokens * 100) : undefined;
  const reported = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? count(value) : m.unknown;
  const close = () => { setOpen(false); trigger.current?.focus(); };

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => { if (!visible) setOpen(false); }, [visible]);
  useEffect(() => {
    if (wasBusy.current && !busy && visible) void refresh(true, workdir, scope);
    wasBusy.current = !!busy;
  }, [busy, visible, workdir, scope, refresh]);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch { setCopied(false); }
  };
  const chipState = status ? status.enabled ? m.enabled : m.disabled : refreshing ? m.checking : m.unavailable;

  return <div className="ad-token-economy" ref={root} onKeyDown={event => { if (event.key === "Escape" && open) { event.stopPropagation(); close(); } }}>
    <button type="button" ref={trigger} className="ad-economy-trigger" data-enabled={status?.enabled === true} aria-label={m.title} title={`${m.title} · ${chipState}`} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => { setOpen(value => !value); if (!open) void refresh(false, workdir, scope); }}>
      <Leaf size={14} /><span>{m.short}</span><small>{chipState}</small>{measured && status!.commandCount! > 0 && <span className="ad-economy-count">≈ {percent(status!.savingsPercent!)}% {w.rtkLabel}</span>}{cachePercent !== undefined && <span className="ad-economy-count" title={w.cacheHint}>{percent(cachePercent)}% {w.cacheLabel}</span>}{totalUsage && <span className="ad-economy-count">{compactCount(totalUsage.inputTokens + totalUsage.outputTokens)} {m.usedShort}</span>}<ChevronDown size={11} />
    </button>
    {open && <div id={id} ref={panel} className="ad-economy-panel" role="dialog" tabIndex={-1} aria-label={m.title}>
      <header><div><h3>{m.title}</h3><p>{status?.available ? m.ready : status ? m.missing : m.checking}</p></div><button type="button" className="ad-economy-icon" aria-label={m.close} title={m.close} onClick={close}><X size={16} /></button></header>
      <div className="ad-economy-setting"><div><strong>{m.toggle}</strong><p>{changing ? m.saving : disabled ? m.busy : m.future}</p></div><button type="button" className="ad-economy-switch" role="switch" aria-label={m.toggle} aria-checked={status?.enabled === true} disabled={disabled || changing || !status || !desktop} onClick={() => void setEnabled(!status?.enabled, workdir, scope)}><span>{changing && <LoaderCircle size={10} />}</span></button></div>
      <p className="ad-economy-description">{m.description}</p>
      {(provider === "claude-code" || provider === "codex") && <p className="ad-economy-description">{provider === "codex" ? m.codexDetail : m.claudeDetail}</p>}
      {status && <div className="ad-economy-capabilities"><span>{m.prompt}</span>{status.available && <span>{status.version || m.ready}</span>}{provider === "claude-code" && status.claudeHookAvailable && <span>{m.hook}</span>}</div>}
      {!desktop && <p className="ad-economy-notice">{m.desktop}</p>}
      {desktop && !status && !error && <p className="ad-economy-notice" role="status">{m.pending}</p>}
      {error && <p className="ad-economy-notice is-error" role="alert">{m.error}</p>}
      {status && !status.available && <div className="ad-economy-install"><p>{m.missingDetail}</p><label>{m.install}</label><div><code>{INSTALL_COMMAND}</code><button type="button" aria-label={copied ? m.copied : m.copy} title={copied ? m.copied : m.copy} onClick={() => void copyCommand()}>{copied ? <Check size={13} /> : <Copy size={13} />}</button></div></div>}
      <section className="ad-economy-history" aria-label={status?.scope === "project" ? m.project : status?.scope === "agentdeck" ? m.agentdeck : m.history}>
        <label className="ad-economy-scope">{m.scope}<select aria-label={m.scope} value={scope} onChange={event => setScope(event.target.value as TokenEconomyScope)}><option value="agentdeck">Agentdeck</option><option value="project" disabled={!workdir}>{m.scopeProject}</option><option value="global">{m.scopeGlobal}</option></select></label>
        <div className="ad-economy-history-heading"><h4>{status?.scope === "project" ? m.project : status?.scope === "agentdeck" ? m.agentdeck : m.history}</h4></div>
        {measured && status ? <dl>
          <div><dt>{m.input}</dt><dd>{`≈ ${count(status.totalInputTokens!)}`}</dd></div>
          <div><dt>{m.output}</dt><dd>{`≈ ${count(status.totalOutputTokens!)}`}</dd></div>
          <div className="ad-economy-result"><dt>{m.saved}</dt><dd>{`≈ ${count(status.savedTokens!)}`}</dd></div>
          <div><dt>{m.estimate}</dt><dd>{`≈ ${percent(status.savingsPercent!)}%`}</dd></div>
          <div><dt>{m.commands}</dt><dd>{count(status.commandCount!)}</dd></div>
        </dl> : <div className="ad-economy-empty"><strong>{m.noHistory}</strong><p>{m.noHistoryDetail}</p></div>}
        {measured && status?.commandCount === 0 && <p className="ad-economy-method">{m.zeroHistory}</p>}
        {status?.commandCount === 0 && sessionId && <p className="ad-economy-method">{w.textOnly}</p>}
        {scope === "project" && <p className="ad-economy-method">{m.projectHint}</p>}
        <p className="ad-economy-method"><Info size={12} />{status?.scope && status.scope !== "global" ? m.methodologyScoped : m.methodology}</p>
        {checkedAt && <p className={`ad-economy-checked ${error ? "is-stale" : ""}`}>{error ? m.stale : m.updated} {new Date(checkedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</p>}
      </section>
      {sessionId && <section className="ad-economy-history ad-economy-cli" aria-label={m.conversationUsage}>
        <div className="ad-economy-history-heading"><h4>{m.conversationUsage}</h4><span>{m.reported}</span></div>
        {totalUsage ? <dl><div className="ad-economy-result"><dt>{m.totalTokens}</dt><dd>{count(totalUsage.inputTokens + totalUsage.outputTokens)}</dd></div><div><dt>{m.inputTokens}</dt><dd>{reported(totalUsage.inputTokens)}</dd></div><div><dt>{m.outputTokens}</dt><dd>{reported(totalUsage.outputTokens)}</dd></div><div><dt>{m.cachedTokens}</dt><dd>{reported(totalUsage.cachedInputTokens)}</dd></div></dl> : <div className="ad-economy-empty"><strong>{m.unknown}</strong></div>}
        <p className="ad-economy-method"><Info size={12} />{m.conversationHint}</p>
        {cachePercent !== undefined && <><dl><div><dt>{w.cachePercent}</dt><dd>{percent(cachePercent)}%</dd></div></dl><p className="ad-economy-method">{w.cacheHint}</p></>}
        {totalUsage && <p className="ad-economy-method">{m.cacheHint}</p>}
      </section>}
      {reportedUsage && <section className="ad-economy-history ad-economy-cli" aria-label={m.lastResponse}>
        <div className="ad-economy-history-heading"><h4>{m.lastResponse}</h4><span>{m.reported}</span></div>
        <dl><div><dt>{m.inputTokens}</dt><dd>{reported(reportedUsage.inputTokens)}</dd></div><div><dt>{m.outputTokens}</dt><dd>{reported(reportedUsage.outputTokens)}</dd></div><div><dt>{m.cachedTokens}</dt><dd>{reported(reportedUsage.cachedInputTokens)}</dd></div></dl>
        <p className="ad-economy-method"><Info size={12} />{m.cacheHint}</p>
      </section>}
      {(error || status?.reason || status?.source) && <details className="ad-economy-diagnostics"><summary>{m.diagnostics}</summary>{status?.source && <p>{m.source}: <code>{status.source}</code></p>}{status?.executablePath && <p>{m.executable}: <code>{status.executablePath}</code></p>}{status?.databasePath && <p>{m.database}: <code>{status.databasePath}</code></p>}{status?.projectPath && <p>{m.scopeProject}: <code>{status.projectPath}</code></p>}{(error || status?.reason) && <p>{error || status?.reason}</p>}</details>}
      <footer><span>{status?.scope === "project" ? m.project : status?.scope === "agentdeck" ? m.agentdeck : m.history}</span><button type="button" disabled={refreshing || changing || !desktop} onClick={() => void refresh(true, workdir, scope)} aria-label={m.refresh}><RefreshCw size={12} className={refreshing ? "ad-economy-spinning" : ""} />{m.refresh}</button></footer>
    </div>}
  </div>;
}
