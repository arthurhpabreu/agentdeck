import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "./desktop.css";
import { MotionConfig } from "framer-motion";
import { ensureI18n } from "./i18n/config";
import { resolveEffectiveLocale } from "./i18n/locale";
import { useSettingsStore } from "./store/settingsStore";
import { startActivityTracking } from "./store/agentActivityStore";
import { bootstrapPersistState } from "./store/persistStorage";
import { AppErrorBoundary, StartupError } from "./components/AppErrorBoundary";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

async function main() {
  await bootstrapPersistState();
  const locale = resolveEffectiveLocale(useSettingsStore.getState().settings.locale);
  await ensureI18n(locale);
  const stopTracking = await startActivityTracking();
  if (import.meta.hot) import.meta.hot.dispose(stopTracking);

  root.render(
    <React.StrictMode>
      <AppErrorBoundary><MotionConfig reducedMotion="user"><App /></MotionConfig></AppErrorBoundary>
    </React.StrictMode>
  );
}

void main().catch(error => root.render(<StartupError error={error} />));
