import { invoke } from "@tauri-apps/api/core";
import { useSessionStore, type ClaudeSession } from "../store/sessionStore";
import { chatSessionIdentity, sendChatTurn, useChatStore } from "../store/chatStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { usePtyRuntimeStore } from "../store/ptyRuntimeStore";

export interface ProjectPeer { sessionId: string; name: string; provider: string; workdir: string; status: string; activity: string; summary: string; updatedAt: number; stale: boolean }
export interface ProjectNote { seq: number; sender: string; message: string; createdAt: number }
export interface TeamMember { memberId: string; sessionId: string; projectPath: string; projectName?: string; name: string; provider: string; workdir: string; status: string; activity: string; summary: string; stale: boolean }
export interface TeamMessage { seq: number; senderId: string; senderName: string; recipientId?: string | null; kind: "request" | "reply" | "update"; message: string; createdAt: number; deliveryStatus?: "queued" | "delivered" | "read" | "failed" }
export interface TeamClaim { memberId: string; path: string; workdir: string; expiresAt: number; projectPath?: string; projectName?: string }
export interface TeamBoard { team: { id: string; name: string; objective: string; automatic: boolean } | null; selfId?: string; members: TeamMember[]; messages: TeamMessage[]; beforeCursor?: number | null; hasMore?: boolean; claims?: TeamClaim[]; claimsHasMore?: boolean }
export interface TeamConfiguration { teamId?: string; name: string; objective: string; automatic: boolean; members: { projectPath: string; sessionId: string }[] }
interface TeamDelivery { token: string; text: string; messageIds: number[] }
interface PendingTeamDelivery { sessionId: string; projectPath: string; delivery: TeamDelivery }
let deliveryGeneration = 0;
let dispatching = false;
let deliveryOffset = 0;
const dispatchInFlight = new Set<string>();
const teamChanged = () => window.dispatchEvent(new Event("agentdeck-team-changed"));
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
export async function teamCall<T = TeamBoard>(session: ClaudeSession, name: string, input: Record<string, unknown> = {}): Promise<T> {
  const mutation = name !== "team_board" && name !== "team_inbox";
  if (name === "team_leave") deliveryGeneration++;
  const result = await coordinationCall<T>(session, name, input);
  if (mutation) teamChanged();
  return result;
}
export async function configureTeam(session: ClaudeSession, input: TeamConfiguration): Promise<TeamBoard> {
  deliveryGeneration++;
  await syncProjectCoordination();
  const result = await invoke<string>("coordination_team_configure", { projectPath: projectPath(session), sessionId: session.id, input });
  teamChanged();
  void dispatchTeamMessages();
  return JSON.parse(result);
}
function acceptsTeamDelivery(session: ClaudeSession): boolean {
  const thread = useChatStore.getState().threads[session.id];
  return session.coordinationEnabled !== false
    && ["codex", "claude-code"].includes(session.runner.type)
    && !usePtyRuntimeStore.getState().sessions[session.id]
    && !["suspended", "error"].includes(session.status)
    && !!(session.providerSessionId || thread?.providerSessionId)
    && !thread?.compacting && !thread?.recoveryRequired && !thread?.error;
}
/** Local queue inspection never calls a model. Only an authorized team's pending request can wake a chat. */
export async function dispatchTeamMessages(): Promise<void> {
  if (dispatching || !started) return;
  dispatching = true;
  const generation = deliveryGeneration;
  try {
    const sessions = useSessionStore.getState().sessions.filter(session => acceptsTeamDelivery(session) && !dispatchInFlight.has(session.id));
    if (!sessions.length) return;
    const identities = new Map(sessions.map(session => [session.id, chatSessionIdentity(session)]));
    const offset = deliveryOffset % sessions.length;
    const ordered = [...sessions.slice(offset), ...sessions.slice(0, offset)];
    deliveryOffset = (offset + 8) % sessions.length;
    const pending = await invoke<PendingTeamDelivery[]>("coordination_team_pending", { targets: ordered.map(session => ({ sessionId: session.id, projectPath: projectPath(session), allowUpdates: !!useChatStore.getState().threads[session.id]?.busy })) });
    if (!Array.isArray(pending)) return;
    void Promise.allSettled(pending.map(async item => {
      if (dispatchInFlight.has(item.sessionId)) return;
      dispatchInFlight.add(item.sessionId);
      let success = false;
      try {
        const current = useSessionStore.getState().sessions.find(session => session.id === item.sessionId);
        const identity = identities.get(item.sessionId);
        if (generation !== deliveryGeneration || !identity || !current || !acceptsTeamDelivery(current) || projectPath(current) !== item.projectPath || chatSessionIdentity(current) !== identity) return;
        success = await sendChatTurn(current.id, item.delivery.text, [], { preserveDraft: true, coordination: true, expectedIdentity: identity });
      } finally {
        await invoke("coordination_team_finish_delivery", { projectPath: item.projectPath, sessionId: item.sessionId, token: item.delivery.token, success }).catch(() => {});
        dispatchInFlight.delete(item.sessionId);
        teamChanged();
      }
    }));
  } catch { /* Queue inspection retries locally; failed deliveries remain visible in the team. */ }
  finally { dispatching = false; }
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
  const deliveries = setInterval(() => void dispatchTeamMessages(), 3000);
  schedule();
  return () => { started = false; deliveryGeneration++; clearTimeout(timer); timer = undefined; clearInterval(heartbeat); clearInterval(deliveries); sessions(); chats(); };
}
