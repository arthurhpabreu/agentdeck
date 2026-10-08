import { Download, ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppI18n } from "../i18n";
import { checkAppUpdate, downloadAppUpdate, installAppUpdate, useAppUpdateStore } from "../store/appUpdateStore";
import { useSettingsStore } from "../store/settingsStore";
import { useChatStore } from "../store/chatStore";
import { usePtyRuntimeStore } from "../store/ptyRuntimeStore";
import { appUpdateCopy, appUpdateError } from "./appUpdateCopy";
import "./cliUpdates.css";

export function AppUpdateIndicator() {
  const { locale } = useAppI18n(); const c = appUpdateCopy(locale);
  const state = useAppUpdateStore();
  if (!state.result?.supported || !state.result.updateAvailable) return null;
  const label = state.downloaded ? c.install : state.downloading ? c.downloading : `${c.available} ${state.result.latest}`;
  return <button type="button" className="ad-cli-update-indicator ad-app-update-indicator" title={label} aria-label={label}
    onClick={() => {
      useSettingsStore.getState().setTab("system"); useSettingsStore.getState().openSettings();
      if (!state.downloaded) void downloadAppUpdate();
    }}><Download size={13} /><span>{state.downloaded ? c.install : `Agent Deck ${state.result.latest}`}</span><i aria-hidden="true" /></button>;
}
export function AppUpdates() {
  const { locale } = useAppI18n(); const c = appUpdateCopy(locale);
  const state = useAppUpdateStore();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (state.downloading || state.downloaded || state.error && state.result?.updateAvailable) panel.current?.scrollIntoView({ block: "nearest" });
  }, [state.downloading, state.downloaded, state.error, state.result?.updateAvailable]);
  const chatBusy = useChatStore(s => Object.values(s.threads).some(t => t.busy));
  const nativeBusy = usePtyRuntimeStore(s => Object.keys(s.sessions).length > 0);
  const busy = chatBusy || nativeBusy;
  const working = state.checking || state.downloading || state.installing;
  const status = state.installerOpened ? c.opened : state.downloading ? c.downloading : state.downloaded ? c.ready : state.checking ? c.checking : state.result ? state.result.supported ? state.result.updateAvailable ? c.available : c.current : c.unsupported : c.pending;
  return <section ref={panel} className="ad-cli-updates ad-app-updates" aria-label={c.title}>
    <header><h3>{c.title}</h3><button type="button" className="ad-button" disabled={working || state.installerOpened} onClick={() => void checkAppUpdate()}><RefreshCw size={14} className={state.checking ? "ad-spin" : undefined} />{state.checking ? c.checking : c.check}</button></header>
    <p>{c.description}</p>
    <article><div className="ad-cli-versions"><span>{c.installed} <code>{state.result?.installed || "—"}</code></span><span>{c.latest} <code>{state.result?.latest || "—"}</code></span>
      {state.downloaded ? <button type="button" className="ad-button ad-button-primary" disabled={busy || working || state.installerOpened} onClick={() => void installAppUpdate()}>{state.installing ? c.installing : c.install}</button>
        : <button type="button" className="ad-button" disabled={working || !state.result?.updateAvailable || !state.result.supported} onClick={() => void downloadAppUpdate()}><Download size={14} />{state.downloading ? c.downloading : c.download}</button>}
    </div><p role="status" aria-live="polite">{status}</p>
      {busy && state.result?.updateAvailable && <p>{c.busy}</p>}
      {state.error && <p role="alert">{appUpdateError(state.error, c)}</p>}
    </article>
    <button type="button" className="ad-button ad-button-ghost" onClick={() => void openUrl("https://github.com/arthurhpabreu/agentdeck/releases")}><ExternalLink size={13} />{c.link}</button>
    <p><small>{c.source}</small></p>
  </section>;
}
