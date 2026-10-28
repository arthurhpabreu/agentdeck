import { invoke } from "@tauri-apps/api/core";
import { useChatStore } from "../store/chatStore";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { selectSessionMetadata, useSessionStore } from "../store/sessionStore";
import { useSettingsStore, type RunnerType } from "../store/settingsStore";
import {
  buildRunnerContextEnv,
  checkRunnerAvailability,
  getRunnerBadge,
  getRunnerCliCommand,
  getRunnerInstallCommand,
  hasNativeResumeBinding,
  switchRunnerForSession,
} from "../services/runnerCommands";
import { useAgentActivityStore } from "../store/agentActivityStore";
import { getAgentAdapter } from "../services/agentAdapters";
import { stopPtySession, usePtyRuntimeStore } from "../store/ptyRuntimeStore";
import { getRuntimePlatform } from "../services/platform";

const nativeDrafts = new Map<string, string>();
const nativeLaunchPrompts = new Map<string, string | null>();
const nativePendingQueries = new Map<string, { current: string | null }>();
const nativeSending = new Set<string>();
useSessionStore.subscribe(state => {
  const valid = new Set(state.sessions.map(session => session.id));
  for (const cache of [nativeDrafts, nativeLaunchPrompts, nativePendingQueries]) for (const id of cache.keys()) if (!valid.has(id)) cache.delete(id);
});

export function useSessionRunnerController({
  sessionId,
  isOpen,
}: {
  sessionId: string;
  isOpen: boolean;
}) {
  const isWindows = getRuntimePlatform().os === "windows";
  const session = useSessionStore((s) => selectSessionMetadata(s, sessionId));
  const worktreeReady = useSessionStore((s) => s.worktreeReadyIds.has(sessionId));
  const updateSession = useSessionStore(state => state.updateSession);
  const settings = useSettingsStore(state => state.settings);

  const [pendingQuery, setPendingQueryState] = useState(() => nativeDrafts.get(sessionId) ?? "");
  const setPendingQuery = useCallback((value: string) => { nativeDrafts.set(sessionId, value); setPendingQueryState(value); }, [sessionId]);
  const [querySent, setQuerySent] = useState(() => {
    const s = useSessionStore.getState().sessions.find((x) => x.id === sessionId);
    return !!s && ((s.status === "running" || s.status === "waiting" || s.status === "suspended") || hasNativeResumeBinding(s));
  });
  const queryInputRef = useRef<HTMLTextAreaElement>(null);

  const [installing, setInstalling] = useState(false);
  const installCountRef = useRef(0);
  const [installId, setInstallId] = useState("");
  const [launchPrompt, setLaunchPromptState] = useState<string | null>(() => nativeLaunchPrompts.get(sessionId) ?? null);
  const setLaunchPrompt = useCallback((value: string | null) => { nativeLaunchPrompts.set(sessionId, value); setLaunchPromptState(value); }, [sessionId]);
  const [ptyEverActive, setPtyEverActive] = useState(false);
  const [launchResumeSessionId, setLaunchResumeSessionId] = useState("");
  const [cliAvailable, setCliAvailable] = useState<boolean | null>(null);

  const ptyReadyRef = useRef(usePtyRuntimeStore.getState().sessions[sessionId] === "running");
  const lastQuerySentAtRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const pendingQueryRef = useMemo(() => { const queued = nativePendingQueries.get(sessionId) ?? { current: null }; nativePendingQueries.set(sessionId, queued); return queued; }, [sessionId]);
  const pendingQueryTimerRef = useRef<number | null>(null);

  const runner = session ? session.runner : settings.runner;
  const supportsPromptLaunch = Boolean(getAgentAdapter(runner.type));
  const boundResumeSessionId = supportsPromptLaunch ? (session?.providerSessionId?.trim() ?? "") : "";
  const resumeSessionId = supportsPromptLaunch
    ? (ptyEverActive ? launchResumeSessionId : boundResumeSessionId)
    : "";
  const isResumeLaunch = resumeSessionId.length > 0;
  const runnerBadge = getRunnerBadge(runner.type);
  const installCmd = getRunnerInstallCommand(runner.type);

  const clearPendingQueryTimer = useCallback(() => {
    if (pendingQueryTimerRef.current !== null) {
      window.clearTimeout(pendingQueryTimerRef.current);
      pendingQueryTimerRef.current = null;
    }
  }, []);

  const flushPendingQuery = useCallback((delay = 0) => {
    if (!ptyReadyRef.current) return false;
    const queued = pendingQueryRef.current?.trim();
    if (!queued) return false;

    clearPendingQueryTimer();

    const send = () => {
      const query = pendingQueryRef.current?.trim();
      if (!query || !ptyReadyRef.current || nativeSending.has(sessionIdRef.current)) return;
      const destination = sessionIdRef.current;
      nativeSending.add(destination);
      invoke("send_pty_query", {
        sessionId: sessionIdRef.current,
        query,
      })
        .then(() => {
          if (pendingQueryRef.current?.trim() === query) {
            pendingQueryRef.current = null;
          }
          setLaunchPrompt(null);
        })
        .catch(() => {
          pendingQueryTimerRef.current = window.setTimeout(() => {
            pendingQueryTimerRef.current = null;
            flushPendingQuery(isWindows ? 1200 : 300);
          }, isWindows ? 1200 : 300);
        }).finally(() => nativeSending.delete(destination));
    };

    if (delay > 0) {
      pendingQueryTimerRef.current = window.setTimeout(() => {
        pendingQueryTimerRef.current = null;
        send();
      }, delay);
      return true;
    }

    send();
    return true;
  }, [clearPendingQueryTimer, isWindows]);

  const handlePtyReady = useCallback(() => {
    ptyReadyRef.current = true;
    setLaunchPrompt(null);
    if (isWindows) {
      clearPendingQueryTimer();
      pendingQueryTimerRef.current = window.setTimeout(() => {
        pendingQueryTimerRef.current = null;
        flushPendingQuery(0);
      }, 4000);
      return;
    }
    flushPendingQuery(200);
  }, [clearPendingQueryTimer, flushPendingQuery, isWindows]);

  const handlePtyWaiting = useCallback(() => {
    const sid = sessionIdRef.current;
    const s = useSessionStore.getState().sessions.find((x) => x.id === sid);
    flushPendingQuery(isWindows ? 120 : 0);
    if (s?.status === "waiting" || useChatStore.getState().threads[sid]?.busy) return;
    updateSession(sid, { status: "waiting" });
    // PTY screen heuristics also fire at startup and between tools. Only native
    // provider completion events can trigger an operating-system notification.
  }, [flushPendingQuery, isWindows, updateSession]);

  const handlePtyRunning = useCallback(() => {
    updateSession(sessionIdRef.current, { status: "running" });
  }, [updateSession]);

  const handlePtyError = useCallback((error: string) => {
    updateSession(sessionIdRef.current, { status: "error" });
    useAgentActivityStore.getState().record(sessionIdRef.current, { phase: "error", error }, "activity.error", error);
  }, [updateSession]);

  const cliCommand = getRunnerCliCommand(runner);

  const recheckCli = useCallback(() => {
    setCliAvailable(null);
    checkRunnerAvailability(cliCommand)
      .then((ok) => {
        setCliAvailable(ok);
        if (ok) setInstalling(false);
      })
      .catch(() => setCliAvailable(false));
  }, [cliCommand]);

  const buildContextEnv = useCallback((): [string, string][] => {
    if (!session) return [];
    return buildRunnerContextEnv(session, runner);
  }, [session, runner]);

  const handleSubmitQuery = useCallback((q: string) => {
    const trimmed = q.trim();
    if (!trimmed || !session) return;
    const title = trimmed.length > 24 ? trimmed.slice(0, 24) + "…" : trimmed;
    lastQuerySentAtRef.current = Date.now();
    updateSession(session.id, { currentTask: trimmed, status: "running" });
    useSessionStore.getState().setAutomaticSessionName(session.id, title);
    setQuerySent(true);
    useAgentActivityStore.getState().record(session.id, { phase: "starting", error: undefined, endedAt: undefined, startedAt: undefined, pid: undefined }, "activity.starting");

    if (ptyReadyRef.current) {
      pendingQueryRef.current = trimmed;
      flushPendingQuery(isWindows ? 120 : 100);
    } else if (supportsPromptLaunch && !ptyEverActive && !trimmed.startsWith("/")) {
      setLaunchPrompt(trimmed);
    } else {
      pendingQueryRef.current = trimmed;
    }
  }, [session, updateSession, flushPendingQuery, isWindows, ptyEverActive, supportsPromptLaunch]);

  const handleInstall = useCallback(() => {
    if (!installCmd) return;
    installCountRef.current += 1;
    const id = `install-${sessionId}-${installCountRef.current}`;
    setInstallId(id);
    setInstalling(true);
  }, [installCmd, sessionId]);

  const handleLaunch = useCallback(() => {
    if (!session || cliAvailable !== true) return;
    setQuerySent(true);
    updateSession(sessionId, { status: "running" });
    useAgentActivityStore.getState().record(sessionId, { phase: "starting", endedAt: undefined, error: undefined, startedAt: undefined, pid: undefined }, "activity.starting");
  }, [session, sessionId, cliAvailable, updateSession]);

  const handleStop = useCallback(() => {
    void stopPtySession(sessionId).catch(error => handlePtyError(String(error)));
  }, [sessionId, handlePtyError]);

  const handleSwitchRunner = useCallback((type: RunnerType) => {
    if (type === runner.type) return;
    void (async () => {
      if (usePtyRuntimeStore.getState().sessions[sessionId]) await stopPtySession(sessionId);
      setLaunchPrompt(null);
      clearPendingQueryTimer();
      ptyReadyRef.current = false;
      pendingQueryRef.current = null;
      setPtyEverActive(false);
      setQuerySent(false);
      setLaunchResumeSessionId("");
      updateSession(sessionId, { providerSessionId: undefined, status: "idle" });
      switchRunnerForSession(sessionId, type);
    })().catch(error => handlePtyError(String(error)));
  }, [clearPendingQueryTimer, runner.type, sessionId, updateSession, handlePtyError, setLaunchPrompt, pendingQueryRef]);

  useEffect(() => {
    if (!isOpen) return;
    const s = useSessionStore.getState().sessions.find((x) => x.id === sessionId);
    if (hasNativeResumeBinding(s)) {
      setQuerySent(true);
    }
  }, [isOpen, sessionId]);

  useEffect(() => {
    const s = useSessionStore.getState().sessions.find((x) => x.id === sessionId);
    setQuerySent(!!s && ((s.status === "running" || s.status === "waiting" || s.status === "suspended") || hasNativeResumeBinding(s)));
    setPendingQuery(nativeDrafts.get(sessionId) ?? "");
    setLaunchPrompt(nativeLaunchPrompts.get(sessionId) ?? null);
    setLaunchResumeSessionId(
      s && getAgentAdapter(s.runner.type).supportsResume
        ? (s.providerSessionId?.trim() ?? "")
        : ""
    );
    clearPendingQueryTimer();
    ptyReadyRef.current = usePtyRuntimeStore.getState().sessions[sessionId] === "running";
  }, [clearPendingQueryTimer, sessionId, setPendingQuery, setLaunchPrompt]);

  useEffect(() => {
    if (isOpen && !querySent) {
      const t = setTimeout(() => queryInputRef.current?.focus(), 350);
      return () => clearTimeout(t);
    }
  }, [isOpen, querySent]);

  useEffect(() => {
    if (querySent && (worktreeReady || isResumeLaunch) && !ptyEverActive) {
      setPtyEverActive(true);
    }
  }, [querySent, worktreeReady, isResumeLaunch, ptyEverActive]);

  useEffect(() => {
    if (!supportsPromptLaunch) {
      setLaunchResumeSessionId("");
      return;
    }
    if (ptyEverActive) return;
    setLaunchResumeSessionId(boundResumeSessionId);
  }, [boundResumeSessionId, ptyEverActive, supportsPromptLaunch]);

  useEffect(() => {
    recheckCli();
    setInstalling(false);
  }, [recheckCli]);

  useEffect(() => {
    const u = listen<{ session_id: string; exit_code?: number; stopped?: boolean }>("pty-exit", ({ payload }) => {
      if (payload.session_id !== sessionIdRef.current || useChatStore.getState().threads[payload.session_id]?.busy) return;
      ptyReadyRef.current = false;
      clearPendingQueryTimer();
      pendingQueryRef.current = null;
      nativeLaunchPrompts.delete(payload.session_id);
      updateSession(payload.session_id, { status: payload.exit_code ? "error" : "done" });
    });
    return () => { clearPendingQueryTimer(); void u.then(f => f()).catch(() => {}); };
  }, [updateSession, clearPendingQueryTimer]);

  return {
    session,
    runner,
    runnerBadge,
    queryInputRef,
    pendingQuery,
    setPendingQuery,
    querySent,
    setQuerySent,
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
    handleSubmitQuery,
    handleLaunch,
    handleStop,
    handleInstall,
    handleSwitchRunner,
    supportsPromptLaunch,
    boundResumeSessionId,
    resumeSessionId,
    isResumeLaunch,
    cliCommand,
    installCmd,
    contextEnv: buildContextEnv(),
  };
}
