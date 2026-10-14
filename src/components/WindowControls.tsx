import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useAppI18n } from "../i18n";
import { getRuntimePlatform } from "../services/platform";

export function WindowControls() {
  const { t } = useAppI18n();
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState("");
  const isMac = getRuntimePlatform().os === "macos";
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    const win = getCurrentWindow();
    const sync = () => {
      void win.isMaximized().then(value => { if (!disposed) setMaximized(value); }).catch(() => {});
      if (isMac) void win.isFullscreen().then(value => { if (!disposed) setFullscreen(value); }).catch(() => {});
    };
    sync();
    const unlisten = win.onResized(sync);
    return () => { disposed = true; void unlisten.then(fn => fn()); };
  }, [isMac]);
  const run = (action: () => Promise<unknown>) => void action().catch(e => setError(String(e)));
  const expandLabel = isMac ? fullscreen ? "trafficLights.exitFullscreen" : "trafficLights.fullscreen" : maximized ? "trafficLights.restore" : "trafficLights.maximize";
  const minimizeButton = <button key="minimize" className="ad-window-minimize" aria-label={t("trafficLights.minimize")} title={t("trafficLights.minimize")} onClick={() => run(() => getCurrentWindow().minimize())}>
      <svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 6.5h10" fill="none" stroke="currentColor" /></svg>
    </button>;
  const expandButton = <button key="expand" className="ad-window-expand" aria-label={t(expandLabel)} title={t(expandLabel)} onClick={() => run(async () => {
      const win = getCurrentWindow();
      if (isMac) { const next = !(await win.isFullscreen()); await win.setFullscreen(next); setFullscreen(next); }
      else await win.toggleMaximize();
    })}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">{isMac ? <path d="M1 4V1h3M8 11h3V8M1 1l4 4m6 6L7 7" /> : maximized ? <path d="M3.5 3.5v-2h7v7h-2M1.5 3.5h7v7h-7z" /> : <rect x="1.5" y="1.5" width="9" height="9" />}</svg>
    </button>;
  const closeButton = <button key="close" className="ad-window-close" aria-label={t(isMac ? "trafficLights.closeWindow" : "trafficLights.close")} title={t(isMac ? "trafficLights.closeWindow" : "trafficLights.close")} onClick={() => run(() => isMac ? getCurrentWindow().close() : invoke("exit_app"))}>
      <svg width="12" height="12" viewBox="0 0 12 12"><path d="m1.5 1.5 9 9m0-9-9 9" fill="none" stroke="currentColor" /></svg>
    </button>;
  return <div className={`ad-window-controls${isMac ? " is-macos" : ""}`} onDoubleClick={e => e.stopPropagation()}>
    {error && <span className="ad-window-error" role="alert">{error}</span>}
    {isMac ? [closeButton, minimizeButton, expandButton] : [minimizeButton, expandButton, closeButton]}
  </div>;
}
