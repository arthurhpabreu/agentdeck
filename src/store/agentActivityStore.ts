import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { usePtyRuntimeStore } from "./ptyRuntimeStore";

export type ActivityPhase = "idle" | "starting" | "connected" | "running" | "waiting" | "done" | "stopped" | "error";
export interface AgentActivity {
  phase: ActivityPhase;
  pid?: number;
  command?: string;
  startedAt?: number;
  endedAt?: number;
  lastOutputAt?: number;
  bytes: number;
  exitCode?: number;
  error?: string;
  events: { at: number; key: string; detail?: string }[];
}
export const emptyActivity: AgentActivity = { phase: "idle", bytes: 0, events: [] };
export const useAgentActivityStore = create<{
  sessions: Record<string, AgentActivity>;
  record: (id: string, patch: Partial<AgentActivity>, event?: string, detail?: string) => void;
  remove: (id: string) => void;
}>((set) => ({
  sessions: {},
  record: (id, patch, event, detail) => set(state => {
    const old = state.sessions[id] ?? emptyActivity;
    return { sessions: { ...state.sessions, [id]: { ...old, ...patch,
      events: event ? [...old.events, { at: Date.now(), key: event, detail }].slice(-80) : old.events,
    } } };
  }),
  remove: id => set(state => { const sessions = { ...state.sessions }; delete sessions[id]; return { sessions }; }),
}));

/** One subscription per app; streaming bytes are batched without persisting terminal data. */
export async function startActivityTracking() {
  if (!("__TAURI_INTERNALS__" in window)) return () => {};
  const record = useAgentActivityStore.getState().record;
  const pending = new Map<string, { bytes: number; at: number }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    for (const [id, data] of pending) {
      const old = useAgentActivityStore.getState().sessions[id] ?? emptyActivity;
      record(id, { bytes: old.bytes + data.bytes, lastOutputAt: data.at });
    }
    pending.clear();
  };
  const subscriptions = await Promise.all([
    listen<{ session_id: string; pid?: number; command: string }>("pty-started", ({ payload: p }) => {
      record(p.session_id, { phase: "connected", pid: p.pid, command: p.command, startedAt: Date.now(), endedAt: undefined, error: undefined, exitCode: undefined, bytes: 0, lastOutputAt: undefined }, "activity.connected");
    }),
    listen<{ session_id: string; data: string }>("pty-data", ({ payload: p }) => {
      const length = Math.floor(p.data.length * 3 / 4) - (p.data.endsWith("==") ? 2 : p.data.endsWith("=") ? 1 : 0);
      const old = pending.get(p.session_id);
      pending.set(p.session_id, { bytes: (old?.bytes ?? 0) + length, at: Date.now() });
      if (!timer) timer = setTimeout(flush, 250);
    }),
    listen<{ session_id: string }>("pty-running", ({ payload: p }) => record(p.session_id, { phase: "running" }, "activity.running")),
    listen<{ session_id: string }>("pty-waiting", ({ payload: p }) => record(p.session_id, { phase: "waiting" }, "activity.waiting")),
    listen<{ session_id: string; error: string }>("pty-error", ({ payload: p }) => record(p.session_id, { phase: "error", error: p.error }, "activity.error", p.error)),
    listen<{ session_id: string; message: string }>("pty-notification", ({ payload: p }) => record(p.session_id, { phase: "waiting" }, "activity.attention", p.message)),
    listen<{ session_id: string; exit_code?: number; stopped?: boolean }>("pty-exit", ({ payload: p }) => {
      // Keep the send guard until an in-flight stop has acknowledged completion.
      if (usePtyRuntimeStore.getState().sessions[p.session_id] !== "stopping") usePtyRuntimeStore.getState().set(p.session_id);
      const phase = p.stopped ? "stopped" : p.exit_code ? "error" : "done";
      record(p.session_id, { phase, endedAt: Date.now(), exitCode: p.exit_code }, `activity.${phase}`);
    }),
  ]);
  return () => { if (timer) clearTimeout(timer); subscriptions.forEach(stop => stop()); pending.clear(); };
}
