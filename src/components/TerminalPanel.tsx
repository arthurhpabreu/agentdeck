import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronLeft, PanelRightClose, Plus, TerminalSquare, X } from "lucide-react";
import { useAppI18n } from "../i18n";
import { useSettingsStore, type SplitWidgetTerminalItem } from "../store/settingsStore";
import { useSessionStore, type ClaudeSession } from "../store/sessionStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import "./terminalPanel.css";

const PtyTerminal = lazy(() => import("./PtyTerminal").then(module => ({ default: module.PtyTerminal })));
interface OpenTerminal {
  key: string; tabKey: string; workspaceId: string; sessionId?: string; workdir: string; ptyId: string;
}
const safeId = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
function pathHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

/** A fixed shell surface. Legacy widget coordinates never determine its layout. */
export function TerminalPanel({ session }: { session: ClaudeSession | null }) {
  const { t } = useAppI18n();
  const collapsed = useSettingsStore(state => state.settings.splitWidgetPanelCollapsed);
  const items = useSettingsStore(state => state.settings.splitWidgetCanvas.items);
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const sessions = useSessionStore(state => state.sessions);
  const readyIds = useSessionStore(state => state.worktreeReadyIds);
  const project = workspaces.find(item => item.id === activeWorkspaceId);
  const currentSession = session?.workspaceId === project?.id ? session : null;
  const workdir = currentSession?.worktreePath || currentSession?.workdir || project?.path || "";
  const ready = !!project && !!workdir && (!currentSession || readyIds.has(currentSession.id));
  // Preserve every tab from the former draggable cards, including hidden cards.
  const tabs = useMemo(() => items.flatMap(item => item.type === "terminal"
    ? item.tabs.map(tab => ({ ...tab, widgetId: item.id, key: `${item.id}/${tab.id}`, selected: tab.id === item.activeTabId })) : []), [items]);
  const [selection, setSelection] = useState("");
  const activeTab = tabs.find(tab => tab.key === selection) ?? tabs.find(tab => tab.selected) ?? tabs[0];
  const [opened, setOpened] = useState<OpenTerminal[]>([]);
  const contextKey = project ? JSON.stringify([project.id, currentSession?.id ?? null, workdir, activeTab?.key]) : "";
  const id = useId();
  const expandButton = useRef<HTMLButtonElement>(null);
  const isWindows = navigator.userAgent.toLowerCase().includes("windows");

  useEffect(() => {
    if (collapsed || !ready || !project || !activeTab) return;
    setOpened(current => current.some(terminal => terminal.key === contextKey) ? current : [...current, {
      key: contextKey, tabKey: activeTab.key, workspaceId: project.id, sessionId: currentSession?.id, workdir,
      ptyId: `widget-${safeId(currentSession?.id ?? `workspace-${project.id}`)}-${safeId(activeTab.ptySessionKey)}-${pathHash(workdir + activeTab.key)}`,
    }]);
  }, [collapsed, ready, contextKey, activeTab, project, currentSession?.id, workdir]);

  useEffect(() => {
    setOpened(current => {
      const next = current.filter(terminal => tabs.some(tab => tab.key === terminal.tabKey)
        && workspaces.some(workspace => workspace.id === terminal.workspaceId)
        && (!terminal.sessionId || sessions.some(item => item.id === terminal.sessionId && item.workspaceId === terminal.workspaceId)));
      return next.length === current.length ? current : next;
    });
  }, [tabs, workspaces, sessions]);

  const selectTab = (key: string) => {
    setSelection(key);
    const tab = tabs.find(item => item.key === key);
    if (!tab) return;
    const { settings, patchSettings } = useSettingsStore.getState();
    patchSettings({ splitWidgetCanvas: { ...settings.splitWidgetCanvas, items: settings.splitWidgetCanvas.items.map(item =>
      item.type === "terminal" && item.id === tab.widgetId ? { ...item, activeTabId: tab.id } : item) } });
  };
  const addTab = () => {
    const { settings, patchSettings } = useSettingsStore.getState();
    const target = settings.splitWidgetCanvas.items.find((item): item is SplitWidgetTerminalItem => item.type === "terminal");
    if (!target) return;
    const nextNumber = Math.max(0, ...tabs.map(tab => Number(tab.title.match(/^Terminal\s+(\d+)$/)?.[1] ?? 0))) + 1;
    const unique = crypto.randomUUID();
    const tab = { id: `terminal-tab-${unique}`, title: `Terminal ${nextNumber}`, ptySessionKey: `terminal-pty-${unique}` };
    patchSettings({ splitWidgetCanvas: { ...settings.splitWidgetCanvas, items: settings.splitWidgetCanvas.items.map(item =>
      item.id === target.id ? { ...target, tabs: [...target.tabs, tab], activeTabId: tab.id } : item) } });
    setSelection(`${target.id}/${tab.id}`);
  };
  const closeTab = (key: string) => {
    if (tabs.length <= 1) return;
    const index = tabs.findIndex(tab => tab.key === key);
    const tab = tabs[index];
    if (!tab) return;
    const { settings, patchSettings } = useSettingsStore.getState();
    patchSettings({ splitWidgetCanvas: { ...settings.splitWidgetCanvas, items: settings.splitWidgetCanvas.items.flatMap(item => {
      if (item.type !== "terminal" || item.id !== tab.widgetId) return [item];
      const nextTabs = item.tabs.filter(candidate => candidate.id !== tab.id);
      return nextTabs.length ? [{ ...item, tabs: nextTabs, activeTabId: item.activeTabId === tab.id ? nextTabs[0].id : item.activeTabId }] : [];
    }) } });
    const next = tabs[index - 1] ?? tabs[index + 1];
    if (activeTab?.key === key && next) setSelection(next.key);
    requestAnimationFrame(() => document.getElementById(`${id}-tab-${encodeURIComponent(activeTab?.key === key ? next.key : activeTab.key)}`)?.focus());
  };
  const collapse = () => {
    useSettingsStore.getState().patchSettings({ splitWidgetPanelCollapsed: true });
    requestAnimationFrame(() => expandButton.current?.focus());
  };

  return <>
    {collapsed && <button ref={expandButton} type="button" className="ad-terminal-rail" aria-label={t("app.split.expandWidgets")} title={t("app.split.expandWidgets")} aria-expanded={false} aria-controls={`${id}-panel`}
      onClick={() => useSettingsStore.getState().patchSettings({ splitWidgetPanelCollapsed: false })}>
      <TerminalSquare size={16} /><span>{t("app.split.widgets")}</span><ChevronLeft size={13} />
    </button>}
    <aside id={`${id}-panel`} className="ad-terminal-dock" aria-label={t("split.terminal")} hidden={collapsed}>
      <header className="ad-terminal-header"><TerminalSquare size={17} /><h2>{t("split.terminal")}</h2>
        <button type="button" className="ad-icon-button" aria-label={t("terminalPanel.collapse")} title={t("terminalPanel.collapse")} onClick={collapse}><PanelRightClose size={17} /></button>
      </header>
      <p className="ad-terminal-path" title={workdir}>{workdir || t("terminalPanel.noProject")}</p>
      <div className="ad-terminal-tabs-row">
        <div role="tablist" aria-label={t("terminalPanel.tabs")} className="ad-terminal-tabs" onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !(event.target as HTMLElement).matches('[role="tab"]')) return;
          event.preventDefault();
          const index = tabs.findIndex(tab => tab.key === activeTab?.key);
          const next = tabs[event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
          if (next) { selectTab(next.key); document.getElementById(`${id}-tab-${encodeURIComponent(next.key)}`)?.focus(); }
        }}>
          {tabs.map(tab => <div className="ad-terminal-tab" key={tab.key} data-active={tab.key === activeTab?.key}>
            <button type="button" role="tab" id={`${id}-tab-${encodeURIComponent(tab.key)}`} aria-controls={`${id}-viewport`} aria-selected={tab.key === activeTab?.key} tabIndex={tab.key === activeTab?.key ? 0 : -1} onClick={() => selectTab(tab.key)}>{tab.title}</button>
            {tabs.length > 1 && <button type="button" className="ad-terminal-tab-close" aria-label={t("editor.closeTab", { title: tab.title })} title={t("editor.closeTab", { title: tab.title })} onClick={() => closeTab(tab.key)}><X size={12} /></button>}
          </div>)}
        </div>
        <button type="button" className="ad-icon-button" aria-label={t("split.newTerminalTab")} title={t("split.newTerminalTab")} disabled={!ready} onClick={addTab}><Plus size={17} /></button>
      </div>
      <div className="ad-terminal-viewport" id={`${id}-viewport`} role="tabpanel" aria-labelledby={activeTab ? `${id}-tab-${encodeURIComponent(activeTab.key)}` : undefined}>
        {!ready && <p className="ad-terminal-empty" role="status">{project ? t("terminalPanel.preparing") : t("terminalPanel.noProject")}</p>}
        {opened.map(terminal => <div key={terminal.key} className="ad-terminal-runtime" hidden={terminal.key !== contextKey || !ready}>
          <Suspense fallback={<p className="ad-terminal-empty">{t("terminalPanel.preparing")}</p>}><PtyTerminal sessionId={terminal.ptyId} command={isWindows ? "cmd.exe" : "sh"} args={isWindows ? ["/K"] : ["-i"]}
            workdir={terminal.workdir} active={!collapsed && ready && terminal.key === contextKey} enableWindowsCtrlCv />
          </Suspense>
        </div>)}
      </div>
    </aside>
  </>;
}
