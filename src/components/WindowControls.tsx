import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useAppI18n } from "../i18n";

export function WindowControls() {
  const { t } = useAppI18n();
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    const win = getCurrentWindow();
    const sync = () => void win.isMaximized().then(value => { if (!disposed) setMaximized(value); });
    sync();
    const unlisten = win.onResized(sync);
    return () => { disposed = true; void unlisten.then(fn => fn()); };
  }, []);
  const run = (action: () => Promise<unknown>) => void action().catch(e => setError(String(e)));
  return <div className="ad-window-controls" onDoubleClick={e => e.stopPropagation()}>
    {error && <span className="ad-window-error" role="alert">{error}</span>}
    <button aria-label={t("trafficLights.minimize")} title={t("trafficLights.minimize")} onClick={() => run(() => getCurrentWindow().minimize())}>
      <svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 6.5h10" fill="none" stroke="currentColor" /></svg>
    </button>
    <button aria-label={t(maximized ? "trafficLights.restore" : "trafficLights.maximize")} title={t(maximized ? "trafficLights.restore" : "trafficLights.maximize")} onClick={() => run(() => getCurrentWindow().toggleMaximize())}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">{maximized ? <path d="M3.5 3.5v-2h7v7h-2M1.5 3.5h7v7h-7z" /> : <rect x="1.5" y="1.5" width="9" height="9" />}</svg>
    </button>
    <button className="ad-window-close" aria-label={t("trafficLights.close")} title={t("trafficLights.close")} onClick={() => run(() => invoke("exit_app"))}>
      <svg width="12" height="12" viewBox="0 0 12 12"><path d="m1.5 1.5 9 9m0-9-9 9" fill="none" stroke="currentColor" /></svg>
    </button>
  </div>;
}
