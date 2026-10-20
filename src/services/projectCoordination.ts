import { invoke } from "@tauri-apps/api/core";
import { useSessionStore, type ClaudeSession } from "../store/sessionStore";
import { useChatStore } from "../store/chatStore";
import { useWorkspaceStore } from "../store/workspaceStore";

export interface ProjectPeer { sessionId: string; name: string; provider: string; workdir: string; status: string; activity: string; summary: string; updatedAt: number; stale: boolean }
export interface ProjectNote { seq: number; sender: string; message: string; createdAt: number }
export const projectPath = (session: ClaudeSession) => useWorkspaceStore.getState().workspaces.find(w => w.id === session.workspaceId)?.path || session.workdir;
const clip = (text: string, bytes: number) => {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= bytes) return text;
  let end = bytes; while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(encoded.subarray(0, end));
};
let syncing: Promise<void> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let inFlight: Promise<void> | undefined;
let requested = false;

/** Serialized metadata only. No draft, response, tool output, source or credentials. */
export function syncProjectCoordination(): Promise<void> {
  requested = true;
  if (inFlight) return inFlight;
  const run = async () => { while (requested) { requested = false; await writePresence(); } };
  inFlight = run().finally(() => { inFlight = undefined; });
  return inFlight;
}
function writePresence(): Promise<void> {
  const entries = useSessionStore.getState().sessions.slice(0, 500).map(session => {
    const thread = useChatStore.getState().threads[session.id];
    return { sessionId: session.id, projectPath: projectPath(session), name: clip(session.name, 256),
      provider: session.runner.type, workdir: session.worktreePath || session.workdir,
      status: thread?.busy ? thread.status || "running" : session.status,
      activity: clip(thread?.activity || session.currentTask || "", 1200), enabled: session.coordinationEnabled !== false };
  });
  const next = syncing.catch(() => {}).then(() => invoke<void>("coordination_sync_sessions", { entries }));
  syncing = next;
  return next;
}
export async function coordinationCall<T>(session: ClaudeSession, name: string, input: Record<string, unknown> = {}): Promise<T> {
  const result = await invoke<string>("coordination_call", { projectPath: projectPath(session), sessionId: session.id, name, input });
  return JSON.parse(result);
}
export function startProjectCoordination(): () => void {
  if (started) return () => {};
  started = true;
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void syncProjectCoordination().catch(() => {}); }, 2000); };
  const sessions = useSessionStore.subscribe((state, previous) => {
    if (state.sessions === previous.sessions) return;
    schedule();
    const ids = new Set(state.sessions.map(session => session.id));
    for (const session of previous.sessions) if (!ids.has(session.id)) {
      // Wait for earlier presence writes so deletion cannot be undone by an old snapshot.
      syncing = syncing.catch(() => {}).then(() => invoke<void>("coordination_remove_session", { projectPath: projectPath(session), sessionId: session.id })).catch(() => {});
    }
  });
  const chats = useChatStore.subscribe((state, previous) => {
    for (const [id, thread] of Object.entries(state.threads)) {
      const old = previous.threads[id];
      if (!old || old.busy !== thread.busy || old.status !== thread.status || old.activity !== thread.activity) { schedule(); break; }
    }
  });
  const heartbeat = setInterval(schedule, 30_000);
  schedule();
  return () => { started = false; clearTimeout(timer); timer = undefined; clearInterval(heartbeat); sessions(); chats(); };
}
