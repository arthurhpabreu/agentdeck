import { useEffect, useId, useRef, useState } from "react";
import { Clock3, Info, RefreshCw, X } from "lucide-react";
import { useAppI18n } from "../i18n";
import { usageMessages } from "../i18n/usageMessages";
import { isUsageWindowStale, usageObservedAt, useProviderUsage, type ProviderUsage, type UsageProvider, type UsageWindow } from "../store/providerUsageStore";
import { ProviderIcon } from "./ProviderIcon";
import "./providerUsage.css";

const providerNames: Record<UsageProvider, string> = { codex: "Codex", "claude-code": "Claude" };
type Copy = typeof usageMessages["en-US"];
type DisplayState = "ready" | "stale" | "error" | "unavailable" | "login" | "cooldown" | "checking";

function windowLabel(key: string, copy: Copy): string {
  if (key in copy) return copy[key as keyof Copy];
  const minutes = Number(key.replace("window-", ""));
  if (Number.isFinite(minutes) && minutes > 0) {
    if (minutes % 1440 === 0) return `${minutes / 1440} ${copy.days}`;
    return minutes % 60 === 0 ? `${minutes / 60} ${copy.hours}` : `${minutes} ${copy.minutes}`;
  }
  return copy.window;
}

function orderedWindows(provider: ProviderUsage): UsageWindow[] {
  const priority = ["session", "primary", "weekly", "secondary", "monthly", "monthly-extra", "monthly-spend"];
  const rank = (key: string) => priority.includes(key) ? priority.indexOf(key) : priority.length;
  return [...provider.windows].sort((left, right) => rank(left.key) - rank(right.key));
}

function percentage(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value) + "%";
}

function usageState(provider: ProviderUsage, checking = false): DisplayState {
  if (checking && !provider.windows.length) return "checking";
  if (["missing-login", "expired-login", "authentication"].includes(provider.reason ?? "")) return "login";
  if (provider.reason === "rate-limited") return "cooldown";
  if (provider.status === "error") return "error";
  if (!provider.windows.length) return "unavailable";
  return provider.status !== "ready" || provider.windows.some((window) => isUsageWindowStale(window, provider)) ? "stale" : "ready";
}

function explanation(provider: ProviderUsage, copy: Copy): string {
  switch (provider.reason) {
    case "missing-login": return copy.reasonMissingLogin;
    case "expired-login": return copy.reasonExpiredLogin;
    case "authentication": return copy.reasonAuthentication;
    case "rate-limited": return copy.reasonRateLimited;
    case "network": return copy.reasonNetwork;
    case "unsupported": return copy.reasonUnsupported;
    case "read-error": return copy.readError;
    default: return provider.status === "error" ? copy.readError : !provider.windows.length ? copy.unknown : usageState(provider) === "stale" ? copy.staleGuidance : copy.guidance;
  }
}

function sourceLabel(provider: ProviderUsage, copy: Copy): string {
  switch (provider.source) {
    case "claude-oauth": return copy.sourceClaudeAccount;
    case "claude-statusline": return copy.sourceClaudeStatusline;
    case "claude-stream": return copy.sourceClaudeStream;
    case "codex-rollout": return copy.sourceCodex;
    default: return provider.source || copy.sourceUnknown;
  }
}

function formatDate(timestamp: number, locale: string): string {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date) : "";
}

/** Only the visual countdown ticks; network checks keep the shared polling cadence. */
function useRetryClock(retryAt: number | null | undefined) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!retryAt || retryAt * 1000 <= Date.now()) return;
    const timer = window.setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (next >= retryAt * 1000) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);
  return Math.max(0, Math.ceil(((retryAt ?? 0) * 1000 - now) / 1000));
}

function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function WindowDetail({ item, provider }: { item: UsageWindow; provider: ProviderUsage }) {
  const { locale } = useAppI18n();
  const copy = usageMessages[locale];
  const stale = provider.status !== "ready" || isUsageWindowStale(item, provider);
  const observedAt = usageObservedAt(item.observed_at ?? provider.observed_at);
  const reset = item.resets_at ? item.resets_at * 1000 : null;
  return <div className="usage-window-detail">
    <div className="usage-window-heading">
      <span>{windowLabel(item.key, copy)}</span>
      <strong>{percentage(item.used_percent, locale)} <small>{copy.used}</small></strong>
    </div>
    <div className={`usage-track ${item.used_percent >= 90 ? "is-critical" : item.used_percent >= 75 ? "is-warning" : ""} ${stale ? "is-stale" : ""}`}
      role="progressbar" aria-label={`${providerNames[provider.provider]} ${windowLabel(item.key, copy)}`} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={Math.min(100, item.used_percent)} aria-valuetext={`${percentage(item.used_percent, locale)} ${copy.used}${stale ? ` · ${copy.stale}` : ""}`}>
      <span style={{ transform: `scaleX(${Math.min(100, item.used_percent) / 100})` }} />
    </div>
    <div className="usage-window-meta">
      <span>{percentage(Math.max(0, 100 - item.used_percent), locale)} {copy.remaining}</span>
      {reset && <span><Clock3 size={11} /> {reset <= Date.now() ? copy.expired : `${copy.resets} ${formatDate(reset, locale)}`}</span>}
    </div>
    {observedAt && <div className={`usage-observed ${stale ? "is-stale" : ""}`}>{copy.observed} {formatDate(observedAt, locale)}{stale ? ` · ${copy.stale}` : ""}</div>}
  </div>;
}

export function ProviderUsageDetails({ provider, checkedAt, checking = false }: { provider: ProviderUsage; checkedAt?: number | null; checking?: boolean }) {
  const { locale } = useAppI18n();
  const copy = usageMessages[locale];
  const status = usageState(provider, checking);
  const retrySeconds = useRetryClock(provider.retry_at);
  const hasWindows = provider.windows.length > 0;
  const hasMonthly = provider.windows.some(window => ["monthly", "monthly-extra", "monthly-spend"].includes(window.key));
  return <div className="usage-details" aria-busy={checking}>
    <div className="usage-details-provider">
      <span className={`usage-provider-mark is-${provider.provider}`}><ProviderIcon provider={provider.provider} size={22} /></span>
      <div><strong>{providerNames[provider.provider]}</strong><span>{copy.details}</span></div>
      <span className={`usage-state is-${status}`}><i />{copy[status]}</span>
    </div>
    {hasWindows ? <div className="usage-window-list">
      {orderedWindows(provider).map(item => <WindowDetail key={item.key} item={item} provider={provider} />)}
    </div> : <div className={`usage-empty is-${status}`}><Info size={17} /><p>{checking ? copy.loading : explanation(provider, copy)}</p></div>}
    {hasWindows && status !== "ready" && <div className={`usage-diagnostic is-${status}`} role="status">
      <p>{explanation(provider, copy)}</p>
      {provider.status !== "ready" && <p>{copy.savedReading}</p>}
    </div>}
    {provider.retry_at != null && <div className="usage-retry" data-testid="usage-retry">
      <Clock3 size={13} /><div><span>{copy.retryAt} {formatDate(provider.retry_at * 1000, locale)}</span>
        <strong>{retrySeconds > 0 ? `${copy.retryIn} ${formatCountdown(retrySeconds)}` : copy.retryReady}</strong></div>
    </div>}
    <dl className="usage-provenance">
      <div><dt>{copy.source}</dt><dd>{sourceLabel(provider, copy)}</dd></div>
      {checkedAt && <div><dt>{copy.checked}</dt><dd>{formatDate(checkedAt, locale)}</dd></div>}
    </dl>
    <div className="usage-explanation"><Info size={14} /><div>
      {status !== "ready" && <p>{copy.guidance}</p>}
      <p>{provider.provider === "codex" ? copy.codexGuidance : copy.claudeGuidance}</p>
      {!hasMonthly && <p>{copy.noMonthly}</p>}
    </div></div>
  </div>;
}

/** Provider identities remain visible. Only measured quota windows are rendered. */
export function ProviderUsageBar() {
  const { locale } = useAppI18n();
  const copy = usageMessages[locale];
  const { providers, refreshing, refresh, checkedAt } = useProviderUsage();
  const [expanded, setExpanded] = useState<UsageProvider | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = providers.find((provider) => provider.provider === expanded);
  const retrySeconds = useRetryClock(selected?.retry_at);
  const checking = refreshing && checkedAt === null;

  const closeDetails = () => {
    const active = expanded;
    setExpanded(null);
    rootRef.current?.querySelector<HTMLButtonElement>(`[data-provider="${active}"]`)?.focus();
  };
  useEffect(() => {
    if (!expanded) return;
    dialogRef.current?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setExpanded(null); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded]);

  return <div ref={rootRef} className="provider-usage-bar" data-testid="provider-usage-bar" aria-label={copy.title}
    onKeyDown={(event) => { if (event.key === "Escape" && expanded) { event.stopPropagation(); closeDetails(); } }}>
    <div className="usage-bar-label">{copy.title}</div>
    <div className="usage-bar-providers">
      {providers.map((provider) => {
        const status = usageState(provider, checking);
        return <button type="button" className={`usage-provider-summary ${expanded === provider.provider ? "is-open" : ""}`} key={provider.provider}
          data-provider={provider.provider} aria-expanded={expanded === provider.provider} aria-controls={expanded === provider.provider ? id : undefined}
          title={`${providerNames[provider.provider]} · ${copy.details} · ${copy[status]}`}
          onClick={() => setExpanded((current) => current === provider.provider ? null : provider.provider)}>
          <span className={`usage-summary-name is-${provider.provider}`}><ProviderIcon provider={provider.provider} size={17} /><strong>{providerNames[provider.provider]}</strong><i className={`usage-state-dot is-${status}`} /></span>
          {orderedWindows(provider).map((item) => {
            const stale = provider.status !== "ready" || isUsageWindowStale(item, provider);
            return <span className={`usage-summary-window ${stale ? "is-stale" : ""}`} key={item.key} title={`${percentage(item.used_percent, locale)} ${copy.used}${stale ? ` · ${copy.stale}` : ""}`}>
              <span>{windowLabel(item.key, copy)}</span><b>{percentage(item.used_percent, locale)}</b>
              {stale && <Clock3 size={10} />}
            </span>;
          })}
          {status !== "ready" && <span className={`usage-summary-status is-${status}`}>{copy[status]}</span>}
        </button>;
      })}
    </div>
    <button type="button" className="usage-refresh" onClick={() => void refresh(true)} disabled={refreshing} aria-label={copy.refresh} aria-busy={refreshing} title={copy.refresh}>
      <RefreshCw size={14} className={refreshing ? "is-spinning" : ""} />
    </button>
    {selected && <div ref={dialogRef} className="usage-popover" role="dialog" tabIndex={-1} id={id} aria-label={`${providerNames[selected.provider]} · ${copy.details}`}>
      <button type="button" className="usage-close" onClick={closeDetails} aria-label={copy.close} title={copy.close}><X size={15} /></button>
      <ProviderUsageDetails provider={selected} checkedAt={checkedAt} checking={checking} />
      <div className="usage-popover-footer"><span>{copy.local}</span><button type="button" onClick={() => void refresh(true)} disabled={refreshing || retrySeconds > 0} title={retrySeconds > 0 ? `${copy.retryIn} ${formatCountdown(retrySeconds)}` : copy.refresh}><RefreshCw size={12} className={refreshing ? "is-spinning" : ""} />{refreshing ? copy.loading : copy.refresh}</button></div>
    </div>}
  </div>;
}
