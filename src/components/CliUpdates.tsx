import { Download, RefreshCw } from "lucide-react";
import { useAppI18n } from "../i18n";
import { checkCliUpdate, updateCli, useCliUpdateStore } from "../store/cliUpdateStore";
import { useChatStore } from "../store/chatStore";
import { usePtyRuntimeStore } from "../store/ptyRuntimeStore";
import { RUNNER_LABELS, useSettingsStore } from "../store/settingsStore";
import { ProviderIcon } from "./ProviderIcon";
import { cliUpdateCopy, cliUpdateError } from "./cliUpdateCopy";
import "./cliUpdates.css";

export function CliUpdateIndicator() {
  const { locale } = useAppI18n(); const c = cliUpdateCopy(locale);
  const entries = useCliUpdateStore(state => state.entries);
  const available = Object.values(entries).filter(entry => !entry.error && entry.result?.installed && entry.result.latest && entry.result.updateAvailable);
  if (!available.length) return null;
  const label = `${available.length} ${c.count}`;
  const title = available.map(entry => `${RUNNER_LABELS[entry.result!.provider]}: ${entry.result!.installed} → ${entry.result!.latest}`).join("\n");
  return <button type="button" className="ad-cli-update-indicator" aria-label={label} title={`${c.link}\n${title}`} onClick={() => { useSettingsStore.getState().setTab("system"); useSettingsStore.getState().openSettings(); }}><Download size={13} /><span>{label}</span><i aria-hidden="true" /></button>;
}

export function CliUpdateShortcut() {
  const { locale } = useAppI18n(); const c = cliUpdateCopy(locale);
  const entries = useCliUpdateStore(state => state.entries);
  const count = Object.values(entries).filter(entry => entry.result?.updateAvailable).length;
  return <button type="button" className="ad-icon-button" title={c.link} aria-label={c.link} onClick={() => { useSettingsStore.getState().setTab("system"); useSettingsStore.getState().openSettings(); }}><Download size={13}/>{count > 0 && <span>{count}</span>}</button>;
}
export function CliUpdates() {
  const { locale } = useAppI18n(); const c = cliUpdateCopy(locale);
  const entries = useCliUpdateStore(state => state.entries);
  const chatBusy = useChatStore(state => Object.values(state.threads).some(thread => thread.busy));
  const nativeBusy = usePtyRuntimeStore(state => Object.keys(state.sessions).length > 0);
  const busy = chatBusy || nativeBusy;
  const updating = Object.values(entries).some(entry => entry.updating);
  const checking = Object.values(entries).some(entry => entry.checking);
  return <section className="ad-cli-updates" aria-label={c.title}>
    <header><h3>{c.title}</h3><button className="ad-button" disabled={checking || updating} onClick={() => void Promise.allSettled((["claude-code", "codex", "gemini"] as const).map(checkCliUpdate))}><RefreshCw size={14} className={checking ? "ad-spin" : undefined}/>{checking ? c.checking : c.check}</button></header>
    <p>{c.description}</p>
    {(["claude-code", "codex", "gemini"] as const).map(provider => { const entry = entries[provider]; const result = entry?.result; return <article key={provider} aria-label={RUNNER_LABELS[provider]}>
      <div className="ad-cli-name"><ProviderIcon provider={provider} size={24}/><strong>{RUNNER_LABELS[provider]}</strong><span role="status">{entry?.updating ? c.updating : entry?.checking ? c.checking : result?.updateAvailable ? c.available : result?.installed && result.latest ? c.current : c.waiting}</span></div>
      <div className="ad-cli-versions"><span>{c.installed} <code>{result?.installed || c.missing}</code></span><span>{c.latest} <code>{result?.latest || "—"}</code></span><button className="ad-button" disabled={busy || updating || checking || !result?.updateAvailable || result.method === "manual"} onClick={() => void updateCli(provider)}><Download size={14}/>{entry?.updating ? c.updating : c.update}</button></div>
      {result?.executable && <code className="ad-cli-path" title={result.executable}>{result.executable}</code>}
      {entry?.error && <p role="alert">{cliUpdateError(entry.error, c)}</p>}
      {entry?.updated && !entry.error && <p role="status">{c.updated}</p>}
      {result?.installed && result.method === "manual" && <p>{c.manual}</p>}
      {entry?.checkedAt && <small>{c.checked}: {new Date(entry.checkedAt).toLocaleTimeString(locale)}</small>}
    </article>; })}
    {busy && <p role="status">{c.busy}</p>}
    <small>{c.source}. {c.account}</small>
  </section>;
}
