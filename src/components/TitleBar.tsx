import { Network, Settings2 } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppI18n } from "../i18n";
import { useSettingsStore } from "../store/settingsStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { WindowControls } from "./WindowControls";
import { CliUpdateIndicator } from "./CliUpdates";
import { AppUpdateIndicator } from "./AppUpdates";
import type { ReactNode } from "react";

export function TitleBar({ onAgents, navigation }: { onAgents?: () => void; navigation?: ReactNode }) {
  const { t, locale } = useAppI18n();
  const openSettings = useSettingsStore(s => s.openSettings);
  const workspace = useWorkspaceStore(s => s.workspaces.find(w => w.id === s.activeWorkspaceId));
  return <header className="ad-titlebar" data-tauri-drag-region onDoubleClick={e => {
    if (!(e.target as HTMLElement).closest("button") && "__TAURI_INTERNALS__" in window) void getCurrentWindow().toggleMaximize();
  }}>
    <div className="ad-brand" data-tauri-drag-region>
      <img src="/agentdeck-icon.png" alt="" width="28" height="28" draggable={false} />
      <strong data-tauri-drag-region>Agentdeck</strong>
      <span className="ad-titlebar-divider" />
      <span className="ad-project-name" data-tauri-drag-region>{workspace?.name ?? t("workbench.welcome.noWorkspace")}</span>
    </div>
    <div className="ad-titlebar-actions">
      {navigation}
      <CliUpdateIndicator />
      <AppUpdateIndicator />
      <button className="ad-button ad-button-ghost" onClick={onAgents} aria-label={locale.startsWith("en") ? "Agents" : "Agentes"}><Network size={16} />{locale.startsWith("en") ? "Agents" : "Agentes"}</button>
      <button className="ad-icon-button" onClick={() => openSettings()} title={t("titleBar.settings")} aria-label={t("titleBar.settings")}><Settings2 size={16} /></button>
      <WindowControls />
    </div>
  </header>;
}
