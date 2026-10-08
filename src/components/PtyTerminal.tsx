import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useAppI18n } from "../i18n";
import { useSettingsStore, isGlassTheme, type ThemeMode } from "../store/settingsStore";
import { startPtySession, stopPtySession } from "../store/ptyRuntimeStore";
import { encodeTerminalInput } from "../services/terminalEncoding";

interface Props {
  sessionId: string;
  command: string;     // e.g. "claude"
  args?: string[];     // e.g. ["--dangerously-skip-permissions"]
  workdir: string;
  active: boolean;     // Whether the terminal is visible and active.
  initialPrompt?: string | null;
  supportsPromptArg?: boolean;
  onReady?: () => void; // Called after the PTY process starts successfully, to forward the initial query.
  onWaiting?: () => void; // Called when the CLI completes a task and waits for the next query.
  onRunning?: () => void; // Called when the CLI starts processing a query.
  onError?: (error: string) => void; // Called when an API error interrupts execution.
  onNotification?: (title: string, message: string, notification_type: string) => void; // CLI hook notification callback.
  // Additional environment variables passed through to start_pty_session, such as AGENTDECK_* context.
  env?: [string, string][];
  // Enable Ctrl+C / Ctrl+V text copy and paste only for the main CLI terminal on Windows.
  enableWindowsCtrlCv?: boolean;
}

// ── xterm theme definitions ───────────────────────────────────
const TERM_THEME_DARK = {
  background:           "#060908",
  foreground:           "#e0e6e1",
  cursor:               "#95b59f",
  cursorAccent:         "#060908",
  selectionBackground:  "#243d2e",
  black:                "#1e1e2e",
  red:                  "#f87171",
  green:                "#4ade80",
  yellow:               "#fbbf24",
  blue:                 "#60a5fa",
  magenta:              "#c084fc",
  cyan:                 "#34d399",
  white:                "#e2e8f0",
  brightBlack:          "#374151",
  brightRed:            "#fc8181",
  brightGreen:          "#6ee7b7",
  brightYellow:         "#fde68a",
  brightBlue:           "#93c5fd",
  brightMagenta:        "#d8b4fe",
  brightCyan:           "#6ee7b7",
  brightWhite:          "#f1f5f9",
};

// Light mode uses a warm light background and dark foreground with sufficient contrast.
const TERM_THEME_LIGHT = {
  background:           "#f3f7f4",   // Pale background with contrasting terminal text for readability.
  foreground:           "#1b2c24",
  cursor:               "#087b49",
  cursorAccent:         "#f3f7f4",
  selectionBackground:  "rgba(0,122,255,0.25)",
  black:                "#f3f7f4",
  red:                  "#b52d40",
  green:                "#087b49",
  yellow:               "#8c5a05",
  blue:                 "#145ea3",
  magenta:              "#7541a0",
  cyan:                 "#087b49",
  white:                "#1b2c24",
  brightBlack:          "#4b5563",
  brightRed:            "#b52d40",
  brightGreen:          "#087b49",
  brightYellow:         "#8c5a05",
  brightBlue:           "#145ea3",
  brightMagenta:        "#7541a0",
  brightCyan:           "#087b49",
  brightWhite:          "#1b2c24",
};

// Resolve dark mode from settings.theme and the system media query.
function getIsDark(theme: ThemeMode): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  if (theme === "glass") return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getTerminalLook(theme: ThemeMode) {
  const isDark = getIsDark(theme);
  return {
    termTheme: isDark ? TERM_THEME_DARK : TERM_THEME_LIGHT,
    termBg: isDark ? "#131c19" : "#f3f7f4",
  };
}

function getTerminalMetrics(fontSize: number) {
  return {
    fontSize,
    lineHeight: 1.4,
  };
}

function getClampedTerminalSize(term: Terminal) {
  return {
    cols: Math.max(term.cols, 20),
    rows: Math.max(term.rows, 5),
  };
}

function writePtyData(sessionId: string, data: string) {
  const b64 = encodeTerminalInput(data);
  return invoke("write_pty", { sessionId, data: b64 });
}

function wheelDeltaToLines(event: WheelEvent, rows: number): number {
  if (event.deltaY === 0) return 0;

  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY > 0 ? Math.ceil(event.deltaY) : Math.floor(event.deltaY);
  }

  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY > 0 ? rows : -rows;
  }

  const lines = event.deltaY / 32;
  if (lines > 0) return Math.max(1, Math.round(lines));
  return Math.min(-1, Math.round(lines));
}

export function PtyTerminal({
  sessionId,
  command,
  args = [],
  workdir,
  active,
  initialPrompt,
  supportsPromptArg = false,
  onReady,
  onWaiting,
  onRunning,
  onError,
  onNotification,
  env,
  enableWindowsCtrlCv = false,
}: Props) {
  const { t } = useAppI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const startedRef = useRef(false);
  const startingRef = useRef(false);
  const launchTokenRef = useRef(0);
  const [exited, setExited] = useState(false);

  // Read the current theme.
  const theme = useSettingsStore((s) => s.settings.theme);
  const ptyFontSize = useSettingsStore((s) => s.settings.ptyFontSize);

  // ── Initialize xterm ────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    const { termTheme, termBg } = getTerminalLook(theme);
    const { fontSize, lineHeight } = getTerminalMetrics(ptyFontSize);
    const isWindows = navigator.userAgent.toLowerCase().includes("windows");

    const term = new Terminal({
      theme: termTheme,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize,
      lineHeight,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 5000,
      allowTransparency: false,
      convertEol: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    // Update the container background color.
    container.style.background = termBg;

    const wheelHandler = (event: WheelEvent) => {
      const termInstance = termRef.current;
      if (!termInstance || event.ctrlKey) return;

      const lines = wheelDeltaToLines(event, termInstance.rows || 24);
      if (lines === 0) return;

      event.preventDefault();
      event.stopPropagation();
      termInstance.scrollLines(lines);
      termInstance.focus();
    };

    container.addEventListener("wheel", wheelHandler, { passive: false });

    if (isWindows && enableWindowsCtrlCv) {
      term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        if (event.type !== "keydown" || !event.ctrlKey || event.altKey || event.metaKey) {
          return true;
        }

        const key = event.key.toLowerCase();
        if (key === "c") {
          if (!term.hasSelection()) return true;
          event.preventDefault();
          event.stopPropagation();
          void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
          return false;
        }

        if (key === "v") {
          event.preventDefault();
          event.stopPropagation();
          void navigator.clipboard.readText()
            .then((text) => {
              if (!text) return;
              return writePtyData(sessionId, text);
            })
            .catch(() => {});
          return false;
        }

        return true;
      });
    }

    // Forward keyboard input to the PTY, encoded as base64.
    term.onData((data: string) => {
      writePtyData(sessionId, data).catch(() => {});
    });

    return () => {
      container.removeEventListener("wheel", wheelHandler);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Switching runner/workdir changes the key and unmounts this component; stop the old PTY so it cannot consume the next input.
  useEffect(() => {
    return () => {
      if (!startedRef.current && !startingRef.current) return;
      startingRef.current = false;
      launchTokenRef.current += 1;
      if (startedRef.current) {
        stopPtySession(sessionId).catch(() => {});
      }
    };
  }, [sessionId]);

  // ── Update xterm colors when the theme changes ──────────────
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const { termTheme, termBg } = getTerminalLook(theme);
    const { fontSize, lineHeight } = getTerminalMetrics(ptyFontSize);

    // xterm 5.x supports updating options.theme directly.
    term.options.theme = termTheme;
    term.options.fontSize = fontSize;
    term.options.lineHeight = lineHeight;

    if (containerRef.current) {
      containerRef.current.style.background = termBg;
    }

    requestAnimationFrame(() => {
      fitRef.current?.fit();
    });

    // In system mode, listen for system color changes.
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const listener = (e: MediaQueryListEvent) => {
        const t = termRef.current;
        if (!t) return;
        t.options.theme = e.matches ? TERM_THEME_DARK : TERM_THEME_LIGHT;
        t.options.fontSize = ptyFontSize;
        t.options.lineHeight = 1.4;
        const bg = e.matches ? "#0a0a0c" : "#1e1e2e";
        if (containerRef.current) containerRef.current.style.background = bg;
        requestAnimationFrame(() => {
          fitRef.current?.fit();
        });
      };
      mq.addEventListener("change", listener);
      return () => mq.removeEventListener("change", listener);
    }
  }, [ptyFontSize, theme]);

  // Keep the latest callbacks in refs to avoid stale closures without adding dependencies.
  const onWaitingRef = useRef(onWaiting);
  onWaitingRef.current = onWaiting;
  const onRunningRef = useRef(onRunning);
  onRunningRef.current = onRunning;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onNotificationRef = useRef(onNotification);
  onNotificationRef.current = onNotification;

  // ── Listen for PTY data events ──────────────────────────────
  useEffect(() => {
    const u1 = listen<{ session_id: string; data: string }>(
      "pty-data",
      ({ payload }) => {
        if (payload.session_id !== sessionId) return;
        const term = termRef.current;
        if (!term) return;
        try {
          const bin = atob(payload.data);
          const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
          term.write(bytes);
        } catch {}
      }
    );

    const u2 = listen<{ session_id: string }>(
      "pty-exit",
      ({ payload }) => {
        if (payload.session_id !== sessionId) return;
        termRef.current?.writeln("\r\n\x1b[90m─────────────────────────────────────\x1b[0m");
        termRef.current?.writeln(`\x1b[90m${t("pty.processExited")}\x1b[0m`);
        setExited(true);
        startedRef.current = false; // Allow restarting.
        startingRef.current = false;
        launchTokenRef.current += 1;
      }
    );

    // The CLI completed the task and awaits another query, detected by "? for shortcuts".
    const u3 = listen<{ session_id: string }>(
      "pty-waiting",
      ({ payload }) => {
        if (payload.session_id !== sessionId) return;
        onWaitingRef.current?.();
      }
    );

    // The CLI started processing a query, detected by "esc to interrupt".
    const u4 = listen<{ session_id: string }>(
      "pty-running",
      ({ payload }) => {
        if (payload.session_id !== sessionId) return;
        onRunningRef.current?.();
      }
    );

    // API error interruption, such as the Claude StopFailure hook.
    const u5 = listen<{ session_id: string; error: string }>(
      "pty-error",
      ({ payload }) => {
        if (payload.session_id !== sessionId) return;
        onErrorRef.current?.(payload.error);
      }
    );

    // CLI Notification hook, currently mainly from Claude when user confirmation or input is needed.
    const u6 = listen<{ session_id: string; title: string; message: string; notification_type: string }>(
      "pty-notification",
      ({ payload }) => {
        if (payload.session_id !== sessionId) return;
        onNotificationRef.current?.(payload.title, payload.message, payload.notification_type);
      }
    );

    return () => {
      u1.then((f) => f()).catch(() => {});
      u2.then((f) => f()).catch(() => {});
      u3.then((f) => f()).catch(() => {});
      u4.then((f) => f()).catch(() => {});
      u5.then((f) => f()).catch(() => {});
      u6.then((f) => f()).catch(() => {});
    };
  }, [sessionId]);

  // ── Start the PTY process once and keep it alive until exit ──
  // Keep the latest args/onReady/env in refs so dependency changes do not restart it on every render.
  const argsRef = useRef(args);
  argsRef.current = args;
  const initialPromptRef = useRef(initialPrompt);
  initialPromptRef.current = initialPrompt;
  const supportsPromptArgRef = useRef(supportsPromptArg);
  supportsPromptArgRef.current = supportsPromptArg;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const envRef = useRef(env);
  envRef.current = env;

  const buildLaunchArgs = () => {
    const launchArgs = [...argsRef.current];
    const prompt = initialPromptRef.current?.trim();
    // The backend adds relevant local context and uses the provider-specific prompt flag.
    void prompt;
    return launchArgs;
  };

  useEffect(() => {
    if (!active || exited || startedRef.current || startingRef.current) return;
    startingRef.current = true;
    setExited(false);
    const launchToken = launchTokenRef.current + 1;
    launchTokenRef.current = launchToken;
    let launchRequested = false;

    // Wait 250 ms for the resize_popup_full animation to finish and the container to reach its target size.
    const timer = setTimeout(() => {
      if (launchTokenRef.current !== launchToken) return;
      const fit = fitRef.current;
      const term = termRef.current;
      if (fit) fit.fit();
      const cols = Math.max(term?.cols ?? 80, 40);
      const rows = Math.max(term?.rows ?? 24, 12);
      const launchArgs = buildLaunchArgs();
      const prompt = initialPromptRef.current?.trim();

      // Print the startup command so debugging can confirm what was actually launched.
      const displayCmd = prompt && supportsPromptArgRef.current
        ? [command, ...argsRef.current, "<prompt>"].join(" ")
        : [command, ...launchArgs].join(" ");
      term?.writeln(`\x1b[90m$ ${displayCmd}\x1b[0m`);

      launchRequested = true;
      startPtySession({
        sessionId,
        workdir,
        command,
        args: launchArgs,
        initialPrompt: supportsPromptArgRef.current ? initialPromptRef.current : null,
        cols,
        rows,
        env: envRef.current ?? null,
      })
        .then(() => {
          if (launchTokenRef.current !== launchToken) { void stopPtySession(sessionId).catch(() => {}); return; }
          startedRef.current = true;
          startingRef.current = false;
          // A successful spawn means the CLI started; resolve_command_path supplies an absolute executable path.
          onReadyRef.current?.();
        })
        .catch((e) => {
          if (launchTokenRef.current !== launchToken) return;
          startingRef.current = false;
          startedRef.current = false;
          setExited(true);
          onErrorRef.current?.(String(e));
          termRef.current?.writeln(`\x1b[31m${t("session.installFailed", { error: String(e) })}\x1b[0m`);
        });
    }, 250);

    return () => {
      clearTimeout(timer);
      if (launchTokenRef.current === launchToken && !startedRef.current && !launchRequested) {
        startingRef.current = false;
      }
    };
  }, [active, sessionId, workdir, command]);

  // ── Restart after exit when the user clicks Restart ─────────
  const handleRestart = () => {
    setExited(false);
    startedRef.current = false;
    startingRef.current = false;
    launchTokenRef.current += 1;
    termRef.current?.clear();

    const fit = fitRef.current;
    const term = termRef.current;
    if (fit) fit.fit();
    const cols = Math.max(term?.cols ?? 80, 40);
    const rows = Math.max(term?.rows ?? 24, 12);
    startingRef.current = true;
    const launchToken = launchTokenRef.current + 1;
    launchTokenRef.current = launchToken;

    const displayCmd = [command, ...argsRef.current].join(" ");
    term?.writeln(`\x1b[90m$ ${displayCmd}\x1b[0m`);

    startPtySession({
      sessionId,
      workdir,
      command,
      args: argsRef.current,
      cols,
      rows,
      env: envRef.current ?? null,
      })
      .then(() => {
        if (launchTokenRef.current !== launchToken) { void stopPtySession(sessionId).catch(() => {}); return; }
        startedRef.current = true;
        startingRef.current = false;
        onReadyRef.current?.();
      })
      .catch((e) => {
        if (launchTokenRef.current !== launchToken) return;
        startedRef.current = false;
        startingRef.current = false;
        setExited(true);
        onErrorRef.current?.(String(e));
        termRef.current?.writeln(`\x1b[31m${t("session.installFailed", { error: String(e) })}\x1b[0m`);
      });
  };

  // ── Fit and focus when visible; reopening restores focus without restarting the PTY ──
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => {
      fitRef.current?.fit();
      const term = termRef.current;
      term?.focus();
      if (!term) return;
      invoke("resize_pty", { sessionId, ...getClampedTerminalSize(term) }).catch(() => {});
    }, 80);
    return () => clearTimeout(t);
  }, [active, sessionId]);

  // Expose active through a ref to avoid a stale closure in ResizeObserver callbacks.
  const activeRef = useRef(active);
  activeRef.current = active;

  // ── ResizeObserver: fit automatically and sync PTY dimensions to Rust ──
  // Sync dimensions only while active=true, when the panel is visible.
  // A collapsed panel can produce tiny resize_pty dimensions that crash the process.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const fit = fitRef.current;
      const term = termRef.current;
      if (!fit || !term) return;
      fit.fit();
      // Sync only while visible to avoid zero columns/rows crashing the process when collapsed.
      if (!activeRef.current) return;
      invoke("resize_pty", { sessionId, ...getClampedTerminalSize(term) }).catch(() => {});
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [sessionId]);

  const isGlass = isGlassTheme(theme);
  const { termBg } = getTerminalLook(theme);

  return (
    <div
      className="ci-pty-terminal"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: termBg,
      }}
    >
      {/* xterm canvas */}
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%", background: termBg }}
      />

      {/* Restart overlay after exit */}
      {exited && (
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0,
          padding: "12px 16px",
          background: `linear-gradient(to top, ${termBg} 70%, transparent)`,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 12,
        }}>
          <span style={{
            fontSize: 11,
            color: isGlass ? "var(--ci-text-dim)" : "rgba(255,255,255,0.35)",
            fontFamily: "monospace",
          }}>
            {t("pty.sessionEnded")}
          </span>
          <button
            onClick={handleRestart}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "5px 14px", borderRadius: 8,
              border: isGlass ? "1px solid var(--ci-accent-bdr)" : "1px solid rgba(96,165,250,0.35)",
              background: isGlass ? "var(--ci-accent-bg)" : "rgba(96,165,250,0.1)",
              color: isGlass ? "var(--ci-accent)" : "#60a5fa", fontSize: 12, fontWeight: 600,
              cursor: "pointer", transition: "background 0.15s, border-color 0.15s",
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = isGlass ? "rgba(63,145,255,0.16)" : "rgba(96,165,250,0.2)";
              e.currentTarget.style.borderColor = isGlass ? "rgba(96,175,255,0.26)" : "rgba(96,165,250,0.6)";
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = isGlass ? "var(--ci-accent-bg)" : "rgba(96,165,250,0.1)";
              e.currentTarget.style.borderColor = isGlass ? "rgba(96,175,255,0.20)" : "rgba(96,165,250,0.35)";
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            {t("common.restart")}
          </button>
        </div>
      )}
    </div>
  );
}
