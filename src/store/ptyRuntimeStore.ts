import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

type Phase = "starting" | "running" | "stopping";
export const usePtyRuntimeStore = create<{ sessions: Record<string, Phase>; set: (id: string, phase?: Phase) => void }>(set => ({
  sessions: {},
  set: (id, phase) => set(state => { const sessions = { ...state.sessions }; if (phase) sessions[id] = phase; else delete sessions[id]; return { sessions }; }),
}));
const starts = new Map<string, Promise<void>>();
const stops = new Map<string, Promise<void>>();
export function startPtySession(args: Record<string, unknown> & { sessionId: string }): Promise<void> {
  const id = args.sessionId;
  if (starts.has(id) || usePtyRuntimeStore.getState().sessions[id]) return Promise.reject(new Error("Terminal is already starting or running."));
  usePtyRuntimeStore.getState().set(id, "starting");
  const promise = invoke<void>("start_pty_session", args).then(() => {
    if (usePtyRuntimeStore.getState().sessions[id] === "starting") usePtyRuntimeStore.getState().set(id, "running");
  }).catch(error => { usePtyRuntimeStore.getState().set(id); throw error; }).finally(() => starts.delete(id));
  starts.set(id, promise);
  return promise;
}
/** A stop during spawn must await spawn; otherwise the process can escape its owner. */
export function stopPtySession(id: string): Promise<void> {
  if (stops.has(id)) return stops.get(id)!;
  usePtyRuntimeStore.getState().set(id, "stopping");
  const promise = (async () => {
    await starts.get(id)?.catch(() => {});
    await invoke("stop_pty_session", { sessionId: id });
    usePtyRuntimeStore.getState().set(id);
  })().catch(error => { usePtyRuntimeStore.getState().set(id, "running"); throw error; }).finally(() => stops.delete(id));
  stops.set(id, promise);
  return promise;
}
