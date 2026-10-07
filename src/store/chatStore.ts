import { executionOptions } from "../services/agentExecution";
import { usePtyRuntimeStore } from "./ptyRuntimeStore";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSessionStore } from "./sessionStore";
import { useWorkspaceStore } from "./workspaceStore";
import { useAgentActivityStore } from "./agentActivityStore";
import { useAgentObservabilityStore } from "./agentObservabilityStore";

export interface ChatAttachment { name: string; path: string; mimeType: string; size: number }
export interface ChatUsage { inputTokens: number; cachedInputTokens: number; outputTokens: number }
export interface ChatMessage { id: string; turnId: string; role: "user" | "assistant" | "tool"; text: string; at: number; title?: string; status?: string; attachments?: ChatAttachment[]; parentId?: string }
export interface ChatThread { messages: ChatMessage[]; draft: string; goal?: string; lastSentGoal?: string; busy: boolean; turnId?: string; error?: string; status?: string; providerSessionId?: string; updatedAt?: number; diagnostic?: string; lastUsage?: ChatUsage; totalUsage?: ChatUsage; meteredTurns?: number; lastUsageTurnId?: string; resolvedModel?: string }
export interface ChatEvent { sessionId: string; turnId: string; kind: "text" | "tool" | "status" | "session" | "error" | "done" | "input"; text?: string; itemId?: string; title?: string; status?: string; providerSessionId?: string; delta?: boolean; pid?: number; parentId?: string; usage?: unknown; model?: string }
export const emptyThread: ChatThread = { messages: [], draft: "", busy: false };
const KEY = "agentdeck-chat-v1";
export function normalizeChatUsage(value: unknown): ChatUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (!valid(usage.input_tokens) || !valid(usage.output_tokens)) return undefined;
  const cached = valid(usage.cached_input_tokens) ? usage.cached_input_tokens : valid(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : 0;
  // Codex input_tokens includes cached tokens; Claude reports cache read/write separately.
  const input = usage.input_tokens + (valid(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : 0) + (valid(usage.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : 0);
  return { inputTokens: input, cachedInputTokens: cached, outputTokens: usage.output_tokens };
}
function restore(): Record<string, ChatThread> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value && Array.isArray((value as ChatThread).messages)).map(([id, value]) => [id, { ...(value as ChatThread), busy: false, turnId: undefined, status: undefined }]));
  } catch { return {}; }
}
export const useChatStore = create<{
  threads: Record<string, ChatThread>; storageError: boolean;
  patch: (id: string, patch: Partial<ChatThread>) => void;
  event: (event: ChatEvent) => void;
  remove: (id: string) => void;
}>((set) => ({
  threads: restore(), storageError: false,
  patch: (id, patch) => set(s => ({ threads: { ...s.threads, [id]: { ...(s.threads[id] ?? emptyThread), ...patch, updatedAt: Date.now() } } })),
  remove: id => set(s => { const threads = { ...s.threads }; delete threads[id]; return { threads }; }),
  event: e => set(s => {
    const old = s.threads[e.sessionId];
    if (!old || old.turnId !== e.turnId) return s;
    let next = { ...old, updatedAt: Date.now() };
    const usage = !e.parentId ? normalizeChatUsage(e.usage) : undefined;
    if (usage) {
      // Final CLI reports may be repeated or corrected. Replace this turn's contribution
      // instead of adding it twice; subagent usage is already included by the provider.
      const repeated = old.lastUsageTurnId === e.turnId;
      const zero: ChatUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
      const previous = repeated ? old.lastUsage ?? zero : zero;
      const total = old.totalUsage ?? zero;
      next.lastUsage = usage;
      next.lastUsageTurnId = e.turnId;
      next.totalUsage = {
        inputTokens: total.inputTokens - previous.inputTokens + usage.inputTokens,
        cachedInputTokens: total.cachedInputTokens - previous.cachedInputTokens + usage.cachedInputTokens,
        outputTokens: total.outputTokens - previous.outputTokens + usage.outputTokens,
      };
      next.meteredTurns = (old.meteredTurns ?? 0) + (repeated ? 0 : 1);
    }
    if (e.model && !e.parentId) next.resolvedModel = e.model;
    if (e.kind === "session") next.providerSessionId = e.providerSessionId;
    if (e.kind === "status") { next.status = e.status; if (e.text && e.status !== "reasoning") next.diagnostic = (old.diagnostic ? old.diagnostic + "\n" : "") + e.text; next.diagnostic = next.diagnostic?.slice(-8000); }
    if (e.kind === "error") next.error = e.text ?? "Agent error";
    if (e.kind === "input") next.messages = old.messages.map(m => m.id === `${e.itemId}:user` ? { ...m, status: e.status, ...(e.text ? { title: e.text } : {}) } : m);
    if (e.kind === "done") next = { ...next, busy: false, status: e.status, messages: next.messages.map(m => m.role === "user" && (m.status === "sending" || m.status === "queued") ? { ...m, status: "failed" } : m) };
    if (e.kind === "text" || e.kind === "tool") {
      const id = `${e.turnId}:${e.itemId ?? e.kind}`;
      const index = old.messages.findIndex(m => m.id === id);
      const previous = old.messages[index];
      const message: ChatMessage = { id, turnId: e.turnId, role: e.kind === "tool" ? "tool" : "assistant", at: previous?.at ?? Date.now(), title: e.title ?? previous?.title, status: e.status ?? previous?.status, parentId: e.parentId ?? previous?.parentId, text: e.delta ? (previous?.text ?? "") + (e.text ?? "") : e.text ?? previous?.text ?? "" };
      next.messages = index < 0 ? [...old.messages, message] : old.messages.map((m, i) => i === index ? message : m);
    }
    return { threads: { ...s.threads, [e.sessionId]: next } };
  }),
}));

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  clearTimeout(saveTimer); saveTimer = undefined;
  try {
    const threads = useChatStore.getState().threads;
    localStorage.setItem(KEY, JSON.stringify(threads));
    if (useChatStore.getState().storageError) useChatStore.setState({ storageError: false });
  } catch { if (!useChatStore.getState().storageError) useChatStore.setState({ storageError: true }); }
}
useChatStore.subscribe((state, old) => { if (state.threads !== old.threads && !saveTimer) saveTimer = setTimeout(persist, 800); });
window.addEventListener("pagehide", persist);

let subscription: Promise<() => void> | undefined;
const cancelledTurns = new Set<string>();
const launches = new Map<string, Promise<void>>();
export function ensureChatEvents() {
  if (!subscription) subscription = listen<ChatEvent>("chat-event", ({ payload: e }) => {
    if (e.kind === "status" && e.status === "started" && cancelledTurns.has(e.turnId)) void invoke("stop_chat_turn", { sessionId: e.sessionId }).catch(() => {});
    if (e.kind === "done") cancelledTurns.delete(e.turnId);
    const thread = useChatStore.getState().threads[e.sessionId];
    if (thread?.turnId !== e.turnId || !thread.busy) return;
    useAgentObservabilityStore.getState().recordChat(e);
    useChatStore.getState().event(e);
    const record = useAgentActivityStore.getState().record;
    if (e.kind === "session" && e.providerSessionId) useSessionStore.getState().updateSession(e.sessionId, { providerSessionId: e.providerSessionId });
    if (e.kind === "text" || e.kind === "tool") {
      const bytes = useAgentActivityStore.getState().sessions[e.sessionId]?.bytes ?? 0;
      record(e.sessionId, { phase: "running", lastOutputAt: Date.now(), bytes: bytes + new TextEncoder().encode(e.text ?? "").length }, e.kind === "tool" ? "activity.running" : undefined, e.title);
    }
    if (e.kind === "status") record(e.sessionId, { phase: "running", ...(e.pid ? { pid: e.pid } : {}) });
    if (e.kind === "error") record(e.sessionId, { error: e.text }, "activity.error", e.text);
    if (e.kind === "done") {
      cancelledTurns.delete(e.turnId);
      const current = useChatStore.getState().threads[e.sessionId];
      const phase = e.status === "stopped" ? "stopped" : current?.error || e.status === "error" ? "error" : "done";
      record(e.sessionId, { phase, endedAt: Date.now() }, `activity.${phase}`);
      useSessionStore.getState().updateSession(e.sessionId, { status: phase === "error" ? "error" : phase === "stopped" ? "suspended" : "waiting" });
      persist();
    }
  }).catch(error => { subscription = undefined; throw error; });
  return subscription;
}

export async function sendChatTurn(sessionId: string, prompt: string, attachments: ChatAttachment[]): Promise<boolean> {
  const session = useSessionStore.getState().sessions.find(s => s.id === sessionId);
  const old = useChatStore.getState().threads[sessionId] ?? emptyThread;
  if (!session || usePtyRuntimeStore.getState().sessions[sessionId] || (!prompt.trim() && !attachments.length)) return false;
  if (old.busy) return sendChatSupplement(sessionId, prompt, attachments);
  let releaseLaunch!: () => void;
  const launching = new Promise<void>(resolve => { releaseLaunch = resolve; });
  launches.set(sessionId, launching);
  const turnId = crypto.randomUUID();
  const goal = old.goal?.trim() ?? "";
  const goalChanged = goal !== (old.lastSentGoal ?? "") && !prompt.trimStart().startsWith("/");
  const transmittedPrompt = goalChanged ? (goal ? `Conversation objective: ${goal}\n\n${prompt.trim()}` : `The previous conversation objective has been cleared. Follow the current request.\n\n${prompt.trim()}`) : prompt.trim();
  const message: ChatMessage = { id: `${turnId}:user`, turnId, role: "user", text: prompt.trim(), at: Date.now(), attachments };
  useChatStore.getState().patch(sessionId, { busy: true, turnId, error: undefined, diagnostic: undefined, status: "starting", draft: "", messages: [...old.messages, message] });
  useSessionStore.getState().updateSession(sessionId, { status: "running", currentTask: prompt.trim(), ...(!old.messages.length ? { name: prompt.trim().slice(0, 44) || attachments[0]?.name } : {}) });
  useAgentActivityStore.getState().record(sessionId, { phase: "starting", startedAt: Date.now(), endedAt: undefined, error: undefined, command: session.runner.type === "codex" ? "codex app-server" : "claude --print", pid: undefined }, "activity.starting");
  try {
    await ensureChatEvents();
    if (!useSessionStore.getState().sessions.some(session => session.id === sessionId)) { cancelledTurns.delete(turnId); return false; }
    if (cancelledTurns.delete(turnId)) {
      useChatStore.getState().patch(sessionId, { busy: false, status: "stopped", draft: prompt });
      useSessionStore.getState().updateSession(sessionId, { status: "suspended" });
      useAgentActivityStore.getState().record(sessionId, { phase: "stopped", endedAt: Date.now() }, "activity.stopped");
      return false;
    }
    await invoke("start_chat_turn", { request: { sessionId, turnId, runnerType: session.runner.type, cliPath: session.runner.cliPath || undefined, workdir: session.worktreePath || session.workdir, projectPath: useWorkspaceStore.getState().workspaces.find(workspace => workspace.id === session.workspaceId)?.path || session.workdir, prompt: transmittedPrompt, providerSessionId: session.providerSessionId || old.providerSessionId || undefined, ...executionOptions(session.runner, session.worktreePath || session.workdir), model: session.runner.model === "default" ? undefined : session.runner.model || undefined, mode: session.runner.mode === "plan" ? "plan" : "code", attachments } });
    if (goalChanged && useChatStore.getState().threads[sessionId]?.turnId === turnId) useChatStore.getState().patch(sessionId, { lastSentGoal: goal });
    return true;
  } catch (error) {
    cancelledTurns.delete(turnId);
    useChatStore.getState().patch(sessionId, { busy: false, error: String(error), draft: prompt });
    useSessionStore.getState().updateSession(sessionId, { status: "error" });
    useAgentActivityStore.getState().record(sessionId, { phase: "error", endedAt: Date.now(), error: String(error) }, "activity.error", String(error));
    return false;
  } finally { if (launches.get(sessionId) === launching) launches.delete(sessionId); releaseLaunch(); }
}

async function sendChatSupplement(sessionId:string,prompt:string,attachments:ChatAttachment[]): Promise<boolean> {
  const old=useChatStore.getState().threads[sessionId];
  const session=useSessionStore.getState().sessions.find(s=>s.id===sessionId);
  if (!old?.busy || !old.turnId || !session) return false;
  const messageId=crypto.randomUUID();
  const message:ChatMessage={id:`${messageId}:user`,turnId:old.turnId,role:"user",text:prompt.trim(),attachments,at:Date.now(),status:"sending"};
  useChatStore.getState().patch(sessionId,{draft:"",messages:[...old.messages,message]});
  try {
    await launches.get(sessionId);
    const current=useChatStore.getState().threads[sessionId];
    if (!useSessionStore.getState().sessions.some(s=>s.id===sessionId)) return false;
    if (!current || current.turnId !== old.turnId || current.status === "stopped" || current.error || cancelledTurns.has(old.turnId)) throw new Error("The response was stopped or failed; resend the complement to continue.");
    if (!current?.busy) {
      useChatStore.getState().patch(sessionId,{messages:current.messages.filter(m=>m.id!==message.id)});
      return sendChatTurn(sessionId,prompt,attachments);
    }
    const status=await invoke<string>("steer_chat_turn",{messageId,request:{sessionId,turnId:current.turnId,runnerType:session.runner.type,cliPath:session.runner.cliPath||undefined,projectPath:useWorkspaceStore.getState().workspaces.find(workspace=>workspace.id===session.workspaceId)?.path||session.workdir,workdir:session.worktreePath||session.workdir,prompt:prompt.trim(),attachments,mode:session.runner.mode==="plan"?"plan":"code"}});
    const latest=useChatStore.getState().threads[sessionId];
    if(latest) useChatStore.getState().patch(sessionId,{messages:latest.messages.map(m=>m.id===message.id && m.status==="sending"?{...m,status:status||"queued"}:m)});
    return true;
  } catch(error) {
    const latest=useChatStore.getState().threads[sessionId];
    if(latest)useChatStore.getState().patch(sessionId,{messages:latest.messages.map(m=>m.id===message.id?{...m,status:"failed",title:String(error)}:m),draft:latest.draft||prompt});
    return false;
  }
}

export async function stopChatTurn(sessionId: string) {
  const thread = useChatStore.getState().threads[sessionId];
  if (thread?.busy && thread.turnId) cancelledTurns.add(thread.turnId);
  try { await invoke("stop_chat_turn", { sessionId }); }
  catch (error) { useChatStore.getState().patch(sessionId, { error: String(error) }); }
}

// Removing a conversation must also stop its background turn and remove its local transcript.
useSessionStore.subscribe((state, previous) => {
  if (state.sessions === previous.sessions) return;
  const current = new Set(state.sessions.map(session => session.id));
  for (const session of previous.sessions) if (!current.has(session.id)) {
    const removed = useChatStore.getState().threads[session.id];
    if (removed?.busy) { if (removed.turnId) cancelledTurns.add(removed.turnId); void invoke("stop_chat_turn", { sessionId: session.id }).catch(() => {}); }
    useChatStore.getState().remove(session.id);
  }
});
