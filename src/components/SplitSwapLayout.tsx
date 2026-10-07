import { createContext, lazy, Suspense, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAppI18n } from "../i18n";
import { resetWorkbenchMode } from "../services/workbenchCommands";
import { useSessionStore } from "../store/sessionStore";
import { useWorkspaceStore } from "../store/workspaceStore";

const SessionDetail = lazy(() => import("./SessionDetail").then(module => ({ default: module.SessionDetail })));
const SessionContainer = createContext<HTMLDivElement | null>(null);

/** Preserve the conversation when opening an editor; its position is always the center. */
export function SplitSwapProvider({ children, sessionDetailEmptyState }: { children: ReactNode; sessionDetailEmptyState?: ReactNode }) {
  const [container] = useState(() => {
    const element = document.createElement("div");
    Object.assign(element.style, { width: "100%", height: "100%", minHeight: "0", overflow: "hidden" });
    return element;
  });
  const sessions = useSessionStore(state => state.sessions);
  const expandedSessionId = useSessionStore(state => state.expandedSessionId);
  const activeWorkspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const session = sessions.find(item => item.id === expandedSessionId && item.workspaceId === activeWorkspaceId);
  return <SessionContainer.Provider value={container}>
    {children}
    {createPortal(<Suspense fallback={sessionDetailEmptyState ?? null}><SessionDetail mode="embedded" showPanelHeader={false} emptyState={sessionDetailEmptyState} openSessionId={session?.id ?? null} /></Suspense>, container)}
  </SessionContainer.Provider>;
}

export function SplitDetailHost() {
  const { t } = useAppI18n();
  const container = useContext(SessionContainer);
  const host = useRef<HTMLDivElement>(null);
  const sessions = useSessionStore(state => state.sessions);
  const expandedSessionId = useSessionStore(state => state.expandedSessionId);
  const activeWorkspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const session = sessions.find(item => item.id === expandedSessionId && item.workspaceId === activeWorkspaceId);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element || !container) return;
    element.appendChild(container);
    return () => { if (container.parentElement === element) element.removeChild(container); };
  }, [container]);

  return <div style={{ width: "100%", height: "100%", minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
    <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px 6px", flexShrink: 0 }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 10, color: "var(--ci-text-dim)", fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase" }}>{t("split.detailTitleSession")}</div>
        <div style={{ marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, fontWeight: 600, color: "var(--ci-text-muted)" }}>{session?.name ?? t("split.sessionDetail")}</div>
      </div>
      {session && <button type="button" className="ad-button ad-button-ghost" onClick={() => { useSessionStore.getState().setExpandedSession(null); resetWorkbenchMode(); }}>{t("split.collapse")}</button>}
    </header>
    <div ref={host} style={{ flex: 1, minHeight: 0, position: "relative" }} />
  </div>;
}
