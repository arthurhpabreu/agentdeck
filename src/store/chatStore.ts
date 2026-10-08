import { executionOptions } from "../services/agentExecution";
import { usePtyRuntimeStore } from "./ptyRuntimeStore";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSessionStore } from "./sessionStore";
import { useWorkspaceStore } from "./workspaceStore";
import { useAgentActivityStore } from "./agentActivityStore";
import { useAgentObservabilityStore } from "./agentObservabilityStore";
import { type CompactionPolicy, compactionPolicy, estimateTokens, residentMessages, shouldCompact } from "../services/chatCompaction";
import { deleteChatHistory, restoreChatHistory, saveChatHistory } from "../services/chatHistory";

export interface ChatAttachment { name: string; path: string; mimeType: string; size: number }
export interface ChatUsage { inputTokens: number; cachedInputTokens: number; outputTokens: number }
export interface ChatMessage { id: string; turnId: string; role: "user" | "assistant" | "tool"; text: string; at: number; order?: number; title?: string; status?: string; attachments?: ChatAttachment[]; parentId?: string }
export interface ChatThread { messages: ChatMessage[]; draft: string; goal?: string; lastSentGoal?: string; busy: boolean; turnId?: string; error?: string; status?: string; providerSessionId?: string; updatedAt?: number; diagnostic?: string; lastUsage?: ChatUsage; totalUsage?: ChatUsage; meteredTurns?: number; lastUsageTurnId?: string; resolvedModel?: string; nextMessageOrder?: number; archivedCount?: number; compactionPolicy?: CompactionPolicy; contextPrompts?: number; contextTokens?: number; contextTokensEstimated?: boolean; compactionCount?: number; compacting?: boolean; lastCompactionId?: string; lastCompactedAt?: number }
export interface ChatEvent { sessionId: string; turnId: string; kind: "text" | "tool" | "status" | "session" | "error" | "done" | "input" | "compaction"; text?: string; itemId?: string; title?: string; status?: string; providerSessionId?: string; delta?: boolean; pid?: number; parentId?: string; usage?: unknown; model?: string; contextTokens?: number }
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
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value && Array.isArray((value as ChatThread).messages)).map(([id, value]) => {
      const thread = value as ChatThread;
      const messages = thread.messages.map((m, i) => ({ ...m, order: m.order ?? i }));
      return [id, { ...thread, messages, compactionPolicy: compactionPolicy(thread.compactionPolicy), nextMessageOrder: thread.nextMessageOrder ?? messages.length, contextPrompts: thread.contextPrompts ?? messages.filter(m => m.role === "user" && m.status !== "failed").length, contextTokens: thread.contextTokens ?? messages.reduce((n, m) => n + estimateTokens(m.text), 0), contextTokensEstimated: thread.contextTokensEstimated ?? true, busy: false, compacting: false, turnId: undefined, status: undefined }];
    }));
  } catch { return {}; }
}
export const useChatStore = create<{
  threads: Record<string, ChatThread>; storageError: boolean; historyReady: boolean;
  patch: (id: string, patch: Partial<ChatThread>) => void;
  event: (event: ChatEvent) => void;
  remove: (id: string) => void;
}>((set) => ({
  threads: restore(), storageError: false, historyReady: false,
  patch: (id, patch) => set(s => {
    const old = s.threads[id] ?? emptyThread; let nextMessageOrder = old.nextMessageOrder ?? 0;
    const messages = patch.messages?.map(m => m.order === undefined ? { ...m, order: nextMessageOrder++ } : m);
    return { threads: { ...s.threads, [id]: { ...old, ...patch, ...(messages ? { messages, nextMessageOrder } : {}), updatedAt: Date.now() } } };
  }),
  remove: id => { removed.add(id); set(s => { const threads = { ...s.threads }; delete threads[id]; return { threads }; }); scheduleSave(); },
  event: e => set(s => {
    const old = s.threads[e.sessionId];
    if (!old || old.turnId !== e.turnId) return s;
    let next = { ...old, updatedAt: Date.now() };
    if (!e.parentId && typeof e.contextTokens === "number" && Number.isFinite(e.contextTokens) && e.contextTokens >= 0) { next.contextTokens = e.contextTokens; next.contextTokensEstimated = false; }
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
    if (e.kind === "status") {
      next.status = e.status;
      if (e.status === "compacting") next.compacting = true;
      if (e.text && e.status !== "reasoning" && old.diagnostic?.split("\n").pop() !== e.text) next.diagnostic = ((old.diagnostic ? old.diagnostic + "\n" : "") + e.text).slice(-8000);
      if (next.status === old.status && next.diagnostic === old.diagnostic && !usage && e.contextTokens === undefined && !e.model && next.compacting === old.compacting) return s;
    }
    const compactionId = e.itemId ?? `${e.turnId}:compact`;
    if (e.kind === "compaction" && !e.parentId && compactionId !== old.lastCompactionId) {
      next.compacting = false; next.lastCompactionId = compactionId; next.lastCompactedAt = Date.now(); next.compactionCount = (old.compactionCount ?? 0) + 1;
      next.contextPrompts = e.status === "before-turn" ? 1 : 0; next.contextTokens = e.status === "before-turn" ? estimateTokens(old.messages.find(m => m.id === `${e.turnId}:user`)?.text ?? "") : 0; next.contextTokensEstimated = true;
    }
    if (e.kind === "error") next.error = e.text ?? "Agent error";
    if (e.kind === "input") {
      const accepted = old.messages.find(m => m.id === `${e.itemId}:user`);
      if (e.status === "accepted" && accepted && accepted.status !== "accepted") { next.contextPrompts = (old.contextPrompts ?? 0) + 1; next.contextTokens = (old.contextTokens ?? 0) + estimateTokens(accepted.text); next.contextTokensEstimated = true; }
      next.messages = old.messages.map(m => m.id === `${e.itemId}:user` ? { ...m, status: e.status, ...(e.text ? { title: e.text } : {}) } : m);
    }
    if (e.kind === "done") next = { ...next, busy: false, compacting: false, status: e.status, draft: old.compacting && e.status !== "completed" ? old.draft || old.messages.find(m => m.id === `${e.turnId}:user`)?.text || "" : old.draft, messages: next.messages.map(m => m.role === "user" && (m.status === "sending" || m.status === "queued") ? { ...m, status: "failed" } : m) };
    if (e.kind === "text" || e.kind === "tool") {
      const id = `${e.turnId}:${e.itemId ?? e.kind}`;
      const index = old.messages.findIndex(m => m.id === id);
      const previous = old.messages[index];
      const text = e.delta ? (previous?.text ?? "") + (e.text ?? "") : e.text ?? previous?.text ?? "";
      const message: ChatMessage = { id, turnId: e.turnId, role: e.kind === "tool" ? "tool" : "assistant", at: previous?.at ?? Date.now(), order: previous?.order ?? old.nextMessageOrder ?? 0, title: e.title ?? previous?.title, status: e.status ?? previous?.status, parentId: e.parentId ?? previous?.parentId, text: text.length > 524_288 ? text.slice(0, 524_288) + "\n[output truncated]" : text };
      if (!previous) next.nextMessageOrder = (old.nextMessageOrder ?? 0) + 1;
      const added = text.slice(previous?.text.length ?? 0);
      if (added) { next.contextTokens = (next.contextTokens ?? 0) + estimateTokens(added); next.contextTokensEstimated = true; }
      next.messages = index < 0 ? [...old.messages, message] : old.messages.map((m, i) => i === index ? message : m);
    }
    return { threads: { ...s.threads, [e.sessionId]: next } };
  }),
}));

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<void> | undefined;
let canCache = false;
const dirty = new Map<string, Map<string, ChatMessage>>();
const discarded = new Map<string, Set<string>>();
const removed = new Set<string>();
function scheduleSave(delay = 1200) { if (!saveTimer && !saving && useChatStore.getState().historyReady) saveTimer = setTimeout(() => { saveTimer = undefined; void persistChatHistory(); }, delay); }
/** IndexedDB is the source of truth. localStorage holds only a small startup cache. */
function cacheRecentThreads() {
  const threads: Record<string, ChatThread> = {}; let budget = 1_000_000;
  for (const [id, thread] of Object.entries(useChatStore.getState().threads).sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0))) {
    let bytes = 0;
    const messages = thread.messages.slice(-20).filter(m => { bytes += m.text.length; return bytes <= Math.min(40_000, budget); });
    budget -= messages.reduce((n, m) => n + m.text.length, 0);
    threads[id] = { ...thread, messages, archivedCount: (thread.archivedCount ?? 0) + thread.messages.length - messages.length, diagnostic: undefined, compacting: false, busy: false };
  }
  localStorage.setItem(KEY, JSON.stringify(threads));
}
export async function persistChatHistory(): Promise<void> {
  clearTimeout(saveTimer); saveTimer = undefined;
  if (saving) { await saving; if (dirty.size || removed.size) return persistChatHistory(); return; }
  saving = (async () => {
    const batch = new Map(dirty); dirty.clear(); const drops = new Map(discarded); discarded.clear(); const deletions = [...removed]; removed.clear();
    try {
      for (const id of deletions) await deleteChatHistory(id);
      for (const [id, messages] of batch) {
        const thread = useChatStore.getState().threads[id]; if (!thread) continue;
        const total = await saveChatHistory(id, thread, [...messages.values()], [...drops.get(id) ?? []]);
        const current = useChatStore.getState().threads[id]; if (!current) { removed.add(id); continue; }
        const resident = residentMessages(current);
        if (resident.length < current.messages.length) useChatStore.getState().patch(id, { messages: resident, archivedCount: Math.max(0, total - resident.length) });
      }
      canCache = true; cacheRecentThreads(); useChatStore.setState({ storageError: false });
    } catch {
      // Do not evict or replace the legacy transcript until durable storage succeeds.
      for (const [id, messages] of batch) { const pending = dirty.get(id) ?? new Map(); for (const [key, message] of messages) if (!pending.has(key)) pending.set(key, message); dirty.set(id, pending); }
      deletions.forEach(id => removed.add(id)); useChatStore.setState({ storageError: true });
      for (const [id, messages] of drops) { const pending = discarded.get(id) ?? new Set(); messages.forEach(messageId => pending.add(messageId)); discarded.set(id, pending); }
    }
  })();
  await saving; saving = undefined;
  if (!useChatStore.getState().storageError && (dirty.size || removed.size)) scheduleSave();
}
useChatStore.subscribe((state, old) => {
  if (state.threads === old.threads) return;
  for (const [id, thread] of Object.entries(state.threads)) if (thread !== old.threads[id]) {
    const pending = dirty.get(id) ?? new Map(); const previous = new Map(old.threads[id]?.messages.map(m => [m.id, m]));
    for (const message of thread.messages) if (previous.get(message.id) !== message) pending.set(message.id, message);
    dirty.set(id, pending);
  }
  for (const id of Object.keys(old.threads)) if (!state.threads[id]) { dirty.delete(id); removed.add(id); }
  scheduleSave(Object.values(state.threads).some(thread => thread.busy) ? 3000 : 800);
});
const initialThreads = useChatStore.getState().threads;
// Retain the entire migration batch even when IndexedDB cannot open at startup.
for (const [id, thread] of Object.entries(initialThreads)) dirty.set(id, new Map(thread.messages.map(m => [m.id, m])));
export const chatHistoryReady = restoreChatHistory().then(archived => {
  const current = useChatStore.getState().threads; const threads = { ...archived, ...current };
  for (const [id, thread] of Object.entries(archived)) if (!removed.has(id)) {
    const cached = current[id];
    const merged = cached ? [...new Map([...thread.messages, ...cached.messages].map(m => [m.id, m])).values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : thread.messages;
    const lastArchivedOrder = thread.messages[thread.messages.length - 1]?.order ?? -1;
    const newlyRecovered = cached?.messages.filter(m => (m.order ?? 0) > lastArchivedOrder).length ?? 0;
    const recovered = cached && (cached.updatedAt ?? 0) > (thread.updatedAt ?? 0) ? { ...thread, ...cached, messages: merged, archivedCount: Math.max(0, (thread.archivedCount ?? 0) + thread.messages.length + newlyRecovered - merged.length), busy: false, compacting: false, turnId: undefined, status: undefined } : thread;
    threads[id] = cached && cached !== initialThreads[id] ? { ...recovered, draft: cached.draft, goal: cached.goal, compactionPolicy: cached.compactionPolicy ?? recovered.compactionPolicy } : recovered;
  }
  for (const id of removed) delete threads[id];
  useChatStore.setState({ threads, historyReady: true });
  // Migrate existing localStorage histories in full before writing a bounded cache.
  for (const [id, thread] of Object.entries(initialThreads)) if (!archived[id]) dirty.set(id, new Map(thread.messages.map(m => [m.id, m])));
  scheduleSave();
}).catch(() => { useChatStore.setState({ historyReady: true, storageError: true }); });
window.addEventListener("pagehide", () => { if (canCache) { try { cacheRecentThreads(); } catch { /* The committed archive still holds the transcript. */ } } void persistChatHistory(); });

let subscription: Promise<() => void> | undefined;
const cancelledTurns = new Set<string>();
const launches = new Map<string, Promise<void>>();
const pendingEvents = new Map<string, ChatEvent>();
const outputLengths = new Map<string, number>();
let eventTimer: ReturnType<typeof setTimeout> | undefined;
function flushChatEvents() {
  clearTimeout(eventTimer); eventTimer = undefined;
  const events = [...pendingEvents.values()]; pendingEvents.clear();
  for (const event of events) {
    const thread = useChatStore.getState().threads[event.sessionId];
    if (thread?.busy && thread.turnId === event.turnId) useChatStore.getState().event(event);
  }
}
function acceptChatEvent(e: ChatEvent) {
  if (e.kind !== "text" && e.kind !== "tool") { flushChatEvents(); useChatStore.getState().event(e); return; }
  const key = `${e.sessionId}:${e.turnId}:${e.itemId ?? e.kind}`; const previous = pendingEvents.get(key);
  pendingEvents.set(key, previous && e.delta ? { ...previous, ...e, text: (previous.text ?? "") + (e.text ?? ""), delta: previous.delta } : e);
  if (!eventTimer) eventTimer = setTimeout(flushChatEvents, 40);
}
export function ensureChatEvents() {
  if (!subscription) subscription = listen<ChatEvent>("chat-event", ({ payload: e }) => {
    if (e.kind === "status" && e.status === "started" && cancelledTurns.has(e.turnId)) void invoke("stop_chat_turn", { sessionId: e.sessionId }).catch(() => {});
    if (e.kind === "done") cancelledTurns.delete(e.turnId);
    const thread = useChatStore.getState().threads[e.sessionId];
    if (thread?.turnId !== e.turnId || !thread.busy) return;
    useAgentObservabilityStore.getState().recordChat(e);
    acceptChatEvent(e);
    const record = useAgentActivityStore.getState().record;
    if (e.kind === "session" && e.providerSessionId) useSessionStore.getState().updateSession(e.sessionId, { providerSessionId: e.providerSessionId });
    if (e.kind === "text" || e.kind === "tool") {
      const bytes = useAgentActivityStore.getState().sessions[e.sessionId]?.bytes ?? 0;
      const key = `${e.sessionId}:${e.turnId}:${e.itemId ?? e.kind}`; const text = e.text ?? "";
      const added = e.delta ? text : text.slice(outputLengths.get(key) ?? 0);
      outputLengths.set(key, e.delta ? (outputLengths.get(key) ?? 0) + text.length : text.length);
      record(e.sessionId, { phase: "running", lastOutputAt: Date.now(), bytes: bytes + new TextEncoder().encode(added).length }, e.kind === "tool" ? "activity.running" : undefined, e.title);
    }
    if (e.kind === "status") record(e.sessionId, { phase: "running", ...(e.pid ? { pid: e.pid } : {}) });
    if (e.kind === "error") record(e.sessionId, { error: e.text }, "activity.error", e.text);
    if (e.kind === "done") {
      for (const key of outputLengths.keys()) if (key.startsWith(`${e.sessionId}:${e.turnId}:`)) outputLengths.delete(key);
      cancelledTurns.delete(e.turnId);
      const current = useChatStore.getState().threads[e.sessionId];
      const phase = e.status === "stopped" ? "stopped" : current?.error || e.status === "error" ? "error" : "done";
      record(e.sessionId, { phase, endedAt: Date.now() }, `activity.${phase}`);
      useSessionStore.getState().updateSession(e.sessionId, { status: phase === "error" ? "error" : phase === "stopped" ? "suspended" : "waiting" });
      scheduleSave(250);
    }
  }).catch(error => { subscription = undefined; throw error; });
  return subscription;
}

export async function sendChatTurn(sessionId: string, prompt: string, attachments: ChatAttachment[]): Promise<boolean> {
  await chatHistoryReady;
  const session = useSessionStore.getState().sessions.find(s => s.id === sessionId);
  const old = useChatStore.getState().threads[sessionId] ?? emptyThread;
  if (!session || usePtyRuntimeStore.getState().sessions[sessionId] || (!prompt.trim() && !attachments.length)) return false;
  if (old.busy) return sendChatSupplement(sessionId, prompt, attachments);
  let releaseLaunch!: () => void;
  const launching = new Promise<void>(resolve => { releaseLaunch = resolve; });
  launches.set(sessionId, launching);
  const turnId = crypto.randomUUID();
  const providerSessionId = session.providerSessionId || old.providerSessionId || undefined;
  const compactBeforeTurn = session.runner.type !== "gemini" && shouldCompact(old, prompt, providerSessionId);
  const goal = old.goal?.trim() ?? "";
  const goalChanged = (compactBeforeTurn && !!goal || goal !== (old.lastSentGoal ?? "")) && !prompt.trimStart().startsWith("/");
  const transmittedPrompt = goalChanged ? (goal ? `Conversation objective: ${goal}\n\n${prompt.trim()}` : `The previous conversation objective has been cleared. Follow the current request.\n\n${prompt.trim()}`) : prompt.trim();
  const message: ChatMessage = { id: `${turnId}:user`, turnId, role: "user", text: prompt.trim(), at: Date.now(), attachments };
  useChatStore.getState().patch(sessionId, { busy: true, compacting: compactBeforeTurn, contextPrompts: (old.contextPrompts ?? 0) + 1, contextTokens: (old.contextTokens ?? 0) + estimateTokens(prompt), contextTokensEstimated: true, turnId, error: undefined, diagnostic: undefined, status: compactBeforeTurn ? "compacting" : "starting", draft: "", messages: [...old.messages, message] });
  useSessionStore.getState().updateSession(sessionId, { status: "running", currentTask: prompt.trim() });
  if (!old.messages.length) useSessionStore.getState().setAutomaticSessionName(sessionId, prompt.trim().slice(0, 44) || attachments[0]?.name || "");
  useAgentActivityStore.getState().record(sessionId, { phase: "starting", startedAt: Date.now(), endedAt: undefined, error: undefined, command: session.runner.type === "codex" ? "codex app-server" : "claude --print", pid: undefined }, "activity.starting");
  try {
    await ensureChatEvents();
    if (!useSessionStore.getState().sessions.some(session => session.id === sessionId)) { cancelledTurns.delete(turnId); return false; }
    if (cancelledTurns.delete(turnId)) {
      useChatStore.getState().patch(sessionId, { busy: false, compacting: false, contextPrompts: old.contextPrompts, contextTokens: old.contextTokens, status: "stopped", draft: prompt });
      useSessionStore.getState().updateSession(sessionId, { status: "suspended" });
      useAgentActivityStore.getState().record(sessionId, { phase: "stopped", endedAt: Date.now() }, "activity.stopped");
      return false;
    }
    await invoke("start_chat_turn", { request: { sessionId, turnId, runnerType: session.runner.type, cliPath: session.runner.cliPath || undefined, workdir: session.worktreePath || session.workdir, projectPath: useWorkspaceStore.getState().workspaces.find(workspace => workspace.id === session.workspaceId)?.path || session.workdir, prompt: transmittedPrompt, providerSessionId, compactBeforeTurn, ...executionOptions(session.runner, session.worktreePath || session.workdir), model: session.runner.model === "default" ? undefined : session.runner.model || undefined, mode: session.runner.mode === "plan" ? "plan" : "code", attachments } });
    if (goalChanged && useChatStore.getState().threads[sessionId]?.turnId === turnId) useChatStore.getState().patch(sessionId, { lastSentGoal: goal });
    return true;
  } catch (error) {
    cancelledTurns.delete(turnId);
    useChatStore.getState().patch(sessionId, { busy: false, compacting: false, contextPrompts: old.contextPrompts, contextTokens: old.contextTokens, contextTokensEstimated: old.contextTokensEstimated, error: String(error), draft: prompt });
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
      const drops = discarded.get(sessionId) ?? new Set(); drops.add(message.id); discarded.set(sessionId, drops);
      dirty.get(sessionId)?.delete(message.id);
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
