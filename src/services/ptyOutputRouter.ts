import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePtyRuntimeStore } from "../store/ptyRuntimeStore";
import { useSessionStore } from "../store/sessionStore";

export interface OutputEvent { session_id: string; data: string; run_id?: number; offset?: number; end_offset?: number }
interface OutputPage { runId: number; data: string; nextOffset: number; endOffset: number; closed: boolean }
export interface PtySink {
  data: (bytes: Uint8Array) => Promise<void>;
  reset?: () => void;
  exit?: () => void;
  waiting?: () => void;
  running?: () => void;
  error?: (error: string) => void;
  notification?: (title: string, message: string, type: string) => void;
}
interface Subscriber { sink: PtySink; disposed: boolean; replaying: boolean; runId?: number; offset: number; latestEnd: number; tail: Promise<void> }
const subscribers = new Map<string, Set<Subscriber>>();
const outputObservers = new Set<(event: OutputEvent) => void>();
export function observePtyOutput(observer: (event: OutputEvent) => void) { outputObservers.add(observer); return () => { outputObservers.delete(observer); }; }
let listening: Promise<void> | undefined;
function decode(data: string) { const binary = atob(data); return Uint8Array.from(binary, c => c.charCodeAt(0)); }
function ack(event: OutputEvent) {
  if (event.run_id !== undefined && event.end_offset !== undefined) return invoke<void>("ack_pty_output", { sessionId: event.session_id, runId: event.run_id, endOffset: event.end_offset }).catch(() => {});
  return Promise.resolve();
}
function entries(id: string) { return [...(subscribers.get(id) ?? [])].filter(entry => !entry.disposed); }
async function replay(id: string, entry: Subscriber) {
  entry.replaying = true;
  while (!entry.disposed) {
    const page = await invoke<OutputPage | null>("read_pty_output", { sessionId: id, offset: entry.offset, maxBytes: 65536 });
    if (!page || entry.disposed) break;
    if (entry.runId !== undefined && page.runId < entry.runId) continue;
    if (entry.runId !== undefined && entry.runId !== page.runId) { entry.runId = page.runId; entry.offset = 0; entry.latestEnd = 0; entry.sink.reset?.(); continue; }
    if (entry.runId !== page.runId && entry.offset !== 0) { entry.runId = page.runId; entry.offset = 0; continue; }
    entry.runId = page.runId;
    if (page.data) await entry.sink.data(decode(page.data));
    entry.offset = page.nextOffset;
    if (entry.offset >= page.endOffset && entry.offset >= entry.latestEnd) break;
    // Each replay chunk yields to typing, scrolling and cancellation.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  entry.replaying = false;
}
function deliver(id: string, entry: Subscriber, event: OutputEvent) {
  if (entry.replaying) { entry.latestEnd = Math.max(entry.latestEnd, event.end_offset ?? 0); return Promise.resolve(); }
  entry.tail = entry.tail.then(async () => {
    if (entry.disposed) return;
    if (event.run_id !== undefined) {
      if (entry.runId !== undefined && event.run_id < entry.runId) return;
      if (entry.runId !== undefined && entry.runId !== event.run_id) { entry.offset = 0; entry.latestEnd = 0; entry.sink.reset?.(); }
      entry.runId = event.run_id;
      if ((event.offset ?? 0) > entry.offset) { entry.latestEnd = event.end_offset ?? entry.offset; await replay(id, entry); return; }
    }
    const bytes = decode(event.data);
    const skip = event.offset === undefined ? 0 : Math.max(0, entry.offset - event.offset);
    if (skip < bytes.length) await entry.sink.data(bytes.subarray(skip));
    entry.offset = event.end_offset ?? entry.offset + bytes.length;
  }).catch(error => entry.sink.error?.(String(error)));
  return entry.tail;
}
/** Install one listener per native event for the entire application, independent of open tabs. */
export function ensurePtyRouter(): Promise<void> {
  if (listening) return listening;
  listening = Promise.all([
    listen<OutputEvent>("pty-data", ({ payload }) => {
      outputObservers.forEach(observer => { try { observer(payload); } catch { /* Telemetry cannot interrupt terminal consumption. */ } });
      void Promise.all(entries(payload.session_id).map(entry => deliver(payload.session_id, entry, payload))).finally(() => ack(payload));
    }),
    listen<{ session_id: string; run_id?: number }>("pty-started", ({ payload }) => {
      for (const entry of entries(payload.session_id)) {
        if (entry.runId !== undefined && payload.run_id !== undefined && entry.runId !== payload.run_id) entry.sink.reset?.();
        entry.runId = payload.run_id; entry.offset = 0; entry.latestEnd = 0;
      }
    }),
    listen<{ session_id: string; exit_code?: number }>("pty-exit", ({ payload }) => {
      if (usePtyRuntimeStore.getState().sessions[payload.session_id] !== "stopping") usePtyRuntimeStore.getState().set(payload.session_id);
      useSessionStore.getState().updateSession(payload.session_id, { status: payload.exit_code ? "error" : "done" });
      for (const entry of entries(payload.session_id)) entry.tail = entry.tail.then(async () => { if (!entry.disposed) { await replay(payload.session_id, entry); entry.sink.exit?.(); } }).catch(error => entry.sink.error?.(String(error)));
    }),
    listen<{ session_id: string }>("pty-waiting", ({ payload }) => entries(payload.session_id).forEach(entry => entry.sink.waiting?.())),
    listen<{ session_id: string }>("pty-running", ({ payload }) => entries(payload.session_id).forEach(entry => entry.sink.running?.())),
    listen<{ session_id: string; error: string }>("pty-error", ({ payload }) => entries(payload.session_id).forEach(entry => entry.sink.error?.(payload.error))),
    listen<{ session_id: string; title: string; message: string; notification_type: string }>("pty-notification", ({ payload }) => entries(payload.session_id).forEach(entry => entry.sink.notification?.(payload.title, payload.message, payload.notification_type))),
  ]).then(() => {}).catch(error => { listening = undefined; throw error; });
  return listening;
}
export function attachPtyOutput(id: string, sink: PtySink) {
  const entry: Subscriber = { sink, disposed: false, replaying: true, offset: 0, latestEnd: 0, tail: Promise.resolve() };
  const existing = subscribers.get(id) ?? new Set<Subscriber>(); existing.add(entry); subscribers.set(id, existing);
  const ready = ensurePtyRouter().then(() => replay(id, entry)).catch(error => { entry.replaying = false; sink.error?.(String(error)); });
  return { ready, dispose: () => { entry.disposed = true; existing.delete(entry); if (!existing.size) subscribers.delete(id); } };
}
