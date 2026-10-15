import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAttentionStore } from "./store/attentionStore";
import { useNavigationStore } from "./store/navigationStore";
import { forgetChatViewState } from "./services/chatViewState";
import { useSourceDeliveryStore } from "./store/sourceDeliveryStore";
import { checkCliUpdatesOnStartup } from "./store/cliUpdateStore";
import { checkAppUpdateOnStartup } from "./store/appUpdateStore";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { consumeSuppressedEditorReveal, filterVisibleExplorerDirectories, reloadExplorerDirectories, reloadVisibleDirectories, revealExplorerPath } from "./services/editorCommands";
import { TitleBar } from "./components/TitleBar";
import { QuickSwitch } from "./components/navigation/QuickSwitch";
const AgentObservatory = lazy(() => import("./components/agents/AgentObservatory").then(module => ({ default: module.AgentObservatory })));
import { ProviderUsageBar } from "./components/ProviderUsageBar";
import { showSessionSurface } from "./services/workbenchCommands";
import { motion } from "framer-motion";
import { WorkspaceStack } from "./components/WorkspaceStack";
import { SessionList } from "./components/SessionList";
import { SplitSwapProvider } from "./components/SplitSwapLayout";
import { WorkbenchSidebar } from "./workbench/WorkbenchSidebar";
const TerminalPanel = lazy(() => import("./components/TerminalPanel").then((module) => ({ default: module.TerminalPanel })));
const WorkbenchCenter = lazy(() => import("./workbench/WorkbenchCenter").then((module) => ({ default: module.WorkbenchCenter })));
const Settings = lazy(() => import("./components/Settings"));
import { ensureI18n, getLocaleDirection, resolveEffectiveLocale, useAppI18n } from "./i18n";
import { selectSessionNavigation, useSessionStore, type DiffFile, type ClaudeSession } from "./store/sessionStore";
import {
  useSettingsStore,
  isGlassTheme,
} from "./store/settingsStore";
import { useWorkspaceStore } from "./store/workspaceStore";
import { useWorkbenchStore } from "./store/workbenchStore";
import { useScmStore } from "./store/scmStore";
import { useExplorerStore, type ExplorerEntry } from "./store/explorerStore";
import { useEditorStore } from "./store/editorStore";
import { supportsAgentResume } from "./services/agentAdapters";

const spring = { type: "spring" as const, stiffness: 320, damping: 28, mass: 1 };
const MAX_FRONTEND_ERROR_LOGS = 50;

function getExplorerSyncSelection(state: ReturnType<typeof useEditorStore.getState>) {
  return Object.fromEntries(
    Object.entries(state.activeGroupIdBySessionId).flatMap(([sessionId, groupId]) => {
      if (!groupId) return [];
      const group = state.groupsById[groupId];
      if (!group?.activeTabId) return [];
      const tab = state.tabsById[group.activeTabId];
      if (!tab) return [];
      return [[sessionId, `${tab.sessionId}:${tab.viewMode}:${tab.path}:${groupId}`]];
    }),
  );
}

interface FrontendErrorLog {
  id: number;
  source: "window.error" | "unhandledrejection" | "console.error" | "explore-boundary";
  message: string;
  stack?: string | null;
  detail?: string | null;
}

interface BackfilledSessionBinding {
  sessionId: string;
  providerSessionId: string;
}

export default function App() {
  const { t } = useAppI18n();
  const {
    sessions,
    activeSessionId,
    expandedSessionId,
    appendOutput,
    updateSession,
    setDiffFiles,
    setActiveSession,
    setExpandedSession,
  } = useSessionStore(useShallow(state => ({ sessions: selectSessionNavigation(state), activeSessionId: state.activeSessionId, expandedSessionId: state.expandedSessionId, appendOutput: state.appendOutput, updateSession: state.updateSession, setDiffFiles: state.setDiffFiles, setActiveSession: state.setActiveSession, setExpandedSession: state.setExpandedSession })));
  const setScmSnapshot = useScmStore((s) => s.setSnapshot);
  const setScmStatus = useScmStore((s) => s.setStatus);
  const setScmDiffOverride = useScmStore((s) => s.setDiffOverride);

  const { settings, patchSettings } = useSettingsStore(useShallow(state => ({ settings: state.settings, patchSettings: state.patchSettings })));
  useEffect(() => { checkCliUpdatesOnStartup(); checkAppUpdateOnStartup(); }, []);
  const effectiveLocale = resolveEffectiveLocale(settings.locale);
  const direction = getLocaleDirection(effectiveLocale);
  const settingsOpen = useSettingsStore((s) => s.settingsOpen);
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const activeWorkspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const sidebarSection = useWorkbenchStore((s) => s.sidebarSection);
  const focusSession = useWorkbenchStore((s) => s.focusSession);
  const focusedSessionId = useWorkbenchStore((s) => s.focusedSessionId);
  const isGlass = isGlassTheme(settings.theme);
  const isSubPageOpen = settingsOpen;
  const refreshInFlightRef = useRef<Record<string, Promise<void> | null>>({});
  const refreshQueuedRef = useRef<Record<string, boolean>>({});
  const refreshQueuedOptionsRef = useRef<Record<string, { reloadExplorer?: boolean; reloadDirs?: string[] } | undefined>>({});
  const startedWatcherSessionsRef = useRef<Set<string>>(new Set());
  const watchedWorkdirBySessionRef = useRef<Record<string, string>>({});
  const [frontendErrorLogs, setFrontendErrorLogs] = useState<FrontendErrorLog[]>([]);
  const [showAgents, setShowAgents] = useState(false);
  useEffect(() => { if (activeSessionId) { useNavigationStore.getState().visit(`session:${activeSessionId}`); useAttentionStore.getState().readSession(activeSessionId); } }, [activeSessionId]);
  useEffect(() => useSessionStore.subscribe((state, previous) => { const remaining = new Set(state.sessions.map(session => session.id)); previous.sessions.forEach(session => { if (!remaining.has(session.id)) { forgetChatViewState(session.id); useAttentionStore.getState().clearSession(session.id); useSourceDeliveryStore.getState().remove(session.id); } }); }), []);
  const frontendErrorIdRef = useRef(1);

  const pushFrontendErrorLog = useCallback((log: Omit<FrontendErrorLog, "id">) => {
    setFrontendErrorLogs((current) => {
      const next = [{ id: frontendErrorIdRef.current++, ...log }, ...current];
      return next.slice(0, MAX_FRONTEND_ERROR_LOGS);
    });
  }, []);

  useEffect(() => {
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      pushFrontendErrorLog({
        source: "console.error",
        message: args.map((value) => {
          if (value instanceof Error) return value.message;
          return typeof value === "string" ? value : JSON.stringify(value, null, 2);
        }).join(" "),
        stack: args.find((value) => value instanceof Error) instanceof Error ? (args.find((value) => value instanceof Error) as Error).stack ?? null : null,
        detail: null,
      });
      originalConsoleError(...args);
    };

    const handleWindowError = (event: ErrorEvent) => {
      pushFrontendErrorLog({
        source: "window.error",
        message: event.message,
        stack: event.error instanceof Error ? event.error.stack ?? null : null,
        detail: `${event.filename}:${event.lineno}:${event.colno}`,
      });
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      pushFrontendErrorLog({
        source: "unhandledrejection",
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack ?? null : null,
        detail: null,
      });
    };

    const handleExploreBoundary = (nativeEvent: Event) => {
      const customEvent = nativeEvent as CustomEvent<{ message: string; stack?: string | null }>;
      pushFrontendErrorLog({
        source: "explore-boundary",
        message: customEvent.detail?.message ?? t("notifications.unknownError"),
        stack: customEvent.detail?.stack ?? null,
        detail: null,
      });
    };

    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    window.addEventListener("explore-boundary-error", handleExploreBoundary as EventListener);

    return () => {
      console.error = originalConsoleError;
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
      window.removeEventListener("explore-boundary-error", handleExploreBoundary as EventListener);
    };
  }, [pushFrontendErrorLog]);

  // ── Inject theme CSS variables into :root from settings.theme ──
  useEffect(() => {
    void ensureI18n(effectiveLocale);
    document.documentElement.lang = effectiveLocale;
    document.documentElement.dir = direction;
    if ("__TAURI_INTERNALS__" in window) {
      invoke("set_app_locale", { locale: effectiveLocale }).catch(() => {});
    }
  }, [direction, effectiveLocale]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.setAttribute("data-theme", settings.theme === "system" ? (mq.matches ? "dark" : "light") : settings.theme === "glass" ? "dark" : settings.theme);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [settings.theme]);

  // ── Select the first session of a workspace when switching workspaces ──
  useEffect(() => {
    const currentActive = useSessionStore.getState().activeSessionId;
    const currentSession = useSessionStore.getState().sessions.find((s) => s.id === currentActive);
    // Reselect if the active session does not belong to the current workspace.
    if (currentSession?.workspaceId !== activeWorkspaceId) {
      const wsSessions = useSessionStore.getState().sessions.filter(
        (s) => s.workspaceId === activeWorkspaceId
      );
      const fallbackId = wsSessions[0]?.id ?? null;
      setActiveSession(fallbackId);
      focusSession(fallbackId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId]);

  // The active session must belong to this workspace so switching never shows the previous workspace's content.
  const activeSession = sessions.find(
    (s) => s.id === activeSessionId && s.workspaceId === activeWorkspaceId
  );
  const expandedSession = sessions.find((s) => s.id === expandedSessionId) ?? null;
  const visibleSplitSessionId = expandedSession?.workspaceId === activeWorkspaceId
    ? expandedSession.id
    : null;
  const workbenchSession = sessions.find(
    (s) => s.id === focusedSessionId && s.workspaceId === activeWorkspaceId
  ) ?? activeSession ?? null;

  const refreshSessionDiff = useCallback((sessionId?: string | null, options?: { reloadExplorer?: boolean; reloadDirs?: string[] }) => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    const targetId = sessionId ?? useSessionStore.getState().activeSessionId;
    if (!targetId) return;

    if (refreshInFlightRef.current[targetId]) {
      refreshQueuedRef.current[targetId] = true;
      const previousOptions = refreshQueuedOptionsRef.current[targetId];
      refreshQueuedOptionsRef.current[targetId] = {
        reloadExplorer: previousOptions?.reloadExplorer || options?.reloadExplorer,
        reloadDirs: [...new Set([...(previousOptions?.reloadDirs ?? []), ...(options?.reloadDirs ?? [])])],
      };
      return;
    }

    const runRefresh = async () => {
      const session = useSessionStore.getState().sessions.find((s) => s.id === targetId);
      if (!session) return;

      await Promise.all([
        invoke("get_git_status", {
          sessionId: session.id,
          workdir: session.workdir,
        }),
        session.baseBranch
          ? invoke("get_git_diff_session_worktree", {
              sessionId: session.id,
              workdir: session.workdir,
              baseBranch: session.baseBranch,
            })
          : invoke("get_git_diff", {
              sessionId: session.id,
              workdir: session.workdir,
            }),
      ]).catch(() => {});

      if (options?.reloadDirs && options.reloadDirs.length > 0) {
        await reloadExplorerDirectories(session.id, options.reloadDirs).catch(() => {});
      } else if (options?.reloadExplorer) {
        await reloadVisibleDirectories(session.id).catch(() => {});
      }
    };

    const task = runRefresh().finally(() => {
      refreshInFlightRef.current[targetId] = null;
      if (refreshQueuedRef.current[targetId]) {
        refreshQueuedRef.current[targetId] = false;
        const queuedOptions = refreshQueuedOptionsRef.current[targetId];
        delete refreshQueuedOptionsRef.current[targetId];
        refreshSessionDiff(targetId, queuedOptions ?? options);
      }
    });

    refreshInFlightRef.current[targetId] = task;
  }, []);


  useEffect(() => {
    const unsubscribe = useEditorStore.subscribe((state, prevState) => {
      const nextSelections = getExplorerSyncSelection(state);
      const prevSelections = getExplorerSyncSelection(prevState);
      Object.entries(nextSelections).forEach(([sessionId, nextSelectionKey]) => {
        if (prevSelections[sessionId] === nextSelectionKey) return;
        const groupId = state.activeGroupIdBySessionId[sessionId];
        if (!groupId) return;
        const group = state.groupsById[groupId];
        if (!group?.activeTabId) return;
        const tab = state.tabsById[group.activeTabId];
        if (!tab) return;
        if (consumeSuppressedEditorReveal(sessionId)) return;
        revealExplorerPath(sessionId, tab.path, true, "editor");
      });
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    const visibleSessions = [activeSession, workbenchSession].filter((session): session is ClaudeSession => !!session);
    const nextWatchMap = new Map(visibleSessions.map((session) => [session.id, session.workdir]));

    nextWatchMap.forEach((workdir, sessionId) => {
      const knownWorkdir = watchedWorkdirBySessionRef.current[sessionId];
      if (knownWorkdir === workdir && startedWatcherSessionsRef.current.has(sessionId)) {
        return;
      }
      if (startedWatcherSessionsRef.current.has(sessionId) && knownWorkdir && knownWorkdir !== workdir) {
        void invoke("stop_git_watch", { sessionId }).catch(() => {});
        startedWatcherSessionsRef.current.delete(sessionId);
      }
      watchedWorkdirBySessionRef.current[sessionId] = workdir;
      startedWatcherSessionsRef.current.add(sessionId);
      void invoke("start_git_watch", { sessionId, workdir }).catch(() => {});
    });

    [...startedWatcherSessionsRef.current].forEach((sessionId) => {
      if (nextWatchMap.has(sessionId)) return;
      startedWatcherSessionsRef.current.delete(sessionId);
      delete watchedWorkdirBySessionRef.current[sessionId];
      void invoke("stop_git_watch", { sessionId }).catch(() => {});
    });
  }, [activeSession, workbenchSession]);

  useEffect(() => () => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    [...startedWatcherSessionsRef.current].forEach((sessionId) => {
      void invoke("stop_git_watch", { sessionId }).catch(() => {});
    });
    startedWatcherSessionsRef.current.clear();
    watchedWorkdirBySessionRef.current = {};
  }, []);

  // ── Close with Escape ───────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (settingsOpen) {
        closeSettings();
        return;
      }
      if (sidebarSection !== "sessions") {
        useWorkbenchStore.getState().resetWorkbenchMode();
        return;
      }
      // Escape remains available to the official agent terminal.
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [settingsOpen, closeSettings, sidebarSection]);

  // ── Remember popup position / size with a 500 ms debounce after dragging or resizing ──
  // Save only in the base, unexpanded state; temporary expanded dimensions must not overwrite the saved geometry.
  // A non-null expandedSessionId means the terminal panel is expanded.
  const boundsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressBoundsPersistenceRef = useRef(false);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    const win = getCurrentWindow();

    // onMoved payload = PhysicalPosition { x, y }, in physical pixels.
    // onResized payload = PhysicalSize { width, height }, in physical pixels.
    // Read directly from the payload without another asynchronous call.
    const debouncedSave = (physX: number, physY: number, physW: number, physH: number) => {
      // Skip only when the overlay is expanded so temporary larger dimensions are not saved.
      if (suppressBoundsPersistenceRef.current) return;
      if (boundsTimerRef.current) clearTimeout(boundsTimerRef.current);
      boundsTimerRef.current = setTimeout(async () => {
        try {
          const scaleFactor = await win.scaleFactor();
          await invoke("save_popup_bounds", {
            x: physX / scaleFactor,
            y: physY / scaleFactor,
            width: physW / scaleFactor,
            height: physH / scaleFactor,
          });
        } catch {
          // Ignore persistence failures.
        }
      }, 500);
    };

    // onMoved provides only position; read the current width and height separately.
    const unlistenMoved = win.onMoved(async ({ payload: pos }) => {
      if (suppressBoundsPersistenceRef.current) return;
      try {
        const size = await win.innerSize();
        debouncedSave(pos.x, pos.y, size.width, size.height);
      } catch { /* Ignore window geometry errors. */ }
    });

    // onResized provides only size; read the current position separately.
    const unlistenResized = win.onResized(async ({ payload: size }) => {
      if (suppressBoundsPersistenceRef.current) return;
      try {
        const pos = await win.outerPosition();
        debouncedSave(pos.x, pos.y, size.width, size.height);
      } catch { /* Ignore window geometry errors. */ }
    });

    return () => {
      if (boundsTimerRef.current) clearTimeout(boundsTimerRef.current);
      unlistenMoved.then((f) => f()).catch(() => {});
      unlistenResized.then((f) => f()).catch(() => {});
    };
  }, []);

  // ── Preserve the current PTY or menu state when the popup is shown again from the tray ──
  // Keep the PTY expanded so the user resumes where they left off.

  // ── Expand the most recently active session when a notification opens the popup ──
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const unlisten = listen<{ session_id?: string | null }>("popup-focused", ({ payload }) => {
      const sid = payload?.session_id?.trim();
      const { activeSessionId: aid, sessions: ss } = useSessionStore.getState();
      const target =
        sid && ss.some((s) => s.id === sid)
          ? sid
          : (aid ?? ss[ss.length - 1]?.id ?? null);
      if (target) {
        requestAnimationFrame(() => {
          setActiveSession(target);
          setExpandedSession(target);
          focusSession(target);
          refreshSessionDiff(target);
        });
      }
    });
    return () => { unlisten.then((f) => f()).catch(() => {}); };
  }, [setExpandedSession, refreshSessionDiff]);

  // ── Trust existing workspace directories at startup by writing Claude settings ──
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const { workspaces } = useWorkspaceStore.getState();
    workspaces.forEach((ws) => {
      invoke("trust_workspace", { path: ws.path }).catch(() => {});
    });
  }, []);

  // ── Restore missing sessions at startup and backfill provider resume bindings for older sessions ──
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    let cancelled = false;

    (async () => {
      const workspaces = useWorkspaceStore.getState().workspaces;
      const workspaceInputs = workspaces.map((workspace) => ({
        workspaceId: workspace.id,
        workspacePath: workspace.path,
      }));
      const knownIds = new Set(useSessionStore.getState().sessions.map((s) => s.id));
      const recovered = await invoke<ClaudeSession[]>("recover_workspace_sessions", {
        workspaces: workspaceInputs,
        existingSessionIds: [...knownIds],
      }).catch(() => []);

      if (cancelled) return;
      if (recovered.length > 0) {
        useSessionStore.getState().mergeRecoveredSessions(recovered);
      }

      const backfillCandidates = useSessionStore
        .getState()
        .sessions
        .filter((session) => {
          if (!session.worktreePath?.trim()) return false;
          if (session.providerSessionId?.trim()) return false;
          return supportsAgentResume(session.runner.type);
        })
        .map((session) => ({
          sessionId: session.id,
          runnerType: session.runner.type,
          worktreePath: session.worktreePath ?? null,
          providerSessionId: session.providerSessionId ?? null,
        }));

      if (backfillCandidates.length === 0) return;

      const backfilled = await invoke<BackfilledSessionBinding[]>("backfill_workspace_session_bindings", {
        sessions: backfillCandidates,
      }).catch(() => []);

      if (cancelled || backfilled.length === 0) return;

      backfilled.forEach(({ sessionId, providerSessionId }) => {
        const current = useSessionStore.getState().sessions.find((session) => session.id === sessionId);
        if (!current || current.providerSessionId?.trim()) return;
        useSourceDeliveryStore.getState().markUnknown(sessionId);
        useSourceDeliveryStore.getState().bindProvider(sessionId, providerSessionId);
        updateSession(sessionId, { providerSessionId });
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [updateSession]);

  // ── Listen for events from Rust ─────────────────────────────
  useEffect(() => {
    // Skip browser-only development: listen fails without Tauri's __TAURI_INTERNALS__.
    if (!("__TAURI_INTERNALS__" in window)) return;

    // Legacy interface: claude-output from the claude-code CLI.
    const u1 = listen<{ session_id: string; line: string }>(
      "claude-output",
      ({ payload }) => appendOutput(payload.session_id, payload.line)
    );

    const runnerGenerations = new Map<string, string>();
    const currentRunner = (payload: { session_id: string; run_id?: string }) => !payload.run_id || !runnerGenerations.has(payload.session_id) || runnerGenerations.get(payload.session_id) === payload.run_id;
    const u2a = listen<{ session_id: string; run_id: string }>("runner-starting", ({ payload }) => {
      runnerGenerations.set(payload.session_id, payload.run_id);
      useAttentionStore.getState().resolveActions(payload.session_id);
      updateSession(payload.session_id, { status: "running", pid: undefined });
    });
    const u2b = listen<{ session_id: string; run_id: string; pid: number }>("runner-started", ({ payload }) => {
      if (currentRunner(payload)) updateSession(payload.session_id, { status: "running", pid: payload.pid });
    });
    // Events queued by an earlier process cannot modify its replacement.
    const u2 = listen<{ session_id: string; line: string; run_id?: string }>(
      "runner-output",
      ({ payload }) => { if (currentRunner(payload)) appendOutput(payload.session_id, payload.line); }
    );

    // Runner completed.
    const u3 = listen<{ session_id: string; error?: string; status?: string; run_id?: string }>(
      "runner-done",
      ({ payload }) => {
        if (!currentRunner(payload)) return;
        const error = payload.error || (payload.status === "error" ? t("status.error") : undefined);
        if (error || payload.status === "completed") useAttentionStore.getState().record({ id: `runner:${payload.session_id}:${payload.run_id ?? Date.now()}:${error ? "error" : "completed"}`, sessionId: payload.session_id, kind: error ? "error" : "completed", text: error ?? "", source: "runner", at: Date.now() });
        if (error) {
          updateSession(payload.session_id, { status: "error", currentTask: error, pid: undefined });
        } else {
          updateSession(payload.session_id, { status: payload.status === "completed" ? "done" : "suspended", pid: undefined });
        }
        refreshSessionDiff(payload.session_id);
      }
    );

    // Legacy interface: claude-status.
    const u4 = listen<{ session_id: string; status: string; task: string }>(
      "claude-status",
      ({ payload }) => {
        updateSession(payload.session_id, {
          status: payload.status as Parameters<typeof updateSession>[1]["status"],
          currentTask: payload.task,
        });
      }
    );

    // Git diff updates.
    const u5 = listen<{ session_id: string; files: DiffFile[]; run_id?: string }>(
      "diff-update",
      ({ payload }) => {
        if (!currentRunner(payload)) return;
        setDiffFiles(payload.session_id, payload.files);
        setScmSnapshot(payload.session_id, payload.files);
      }
    );

    const u5b = listen<{ session_id: string; groups: import("./store/scmStore").ScmStatusGroups }>(
      "scm-status-update",
      ({ payload }) => {
        setScmStatus(payload.session_id, payload.groups);
      }
    );

    const u5c = listen<{ session_id: string; mode: string; file: DiffFile }>(
      "scm-diff-side-update",
      ({ payload }) => {
        if (payload.mode === "staged" || payload.mode === "unstaged") {
          setScmDiffOverride(payload.session_id, payload.file);
        }
      }
    );

    const u5d = listen<{ session_id: string; reason?: string; event_type?: "create" | "delete" | "rename" | "change" | "git" | "batch"; paths?: string[]; reload_dirs?: string[]; path_kinds?: Record<string, ExplorerEntry["kind"]>; rename_pairs?: Array<{ oldPath: string; newPath: string }> }>(
      "scm-refresh-requested",
      ({ payload }) => {
        const eventType = payload.event_type ?? "batch";
        const graphPatched = useExplorerStore.getState().applyWatcherEvent(payload.session_id, {
          eventType,
          paths: payload.paths ?? [],
          pathKinds: payload.path_kinds,
          renamePairs: payload.rename_pairs,
        });

        const reloadDirs = filterVisibleExplorerDirectories(payload.session_id, payload.reload_dirs ?? []);
        const shouldRefreshScmOnly = eventType === "git" || eventType === "batch" || (payload.paths?.length ?? 0) === 0;
        if (reloadDirs.length > 0) {
          refreshSessionDiff(payload.session_id, { reloadDirs });
          return;
        }

        if (!graphPatched && shouldRefreshScmOnly) {
          refreshSessionDiff(payload.session_id);
        }
      }
    );

    // On PTY exit, mark running/waiting/suspended sessions as done.
    // SessionPanel unmounts when closed, so keep this global fallback listener.
    const u6 = listen<{ session_id: string; exit_code?: number }>("pty-exit", ({ payload }) => {
      const session = useSessionStore.getState().sessions.find(s => s.id === payload.session_id);
      if (session) updateSession(session.id, { status: payload.exit_code ? "error" : "done" });
    });

    // Bind the native provider session for resume on the next visit.
    const u7 = listen<{ session_id: string; runner_type: string; provider_session_id: string }>(
      "provider-session-bound",
      ({ payload }) => {
        if (!payload.session_id || !payload.provider_session_id) return;
        const session = useSessionStore
          .getState()
          .sessions.find((x) => x.id === payload.session_id);
        const existing = session?.providerSessionId?.trim();
        // Do not overwrite an existing resumable session ID with a newly created empty provider session.
        if (existing && existing !== payload.provider_session_id) {
          useSourceDeliveryStore.getState().markUnknown(payload.session_id);
          return;
        }
        useSourceDeliveryStore.getState().bindProvider(payload.session_id, payload.provider_session_id);
        updateSession(payload.session_id, {
          providerSessionId: payload.provider_session_id,
        });
        void invoke("save_recovery_binding", {
          input: {
            sessionId: payload.session_id,
            runnerType: payload.runner_type,
            providerSessionId: payload.provider_session_id,
            worktreePath: session?.worktreePath ?? null,
          },
        }).catch(() => {});
      }
    );

    const u8 = listen<{ session_id: string; turn_id?: string; source?: string }>("pty-waiting", ({ payload }) => {
      if (payload.source !== "codex" && payload.source !== "claude-code") return;
      const activity = useSessionStore.getState().sessions.find(s => s.id === payload.session_id);
      if (!activity) return;
      useAttentionStore.getState().record({ id: `terminal:${payload.session_id}:${payload.turn_id ?? activity.currentTask}`, sessionId: payload.session_id, kind: "completed", text: "", source: payload.source, at: Date.now() });
    });
    const u9 = listen<{ session_id: string; error: string }>("pty-error", ({ payload }) => {
      useAttentionStore.getState().record({ id: `terminal-error:${payload.session_id}:${payload.error}`, sessionId: payload.session_id, kind: "error", text: payload.error.slice(0, 1200), source: "provider-hook", at: Date.now() });
    });
    return () => {
      [u1, u2a, u2b, u2, u3, u4, u5, u5b, u5c, u5d, u6, u7, u8, u9].forEach((p) => p.then((f) => f()).catch(() => {}));
    };
  }, [appendOutput, updateSession, setDiffFiles, setScmSnapshot, setScmStatus, setScmDiffOverride, refreshSessionDiff]);

  // ── Fetch the diff on session switches, including idle sessions and external changes ──
  useEffect(() => {
    if (!activeSession?.id) return;
    refreshSessionDiff(activeSession.id);
  }, [activeSession?.id, refreshSessionDiff]);

  useEffect(() => {
    if (sidebarSection === "sessions" || sidebarSection === "memory") return;
    if (workbenchSession) return;
    useWorkbenchStore.getState().resetWorkbenchMode();
  }, [sidebarSection, workbenchSession]);

  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [resizingSidebarWidth, setResizingSidebarWidth] = useState<number | null>(null);
  const sidebarResizeCleanup = useRef<(() => void) | null>(null);
  // Finish StrictMode's mount cleanup before the user can begin a gesture.
  useLayoutEffect(() => () => sidebarResizeCleanup.current?.(), []);
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const maxSidebarWidth = Math.floor(viewportWidth / 2);
  const minSidebarWidth = Math.min(280, maxSidebarWidth);
  const splitSidebarWidth = Math.min(maxSidebarWidth, Math.max(minSidebarWidth, resizingSidebarWidth ?? settings.splitPaneSidebarWidth));

  const handleSplitPanePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || sidebarResizeCleanup.current) return;
    event.preventDefault();
    const separator = event.currentTarget, pointerId = event.pointerId;
    separator.setPointerCapture(pointerId);
    const startX = event.clientX;
    const startWidth = splitSidebarWidth;
    let nextWidth = startWidth;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const maxWidth = Math.floor(window.innerWidth / 2);
      nextWidth = Math.min(maxWidth, Math.max(Math.min(280, maxWidth), Math.round(startWidth + (moveEvent.clientX - startX) * (direction === "rtl" ? -1 : 1))));
      setResizingSidebarWidth(nextWidth);
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      patchSettings({ splitPaneSidebarWidth: nextWidth });
      cleanup();
    };
    const cancel = (cancelEvent: PointerEvent) => { if (cancelEvent.pointerId === pointerId) cleanup(); };
    const keydown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") { keyEvent.preventDefault(); cleanup(); }
    };
    const cleanup = () => {
      sidebarResizeCleanup.current = null;
      if (separator.hasPointerCapture(pointerId)) separator.releasePointerCapture(pointerId);
      setResizingSidebarWidth(null);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", keydown);
    };

    sidebarResizeCleanup.current = cleanup;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", keydown);
  }, [patchSettings, splitSidebarWidth, direction]);

  const menuContent = (
    <div style={{
      flex: 1,
      minHeight: 0,
      overflowY: "auto",
      overflowX: "hidden",
      position: "relative",
      scrollbarWidth: "none",
      zIndex: 1,
    }}>
      <div style={{ padding: "6px 18px 4px" }}>
        <WorkspaceStack />
      </div>

      <div style={{ padding: "0 18px 12px" }}>
        <SessionList />
      </div>

      <div style={{
        position: "sticky",
        bottom: 0,
        left: 0,
        right: 0,
        height: 28,
        background: "linear-gradient(to bottom, transparent, var(--ci-bg-grad))",
        pointerEvents: "none",
        flexShrink: 0,
      }} />
    </div>
  );

  return (
    <>
      <div style={{
        width: "100vw",
        height: "100vh",
        padding: 0,
        boxSizing: "border-box",
        background: "transparent",
      }}>
        {frontendErrorLogs.length > 0 && (
          <div style={{
            position: "fixed",
            right: 12,
            bottom: 36,
            width: 420,
            maxHeight: 260,
            overflow: "auto",
            zIndex: 9999,
            border: "1px solid var(--ci-toolbar-border)",
            background: "var(--ci-surface)",
            color: "var(--ci-text)",
            fontSize: 11,
            lineHeight: 1.5,
            boxShadow: "0 12px 30px rgba(0,0,0,0.28)",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", borderBottom: "1px solid var(--ci-toolbar-border)", position: "sticky", top: 0, background: "var(--ci-surface)" }}>
              <span style={{ fontWeight: 700, color: "var(--ci-deleted-text)" }}>{t("app.frontendErrors")}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  onClick={() => {
                    const content = frontendErrorLogs.map((log) => [
                      `[${log.source}] ${log.message}`,
                      log.detail ?? "",
                      log.stack ?? "",
                    ].filter(Boolean).join("\n")).join("\n\n---\n\n");
                    void navigator.clipboard.writeText(content).catch(() => {});
                  }}
                  style={{ background: "none", border: "none", color: "var(--ci-text-dim)", cursor: "pointer", fontSize: 11 }}
                >
                  {t("app.copyAll")}
                </button>
                <button
                  onClick={() => setFrontendErrorLogs([])}
                  style={{ background: "none", border: "none", color: "var(--ci-text-dim)", cursor: "pointer", fontSize: 11 }}
                >
                  {t("common.clear")}
                </button>
              </div>
            </div>
            <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
              {frontendErrorLogs.map((log) => (
                <div key={log.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ color: "var(--ci-yellow)", fontWeight: 600 }}>{log.source}</div>
                    <button
                      onClick={() => {
                        const content = [
                          `[${log.source}] ${log.message}`,
                          log.detail ?? "",
                          log.stack ?? "",
                        ].filter(Boolean).join("\n");
                        void navigator.clipboard.writeText(content).catch(() => {});
                      }}
                      style={{ background: "none", border: "none", color: "var(--ci-text-dim)", cursor: "pointer", fontSize: 10, padding: 0 }}
                    >
                      {t("common.copy")}
                    </button>
                  </div>
                  <div style={{ marginTop: 4, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{log.message}</div>
                  {log.detail && <div style={{ marginTop: 4, color: "var(--ci-text-dim)", whiteSpace: "pre-wrap" }}>{log.detail}</div>}
                  {log.stack && <pre style={{ marginTop: 6, whiteSpace: "pre-wrap", color: "var(--ci-text-dim)", fontSize: 10 }}>{log.stack}</pre>}
                </div>
              ))}
            </div>
          </div>
        )}
        <motion.div
          transition={spring}
          style={{
            width: "100%",
            height: "100%",
            position: "relative",
            borderRadius: "var(--ci-shell-radius)",
            border: isGlass ? "none" : "1px solid var(--ci-window-edge)",
            background: isGlass ? "transparent" : "var(--ci-window-bg)",
            boxShadow: "var(--ci-window-shadow)",
            clipPath: "inset(0 round var(--ci-shell-radius))",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            isolation: "isolate",
          }}
        >
          <TitleBar onAgents={() => setShowAgents(true)} navigation={<QuickSwitch disabled={settingsOpen || showAgents}
            onAgents={() => setShowAgents(true)} onKnowledge={() => useWorkbenchStore.getState().setSidebarSection("memory")}
            onSettings={() => useSettingsStore.getState().openSettings()} />} />
          {showAgents && <Suspense fallback={null}><AgentObservatory onClose={() => setShowAgents(false)} onOpenSession={id => { showSessionSurface(id); setShowAgents(false); }} /></Suspense>}
          <div style={{
            position: "relative",
            display: "flex",
            flex: 1,
            minHeight: 0,
            flexDirection: "column",
          }}>
            {settingsOpen && <Suspense fallback={null}><Settings /></Suspense>}

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                flex: 1,
                minHeight: 0,
                opacity: isSubPageOpen ? 0 : 1,
                pointerEvents: isSubPageOpen ? "none" : "auto",
                visibility: isSubPageOpen ? "hidden" : "visible",
              }}
            >
              <SplitSwapProvider
                sessionDetailEmptyState={
                  <div style={{
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 24,
                  }}>
                    <div style={{
                      maxWidth: 260,
                      padding: "20px 22px",
                      borderRadius: 18,
                      background: "var(--ci-surface)",
                      border: "1px solid var(--ci-toolbar-border)",
                      color: "var(--ci-text-dim)",
                      fontSize: 12,
                      textAlign: "center",
                      lineHeight: 1.7,
                    }}>
                      {expandedSessionId && !visibleSplitSessionId
                        ? t("app.split.emptyOtherWorkspace")
                        : t("app.split.emptyPickSession")}
                    </div>
                  </div>
                }
              >
                <div style={{ display: "flex", flex: 1, minHeight: 0, position: "relative" }}>
                  <div data-testid="workbench-sidebar" style={{
                    width: splitSidebarWidth,
                    maxWidth: "50vw",
                    minWidth: 0,
                    containerType: "inline-size",
                    flexShrink: 0,
                    display: "flex",
                    flexDirection: "column",
                    minHeight: 0,
                    background: isGlass ? "var(--ci-toolbar-bg)" : "transparent",
                  }}>
                    <WorkbenchSidebar
                      session={workbenchSession}
                      menuContent={menuContent}
                      onRefreshDiff={refreshSessionDiff}
                    />
                  </div>

                  <div
                    onPointerDown={handleSplitPanePointerDown}
                    role="separator" tabIndex={0} aria-label={t("app.split.resizeSidebar")} aria-orientation="vertical"
                    aria-valuemin={minSidebarWidth} aria-valuemax={maxSidebarWidth} aria-valuenow={splitSidebarWidth}
                    onKeyDown={event => {
                      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                      event.preventDefault();
                      const delta = (event.key === "ArrowRight" ? 20 : -20) * (direction === "rtl" ? -1 : 1);
                      patchSettings({ splitPaneSidebarWidth: event.key === "Home" ? minSidebarWidth : event.key === "End" ? maxSidebarWidth : Math.min(maxSidebarWidth, Math.max(minSidebarWidth, splitSidebarWidth + delta)) });
                    }}
                    title={t("app.split.resizeSidebar")}
                    style={{
                      width: 10,
                      marginInlineStart: -5,
                      marginInlineEnd: -5,
                      cursor: "col-resize",
                      zIndex: 3,
                      touchAction: "none",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <div style={{
                      width: 2,
                      height: "100%",
                      background: "var(--ci-toolbar-border)",
                      borderRadius: 999,
                    }} />
                  </div>

                  <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative", display: "flex", borderInlineStart: "1px solid var(--ci-toolbar-border)" }}>
                    <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                      <Suspense fallback={null}><WorkbenchCenter session={workbenchSession} onRefreshDiff={refreshSessionDiff} /></Suspense>
                    </div>
                  </div>

                  <Suspense fallback={null}><TerminalPanel session={workbenchSession} /></Suspense>
                </div>
              </SplitSwapProvider>
            </div>
          </div>
          <ProviderUsageBar />
        </motion.div>
      </div>
    </>
  );
}
