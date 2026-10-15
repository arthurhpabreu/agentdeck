import { LoaderCircle, RefreshCw } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { useMultiAgentEconomy } from "../../store/multiAgentEconomyStore";
import { useSessionStore } from "../../store/sessionStore";
import { useSettingsStore, type RunnerType } from "../../store/settingsStore";
import { multiAgentCopy } from "./multiAgentCopy";
import "./multiAgentEconomy.css";

export function MultiAgentEconomy({ provider, workdir, sessionId, disabled = false }: { provider?: RunnerType; workdir?: string; sessionId?: string; disabled?: boolean }) {
  const { locale } = useAppI18n(), c = multiAgentCopy(locale);
  const sessionRunner = useSessionStore(state => sessionId ? state.sessions.find(session => session.id === sessionId)?.runner : undefined);
  const settings = useSettingsStore(state => state.settings);
  const runnerType = provider ?? sessionRunner?.type ?? settings.runner.type;
  const fallback = useSettingsStore.getState().getRunnerConfigForType(runnerType);
  const cliPath = sessionRunner?.type === runnerType ? sessionRunner.cliPath ?? fallback.cliPath : fallback.cliPath;
  const selected = sessionRunner?.type === runnerType ? sessionRunner : fallback;
  const model = selected.model === "default" ? undefined : selected.model || undefined;
  const context = { runnerType, cliPath: cliPath || undefined, workdir, model, effort: selected.effort };
  const { status, enabled, refreshing, changing, error, saveError, refresh, setEnabled } = useMultiAgentEconomy(context);
  const desktop = "__TAURI_INTERNALS__" in window;
  const effortLabel = (effort: string) => c[effort as "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"] || effort;
  return <section className="ad-multi-agent-economy" aria-label={c.title}>
    <div className="ad-multi-agent-heading"><h4>{c.title}</h4><button type="button" className="ad-economy-switch" role="switch" aria-label={c.toggle} aria-checked={enabled === true} disabled={disabled || changing || enabled === undefined || !desktop} onClick={() => void setEnabled(!enabled)}><span>{changing && <LoaderCircle size={10} />}</span></button></div>
    <p>{changing ? c.saving : c.future}</p><p>{c.description}</p><p>{c.preserved}</p>
    {!desktop && <p>{c.desktop}</p>}
    {desktop && !status && !error && <p role="status">{c.checking}</p>}
    {status?.available && status.profile && <dl data-enabled={enabled === true}>
      {(["coordinator", "explorer", "advisor"] as const).map(role => <div key={role}><dt>{c[role]}</dt><dd><strong title={role === "coordinator" && !model ? c.defaultModel : status.profile![role].model}>{role === "coordinator" && !model ? c.defaultModel : status.profile![role].label}</strong>{status.profile![role].effort ? <small>{effortLabel(status.profile![role].effort!)}</small> : role === "coordinator" && <small>{c.defaultEffort}</small>}{role === "advisor" && <small>{status.profile!.advisorMode === "native" ? c.nativeAdvisor : c.subagentAdvisor}</small>}</dd></div>)}
    </dl>}
    {status?.available && status.profile?.advisorMode === "native" && <p>{c.nativeHint}</p>}
    {status && !status.available && <p>{c[status.reason ?? "models_unavailable"]}</p>}
    <p className="ad-multi-agent-estimate">{c.estimate}</p>
    {error && <p className="is-error" role="alert">{c.error}</p>}
    {saveError && <p className="is-error" role="alert">{c.saveError}</p>}
    <button type="button" className="ad-multi-agent-refresh" disabled={refreshing || changing || !desktop} onClick={() => void refresh(context, true)}><RefreshCw size={12} />{c.refresh}</button>
  </section>;
}
