import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { useAppI18n } from "../i18n";
import { useSessionStore } from "../store/sessionStore";
import { useSettingsStore, isGlassTheme } from "../store/settingsStore";
import { SessionPromptComposer } from "./session/SessionPromptComposer";
import { SessionRunnerSurface } from "./session/SessionRunnerSurface";
import { useSessionRunnerController } from "../hooks/useSessionRunnerController";
import { AgentSessionToolbar } from "./session/AgentSessionToolbar";
import { SessionFollowup } from "./session/SessionFollowup";
import { createAgentSessionArgs } from "../services/agentAdapters";
import { MessageSquare, TerminalSquare } from "lucide-react";
import { useWorkspaceStore } from "../store/workspaceStore";
import { useWorkbenchStore } from "../store/workbenchStore";
import { SessionMemoryControl } from "./memory/SessionMemoryControl";
import { StructuredChat } from "./session/StructuredChat";
import { chatCopy } from "./session/chatCopy";
import { useChatStore } from "../store/chatStore";
import { stopPtySession, usePtyRuntimeStore } from "../store/ptyRuntimeStore";
import { effortCopy } from "./session/effortCopy";
import { TokenEconomyControl } from "./economy/TokenEconomyControl";

const SPRING = {
  type: "spring" as const,
  stiffness: 380,
  damping: 28,
  mass: 0.9,
};

type DetailPresentation = "overlay" | "embedded";

function SessionDetailEmptyState({ message }: { message: ReactNode }) {
  return (
    <div style={{
      width: "100%",
      height: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      color: "var(--ci-text-dim)",
      fontSize: 12,
      textAlign: "center",
      lineHeight: 1.7,
    }}>
      <div style={{
        maxWidth: 240,
        padding: "18px 20px",
        borderRadius: 16,
        background: "var(--ci-surface)",
        border: "1px solid var(--ci-toolbar-border)",
      }}>
        {message}
      </div>
    </div>
  );
}

interface InstallTerminalProps {
  installId: string;
  installCmd: string;
  onFinished: () => void;
}

function InstallTerminal({ installId, installCmd, onFinished }: InstallTerminalProps) {
  const { t } = useAppI18n();
  const ptyFontSize = useSettingsStore((s) => s.settings.ptyFontSize);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const isWindows = navigator.userAgent.toLowerCase().includes("windows");

  useEffect(() => {
    if (!containerRef.current) return;
    let term: import("@xterm/xterm").Terminal | undefined;
    let fit: import("@xterm/addon-fit").FitAddon | undefined;
    const listeners: Array<Promise<() => Promise<void> | void>> = [];
    let cancelled = false;
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    let ownsProcess = false;

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      if (cancelled || !containerRef.current) return;

      term = new Terminal({
        theme: { background: "#0a0a0c", foreground: "#e2e8f0", cursor: "#60a5fa" },
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: ptyFontSize,
        lineHeight: 1.4,
        scrollback: 2000,
        allowTransparency: true,
        convertEol: true,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
      fit.fit();
      termRef.current = term;
      fitRef.current = fit;


      const cols = Math.max(term.cols, 40);
      const rows = Math.max(term.rows, 10);

      const u1 = listen<{ session_id: string; data: string }>("pty-data", ({ payload }) => {
        if (payload.session_id !== installId) return;
        try {
          const bin = atob(payload.data);
          const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
          termRef.current?.write(bytes);
        } catch {}
      });

      const u2 = listen<{ session_id: string }>("pty-exit", ({ payload }) => {
        if (payload.session_id !== installId) return;
        termRef.current?.writeln(`\r\n\x1b[90m${t("session.installDoneRerun")}\x1b[0m`);
        finishTimer = setTimeout(() => { if (!cancelled) onFinishedRef.current(); }, 800);
      });

      listeners.push(u1, u2);
      await Promise.all(listeners);
      if (cancelled) {
        listeners.forEach((promise) => {
          void promise.then((f) => f()).catch(() => {});
        });
      }
      if (cancelled) return;
      ownsProcess = true;
      await invoke("start_pty_session", {
        sessionId: installId,
        workdir: "~",
        command: isWindows ? "cmd.exe" : "sh",
        args: isWindows ? ["/d", "/c", installCmd] : ["-c", installCmd],
        cols,
        rows,
        env: null,
      }).then(() => {
        if (cancelled) void invoke("stop_pty_session", { sessionId: installId });
      }).catch((e) => {
        term?.writeln(`\x1b[31m${t("session.installFailed", { error: String(e) })}\x1b[0m`);
      });

    })();

    return () => {
      cancelled = true;
      if (finishTimer) clearTimeout(finishTimer);
      if (ownsProcess) void invoke("stop_pty_session", { sessionId: installId }).catch(() => {});
      listeners.forEach((promise) => {
        void promise.then((f) => f()).catch(() => {});
      });
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installCmd, installId, isWindows]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      fitRef.current?.fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isWindows]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%", background: "#0a0a0c" }} />;
}

interface PanelProps {
  sessionId: string;
  isOpen: boolean;
  onClose: () => void;
  presentation: DetailPresentation;
  showHeader: boolean;
  autoLaunch?: boolean;
  nativeQuery?: string;
}

function NativeSessionPanel({ sessionId, isOpen, onClose, presentation, showHeader, autoLaunch, nativeQuery }: PanelProps) {
  const { t } = useAppI18n();
  const isGlass = isGlassTheme(useSettingsStore((s) => s.settings.theme));
  const textShadow = isGlass ? "var(--ci-glass-text-shadow)" : "none";
  const [hidden, setHidden] = useState(!isOpen);
  const hasOpenedRef = useRef(false);

  const {
    session,
    runner,
    runnerBadge,
    queryInputRef,
    pendingQuery,
    setPendingQuery,
    querySent,
    installing,
    setInstalling,
    installId,
    launchPrompt,
    ptyEverActive,
    cliAvailable,
    recheckCli,
    handlePtyReady,
    handlePtyWaiting,
    handlePtyRunning,
    handlePtyError,
    handleInstall,
    handleSubmitQuery,
    handleLaunch,
    handleStop,
    handleSwitchRunner,
    supportsPromptLaunch,
    resumeSessionId,
    isResumeLaunch,
    cliCommand,
    installCmd,
    contextEnv,
  } = useSessionRunnerController({ sessionId, isOpen });

  const autoLaunched = useRef(false);
  useEffect(() => {
    if ((autoLaunch || nativeQuery) && cliAvailable === true && !autoLaunched.current) {
      autoLaunched.current = true;
      if (nativeQuery) handleSubmitQuery(nativeQuery);
      else if (!querySent) handleLaunch();
    }
  }, [autoLaunch, nativeQuery, cliAvailable, querySent, handleLaunch, handleSubmitQuery]);

  useEffect(() => {
    if (!isOpen) return;
    setHidden(false);
  }, [isOpen]);

  useEffect(() => {
    if (presentation !== "overlay") return;
    if (isOpen) {
      hasOpenedRef.current = true;
      invoke("resize_popup_full", { width: 700, height: 600 }).catch(() => {});
    } else if (hasOpenedRef.current) {
      invoke("restore_popup_bounds").catch(() => {});
    }
  }, [isOpen, presentation]);

  useEffect(() => {
    if (isOpen && !querySent) {
      const t = setTimeout(() => queryInputRef.current?.focus(), 350);
      return () => clearTimeout(t);
    }
  }, [isOpen, querySent, queryInputRef]);

  if (!session) return null;

  const waitingForPtyLaunch = querySent && !ptyEverActive && !isResumeLaunch;
  const cliBaseArgs = createAgentSessionArgs(runner.type, session.providerSessionId?.trim() || resumeSessionId, runner.model, runner.mode, runner, session.workdir);

  const isOverlay = presentation === "overlay";
  const panelRadius = isGlass ? "var(--ci-shell-radius)" : 14;
  const panelBackground = isGlass ? "transparent" : "var(--ci-pty-panel-bg)";
  const panelBorder = isGlass ? "none" : "1px solid var(--ci-pty-panel-border)";
  const titlebarBackground = isGlass ? "var(--ci-toolbar-bg)" : "var(--ci-pty-titlebar-bg)";
  const titlebarBorder = isGlass ? "none" : "1px solid var(--ci-pty-titlebar-bdr)";
  const titlebarText = isGlass ? "var(--ci-text)" : "var(--ci-pty-title-color)";
  const actionButtonText = isGlass ? "var(--ci-text-muted)" : "var(--ci-pty-btn-text)";
  const actionButtonHoverText = isGlass ? "var(--ci-text)" : "var(--ci-pty-btn-hover-text)";
  const runnerChipBackground = isGlass ? "var(--ci-accent-bg)" : "var(--ci-pty-runner-bg)";
  const runnerChipBorder = isGlass ? "1px solid var(--ci-accent-bdr)" : "1px solid var(--ci-pty-runner-border)";
  const runnerChipText = isGlass ? "var(--ci-accent)" : "var(--ci-pty-runner-text)";

  return (
    <motion.div
      initial={false}
      animate={isOpen
        ? { opacity: 1, pointerEvents: "auto" as const }
        : { opacity: 0, pointerEvents: "none" as const }
      }
      transition={SPRING}
      onAnimationComplete={() => {
        if (!isOpen) setHidden(true);
      }}
      style={{
        position: isOverlay ? "fixed" : "absolute",
        top: isOverlay ? 44 : 0,
        left: isOverlay ? 6 : 0,
        right: isOverlay ? 6 : 0,
        bottom: isOverlay ? 6 : 0,
        zIndex: hidden ? -1 : isOverlay ? 200 : 1,
        borderRadius: isOverlay ? panelRadius : 0,
        overflow: "hidden",
        background: panelBackground,
        backdropFilter: isGlass && !isOverlay ? "none" : isGlass ? "none" : "none",
        WebkitBackdropFilter: isGlass && !isOverlay ? "none" : isGlass ? "none" : "none",
        border: isOverlay ? panelBorder : "none",
        display: "flex",
        flexDirection: "column",
        visibility: hidden ? "hidden" : "visible",
        textShadow,
      }}
    >
      {showHeader && (
        <div
          data-tauri-drag-region={isOverlay ? "true" : undefined}
          style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "12px 16px 10px",
            borderBottom: titlebarBorder,
            flexShrink: 0,
            cursor: isOverlay ? "grab" : "default",
            userSelect: "none",
            WebkitUserSelect: "none",
            background: titlebarBackground,
          }}
        >


          <span data-tauri-drag-region={isOverlay ? "true" : undefined} style={{
            flex: 1, fontSize: 12, fontWeight: 600,
            color: titlebarText,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            cursor: isOverlay ? "grab" : "default",
            letterSpacing: -0.2,
          }}>
            {installing ? t("session.installingRunner", { runner: runnerBadge }) : session.name}
          </span>

          <span
            data-tauri-drag-region={isOverlay ? "true" : undefined}
            style={{
              fontSize: 10, padding: "2px 8px", borderRadius: 99,
              background: runnerChipBackground,
              border: runnerChipBorder,
              color: runnerChipText, fontFamily: "monospace",
              cursor: "default",
            }}
          >
            {runnerBadge}
          </span>

          {installing && (
            <button
              data-tauri-drag-region={isOverlay ? "true" : undefined}
              onClick={() => { setInstalling(false); recheckCli(); }}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                background: "none",
                border: "none",
                padding: "2px 2px",
                color: actionButtonText,
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
                transition: "color 0.12s, opacity 0.12s",
              }}
              onMouseEnter={e => {
                e.currentTarget.style.color = actionButtonHoverText;
                e.currentTarget.style.opacity = "0.8";
              }}
              onMouseLeave={e => {
                e.currentTarget.style.color = actionButtonText;
                e.currentTarget.style.opacity = "1";
              }}
            >
              {t("common.cancel")}
            </button>
          )}

          {!installing && (
            <button
              data-tauri-drag-region={isOverlay ? "true" : undefined}
              onClick={onClose}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                background: "none",
                border: "none",
                padding: "2px 2px",
                color: actionButtonText,
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
                transition: "color 0.12s, opacity 0.12s",
              }}
              onMouseEnter={e => {
                e.currentTarget.style.color = actionButtonHoverText;
                e.currentTarget.style.opacity = "0.8";
              }}
              onMouseLeave={e => {
                e.currentTarget.style.color = actionButtonText;
                e.currentTarget.style.opacity = "1";
              }}
            >
              {t("session.collapse")}
            </button>
          )}
        </div>
      )}

      <AgentSessionToolbar session={session} visible={isOpen} onStop={handleStop} />
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative", display: "flex", flexDirection: "column" }}>
        <SessionRunnerSurface
          isGlass={isGlass}
          isOpen={isOpen}
          installing={installing}
          installId={installId}
          installCmd={installCmd}
          recheckCli={recheckCli}
          querySent={querySent}
          ptyEverActive={ptyEverActive}
          sessionId={sessionId}
          cliCommand={cliCommand}
          cliBaseArgs={cliBaseArgs}
          workdir={session.workdir}
          launchPrompt={launchPrompt}
          supportsPromptLaunch={supportsPromptLaunch}
          handlePtyReady={handlePtyReady}
          handlePtyWaiting={handlePtyWaiting}
          handlePtyRunning={handlePtyRunning}
          handlePtyError={handlePtyError}
          contextEnv={contextEnv}
          InstallTerminal={InstallTerminal}
        />

        <motion.div
          initial={false}
          animate={(!querySent || waitingForPtyLaunch) && !installing ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.96, pointerEvents: "none" as const }}
          transition={{ duration: 0.18 }}
          style={{ position: "absolute", inset: 0 }}
        >
          {(!querySent || waitingForPtyLaunch) && !installing && (
            <SessionPromptComposer visible={isOpen} workdir={session.workdir} pendingQuery={pendingQuery} setPendingQuery={setPendingQuery} queryInputRef={queryInputRef} runner={runner} cliAvailable={cliAvailable} cliCommand={cliCommand} installCmd={installCmd} waitingForPtyLaunch={waitingForPtyLaunch} onSubmit={handleSubmitQuery} onLaunch={handleLaunch} onRunnerChange={handleSwitchRunner} onRunnerPatch={patch => useSessionStore.getState().updateSession(session.id, { runner: { ...runner, ...patch } })} onInstall={handleInstall} onRecheck={recheckCli} />
          )}
        </motion.div>
      </div>
      {querySent && ptyEverActive && !installing && <SessionFollowup sessionId={sessionId} visible={isOpen} />}
    </motion.div>
  );
}

function SessionPanel(props: PanelProps) {
  const { locale } = useAppI18n(); const c = chatCopy(locale);
  const session = useSessionStore(s => s.sessions.find(item => item.id === props.sessionId));
  const [native, setNative] = useState(session?.runner.type === "gemini");
  const [nativeMounted, setNativeMounted] = useState(native);
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [handoff, setHandoff] = useState({ revision: 0, query: "" });
  const busy = useChatStore(s => s.threads[props.sessionId]?.busy ?? false);
  const runtime = usePtyRuntimeStore(s => s.sessions[props.sessionId]);
  const nativeLive = !!runtime;
  const [switchError, setSwitchError] = useState("");
  const ec = effortCopy(locale);
  const stopNative = async () => { setSwitchError(""); try { await stopPtySession(props.sessionId); } catch (error) { setSwitchError(String(error)); } };
  if (!session) return null;
  const openNative = (query?: string) => {
    setSwitchError("");
    if (query && runtime) { setSwitchError(ec.busyNative); return; }
    if (query) setHandoff(value => ({ revision: value.revision + 1, query }));
    else if (!runtime) setHandoff(value => ({ revision: value.revision + 1, query: "" }));
    setNative(true); setNativeMounted(true); setAutoLaunch(true);
  };
  return <div style={{ position: props.presentation === "overlay" ? "fixed" : "absolute", inset: props.presentation === "overlay" ? "44px 6px 6px" : 0, display: props.isOpen ? "flex" : "none", flexDirection: "column", background: "var(--ci-bg)", minHeight: 0, zIndex: props.presentation === "overlay" ? 200 : 1 }}>
    <div className="ad-session-tabs" role="tablist" aria-label={c.chat}>
      <button role="tab" aria-selected={!native} disabled={session.runner.type === "gemini"} title={c.chat} onClick={() => setNative(false)}><MessageSquare size={14} />{c.chat}</button>
      <button role="tab" aria-selected={native} disabled={busy} title={busy ? c.runningSwitch : c.nativeHint} onClick={() => { setNative(true); setNativeMounted(true); }}><TerminalSquare size={14} />{c.native}</button>
      <span title={session.worktreePath || session.workdir}>{session.name}</span>
      <SessionMemoryControl sessionId={session.id} provider={session.runner.type} projectPath={session.workdir} onOpen={() => { useWorkspaceStore.getState().setActiveWorkspace(session.workspaceId); useWorkbenchStore.getState().setSidebarSection("memory"); }} />
      {session.runner.type !== "gemini" && <TokenEconomyControl provider={session.runner.type} sessionId={session.id} workdir={session.worktreePath || session.workdir} disabled={busy || nativeLive} visible={props.isOpen} />}
    </div>
    {!native && nativeLive && <div className="ad-native-busy" role="status"><span>{ec.busyNative}</span><button className="ad-button" disabled={runtime === "stopping"} onClick={() => void stopNative()}>{runtime === "stopping" ? ec.stopping : ec.stopNative}</button></div>}
    {!native && switchError && <div className="ad-notice" role="alert">{switchError}</div>}
    <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
      <div style={{ position: "absolute", inset: 0, display: native ? "none" : "block" }}><StructuredChat session={session} visible={props.isOpen && !native} onNative={openNative} nativeLive={nativeLive} /></div>
      {nativeMounted && <div style={{ position: "absolute", inset: 0, display: native ? "block" : "none" }}><NativeSessionPanel key={handoff.revision} {...props} presentation="embedded" isOpen={props.isOpen && native} autoLaunch={autoLaunch} nativeQuery={handoff.query} /></div>}
    </div>
  </div>;
}

export function SessionDetail({
  mode,
  emptyState,
  openSessionId,
  showPanelHeader = true,
}: {
  mode: DetailPresentation;
  emptyState?: ReactNode;
  openSessionId?: string | null;
  showPanelHeader?: boolean;
}) {
  const { t } = useAppI18n();
  const { expandedSessionId, setExpandedSession, sessions } = useSessionStore();
  const visibleSessionId = openSessionId === undefined ? expandedSessionId : openSessionId;

  const [mountedIds, setMountedIds] = useState<string[]>([]);

  useEffect(() => {
    if (!visibleSessionId) return;
    setMountedIds((prev) =>
      prev.includes(visibleSessionId) ? prev : [...prev, visibleSessionId]
    );
  }, [visibleSessionId]);

  useEffect(() => {
    const sessionIds = new Set(sessions.map((s) => s.id));
    setMountedIds((prev) => prev.filter((id) => sessionIds.has(id)));
  }, [sessions]);

  useEffect(() => {
    if (mode !== "overlay" || !visibleSessionId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpandedSession(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mode, visibleSessionId, setExpandedSession]);

  if (mode === "embedded") {
    return (
      <div style={{ position: "relative", width: "100%", height: "100%", minHeight: 0, overflow: "hidden" }}>
        {mountedIds.map((sid) => (
          <SessionPanel
            key={sid}
            sessionId={sid}
            isOpen={visibleSessionId === sid}
            onClose={() => setExpandedSession(null)}
            presentation="embedded"
            showHeader={showPanelHeader}
          />
        ))}
        {!visibleSessionId && (
          emptyState ? <>{emptyState}</> : <SessionDetailEmptyState message={t("session.emptyRightPanel")} />
        )}
      </div>
    );
  }

  return (
    <>
      {mountedIds.map((sid) => (
        <SessionPanel
          key={sid}
          sessionId={sid}
          isOpen={visibleSessionId === sid}
          onClose={() => setExpandedSession(null)}
          presentation="overlay"
          showHeader={showPanelHeader}
        />
      ))}
    </>
  );
}
