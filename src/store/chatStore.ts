import { executionOptions } from "../services/agentExecution";
import { createUuid } from "../services/ids";
import { usePtyRuntimeStore } from "./ptyRuntimeStore";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSessionStore, type ClaudeSession } from "./sessionStore";
import { useWorkspaceStore } from "./workspaceStore";
import { useAgentActivityStore } from "./agentActivityStore";
import { useAgentObservabilityStore } from "./agentObservabilityStore";
import { recordChatAttention } from "./attentionStore";
import { useSourceDeliveryStore } from "./sourceDeliveryStore";
import { type CompactionPolicy, restoreCompactionPolicy, estimateTokens, estimateChatInputTokens, getCompactionBudget, messageTextSize, residentMessages, shouldCompact } from "../services/chatCompaction";
import { deleteChatHistory, readChatHistoryMessage, restoreChatHistory, saveChatHistory } from "../services/chatHistory";
import { isPendingChatTool, isTerminalChatTool, mergeChatToolStatus } from "../services/chatToolState";
import { chatInputError } from "../services/chatInput";
import type { ChatInteraction } from "../services/chatInteraction";

export interface ChatAttachment { name: string; path: string; mimeType: string; size: number }
export interface ChatUsage { inputTokens: number; cachedInputTokens: number; outputTokens: number }
export interface ChatContinuation { sourceSessionId: string; sourceSessionName: string; archivePath: string; messageCount: number; createdAt: number; reviewedContext?: boolean }
export interface ChatMessage { id: string; turnId: string; role: "user" | "assistant" | "tool"; text: string; at: number; order?: number; title?: string; status?: string; attachments?: ChatAttachment[]; parentId?: string; command?: string; output?: string; cwd?: string; exitCode?: number; elapsedSeconds?: number; origin?: "team" }
export interface ChatThread { interactions?: ChatInteraction[]; messages: ChatMessage[]; draft: string; goal?: string; lastSentGoal?: string; busy: boolean; turnId?: string; error?: string; inputError?: string; status?: string; providerSessionId?: string; updatedAt?: number; diagnostic?: string; lastUsage?: ChatUsage; totalUsage?: ChatUsage; meteredTurns?: number; lastUsageTurnId?: string; resolvedModel?: string; nextMessageOrder?: number; archivedCount?: number; compactionPolicy?: CompactionPolicy; contextPrompts?: number; contextTokens?: number; contextTokensEstimated?: boolean; contextWindow?: number; turnInputTokens?: number; compactionCount?: number; compacting?: boolean; lastCompactionId?: string; lastCompactedAt?: number; turnStartedAt?: number; lastEventAt?: number; lastHeartbeatAt?: number; activity?: string; pid?: number; mcpAuthWarning?: string; mcpAuthWarningUntil?: number; recoveryNotice?: string; recoveryRequired?: boolean; continuation?: ChatContinuation; historyRestored?: boolean; recoveryKind?: "provider-resumed"; stopRequested?: boolean }
export interface ChatEvent { interaction?: ChatInteraction; sessionId: string; turnId: string; kind: "interaction" | "text" | "tool" | "status" | "session" | "error" | "done" | "input" | "compaction" | "heartbeat"; text?: string; itemId?: string; title?: string; status?: string; providerSessionId?: string; delta?: boolean; pid?: number; parentId?: string; usage?: unknown; model?: string; contextTokens?: number; contextWindow?: number; command?: string; output?: string; cwd?: string; exitCode?: number; elapsedSeconds?: number }
export interface ChatTurnStatus { turnId?: string; running: boolean; pid?: number; status?: string; lastEventAt?: number; interactions?: ChatInteraction[] }
interface BufferedChatEvent extends ChatEvent { textDelta?: boolean; outputDelta?: boolean; receivedAt?: number }
const MESSAGE_TEXT_LIMIT = 524_288;
const MCP_AUTH_WARNING_TTL = 8_000;
// Runtime deduplication survives dismissals and tab switches, but never a reload.
const mcpWarningsBySession = new Map<string, { turnId: string; texts: Set<string> }>();
function boundedText(value: string): string { return value.length > MESSAGE_TEXT_LIMIT ? value.slice(0, MESSAGE_TEXT_LIMIT) + "\n[output truncated]" : value; }
function boundedOutput(value: string): string { return value.length > MESSAGE_TEXT_LIMIT ? "[earlier output truncated]\n" + value.slice(-MESSAGE_TEXT_LIMIT) : value; }
function chatMessageId(e: ChatEvent): string { return `${e.turnId}:${e.parentId ? `${e.parentId}:` : ""}${e.kind}:${e.itemId ?? e.kind}`; }
function restoreMessage(message: ChatMessage): ChatMessage {
  if (message.role === "user" && (message.status === "sending" || message.status === "queued")) return { ...message, status: "failed" };
  if (message.role === "tool" && ["running", "inProgress", "in_progress", "pending"].includes(message.status ?? "")) return { ...message, status: "interrupted" };
  return message;
}
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
      const messages = thread.messages.map((m, i) => restoreMessage({ ...m, order: m.order ?? i }));
      return [id, { ...thread, messages, compactionPolicy: restoreCompactionPolicy(thread.compactionPolicy), nextMessageOrder: thread.nextMessageOrder ?? messages.length, contextPrompts: thread.contextPrompts ?? messages.filter(m => m.role === "user" && m.status !== "failed").length, contextTokens: thread.contextTokens ?? messages.reduce((n, m) => n + (m.parentId ? 0 : estimateTokens(m.text + (m.output ?? "") + (m.command ?? ""))), 0), contextTokensEstimated: thread.contextTokensEstimated ?? true, busy: false, interactions: undefined, compacting: false, turnId: undefined, status: undefined, mcpAuthWarning: undefined, mcpAuthWarningUntil: undefined }];
    }));
  } catch { return {}; }
}
export const useChatStore = create<{
  threads: Record<string, ChatThread>; storageError: boolean; historyReady: boolean;
  patch: (id: string, patch: Partial<ChatThread>) => void;
  event: (event: ChatEvent) => void;
  events: (events: ChatEvent[]) => void;
  remove: (id: string) => void;
}>((set, get) => ({
  threads: restore(), storageError: false, historyReady: false,
  patch: (id, patch) => set(s => {
    const old = s.threads[id] ?? emptyThread; let nextMessageOrder = old.nextMessageOrder ?? 0;
    const messages = patch.messages?.map(m => { if (m.order === undefined) return { ...m, order: nextMessageOrder++ }; nextMessageOrder = Math.max(nextMessageOrder, m.order + 1); return m; });
    return { threads: { ...s.threads, [id]: { ...old, ...patch, ...(messages ? { messages, nextMessageOrder } : {}), updatedAt: Date.now() } } };
  }),
  remove: id => { removed.add(id); mcpWarningsBySession.delete(id); set(s => { const threads = { ...s.threads }; delete threads[id]; return { threads }; }); scheduleSave(); },
  event: e => get().events([e]),
  events: events => set(s => {
    let threads = s.threads;
    for (const event of events) {
    const e = event as BufferedChatEvent;
    const old = threads[e.sessionId];
    if (!old?.busy || old.turnId !== e.turnId) continue;
    const at = e.receivedAt ?? Date.now();
    const connectionNotice = e.kind === "status" && !e.parentId && (e.status === "mcp-auth-warning" || e.status === "reconnecting");
    const passiveDiagnostic = e.kind === "status" && !e.parentId && e.status === "diagnostic";
    let next = e.kind === "heartbeat" ? { ...old, lastHeartbeatAt: at, ...(e.pid ? { pid: e.pid } : {}) } : { ...old, updatedAt: at, ...(connectionNotice || passiveDiagnostic ? {} : { lastEventAt: at }), ...(e.pid ? { pid: e.pid } : {}) };
    if (e.kind === "interaction") {
      next.interactions = e.status === "resolved" ? old.interactions?.filter(request => request.id !== e.itemId)
        : e.interaction && !old.interactions?.some(request => request.id === e.interaction!.id) ? [...old.interactions ?? [], e.interaction] : old.interactions;
    }
    if (e.kind === "heartbeat") {
      if (threads === s.threads) threads = { ...threads };
      threads[e.sessionId] = next;
      continue;
    }
    if (!e.parentId && (e.kind === "text" || e.kind === "tool" || e.kind === "done" || e.kind === "status" && ["running", "started", "finishing"].includes(e.status ?? ""))) next.recoveryNotice = undefined;
    const measuredContext = !e.parentId && typeof e.contextTokens === "number" && Number.isFinite(e.contextTokens) && e.contextTokens >= 0;
    if (measuredContext) { next.contextTokens = e.contextTokens; next.contextTokensEstimated = false; }
    if (!e.parentId && typeof e.contextWindow === "number" && Number.isFinite(e.contextWindow) && e.contextWindow > 0) next.contextWindow = e.contextWindow;
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
    if (e.kind === "session") { next.providerSessionId = e.providerSessionId; if (old.providerSessionId && old.providerSessionId === e.providerSessionId) next.recoveryKind = "provider-resumed"; }
    if (connectionNotice) {
      if (e.status === "mcp-auth-warning") {
        if (e.text?.trim()) {
          let seen = mcpWarningsBySession.get(e.sessionId);
          if (!seen || seen.turnId !== e.turnId) { seen = { turnId: e.turnId, texts: new Set() }; mcpWarningsBySession.set(e.sessionId, seen); }
          const text = e.text.trim();
          if (!seen.texts.has(text)) { seen.texts.add(text); next.mcpAuthWarning = text; next.mcpAuthWarningUntil = at + MCP_AUTH_WARNING_TTL; }
        }
      }
      else next.recoveryNotice = e.text ?? old.recoveryNotice;
    }
    if (passiveDiagnostic && e.text && old.diagnostic?.split("\n").pop() !== e.text) next.diagnostic = ((old.diagnostic ? old.diagnostic + "\n" : "") + e.text).slice(-8000);
    if (e.kind === "status" && !e.parentId && !connectionNotice && !passiveDiagnostic) {
      next.status = e.status ?? old.status;
      if (old.status === "waiting-background" && e.status && e.status !== old.status) next.activity = undefined;
      if (e.text && e.status !== "reasoning") next.activity = e.text.slice(0, 240);
      if (e.status === "compacting") next.compacting = true;
      if (e.text && e.status !== "reasoning" && old.diagnostic?.split("\n").pop() !== e.text) next.diagnostic = ((old.diagnostic ? old.diagnostic + "\n" : "") + e.text).slice(-8000);
      if (next.status === old.status && next.diagnostic === old.diagnostic && !usage && e.contextTokens === undefined && e.contextWindow === undefined && !e.model && next.compacting === old.compacting && at - (old.lastEventAt ?? 0) < 1000) continue;
    }
    const compactionId = e.itemId ?? `${e.turnId}:compact`;
    if (e.kind === "compaction" && !e.parentId && compactionId !== old.lastCompactionId) {
      next.compacting = false; next.lastCompactionId = compactionId; next.lastCompactedAt = Date.now(); next.compactionCount = (old.compactionCount ?? 0) + 1;
      next.contextPrompts = e.status === "before-turn" ? 1 : 0;
      // Native compaction measurements include the retained summary. Keep them;
      // zero is only a fallback when the provider has not reported the new size.
      if (!measuredContext) {
        next.contextTokens = e.status === "before-turn" ? old.turnInputTokens ?? estimateChatInputTokens(old.messages.find(m => m.id === `${e.turnId}:user`)?.text ?? "", old.messages.find(m => m.id === `${e.turnId}:user`)?.attachments) : 0;
        next.contextTokensEstimated = true;
      }
    }
    if (e.kind === "error") { next.error = e.text ?? "Agent error"; if (e.status === "recovery-required") next.recoveryRequired = true; }
    if (e.kind === "input") {
      const accepted = old.messages.find(m => m.id === `${e.itemId}:user`);
      if (e.status === "failed" && accepted && accepted.origin !== "team") { next.inputError = e.text || "The provider did not confirm this additional input. Review the conversation before sending it again."; next.draft = old.draft || accepted.text; }
      if (e.status === "accepted" && accepted && accepted.status !== "accepted" && accepted.id !== `${e.turnId}:user`) { next.contextPrompts = (old.contextPrompts ?? 0) + 1; if (!measuredContext) { next.contextTokens = (old.contextTokens ?? 0) + estimateChatInputTokens(accepted.text, accepted.attachments); next.contextTokensEstimated = true; } }
      next.messages = old.messages.map(m => m.id === `${e.itemId}:user` ? { ...m, status: e.status, ...(e.text ? { title: e.text } : {}) } : m);
    }
    if (e.kind === "done") {
      const unconfirmed = [...next.messages].reverse().find(m => m.turnId === e.turnId && m.role === "user" && m.origin !== "team" && (m.status === "sending" || m.status === "queued"));
      const compactDraft = old.compacting && e.status !== "completed" ? old.messages.find(m => m.id === `${e.turnId}:user` && m.origin !== "team")?.text : undefined;
      next = { ...next, busy: false, interactions: undefined, compacting: false, stopRequested: undefined, status: e.status, activity: undefined, error: next.error || (e.status === "error" ? "Agent process ended with an error." : undefined), inputError: next.inputError || (unconfirmed ? "The provider did not confirm this additional input. Review the conversation before sending it again." : undefined), draft: old.draft || unconfirmed?.text || compactDraft || "", messages: next.messages.map(m => m.turnId === e.turnId && m.role === "user" && (m.status === "sending" || m.status === "queued") ? { ...m, status: "failed" } : m.turnId === e.turnId && m.role === "tool" && isPendingChatTool(m.status) ? { ...m, status: e.status === "completed" ? "completed" : "interrupted" } : m) };
    }
    if (e.kind === "text" || e.kind === "tool") {
      const id = chatMessageId(e);
      const index = old.messages.findIndex(m => m.id === id);
      const previous = old.messages[index];
      const progressReplay = e.kind === "tool" && isTerminalChatTool(previous?.status) && isPendingChatTool(e.status);
      const text = e.text === undefined ? previous?.text ?? "" : (e.textDelta ?? (e.delta && e.output === undefined)) ? (previous?.text ?? "") + e.text : e.text;
      const output = e.output === undefined ? previous?.output : (e.outputDelta ?? e.delta) ? (previous?.output ?? "") + e.output : e.output;
      const message: ChatMessage = { id, turnId: e.turnId, role: e.kind === "tool" ? "tool" : "assistant", at: previous?.at ?? at, order: previous?.order ?? old.nextMessageOrder ?? 0, title: e.title ?? previous?.title, status: e.kind === "tool" ? mergeChatToolStatus(previous?.status, e.status) : e.status ?? previous?.status, parentId: e.parentId ?? previous?.parentId, command: e.command ?? previous?.command, output: output === undefined ? undefined : boundedOutput(output), cwd: e.cwd ?? previous?.cwd, exitCode: e.exitCode ?? previous?.exitCode, elapsedSeconds: e.elapsedSeconds ?? previous?.elapsedSeconds, text: boundedText(text) };
      if (!previous) next.nextMessageOrder = (old.nextMessageOrder ?? 0) + 1;
      const added = e.output !== undefined ? e.outputDelta ?? e.delta ? e.output : e.output.slice(previous?.output?.length ?? 0) : e.text !== undefined ? e.textDelta ?? e.delta ? e.text : e.text.slice(previous?.text.length ?? 0) : "";
      if (added && !message.parentId && !measuredContext) { next.contextTokens = (next.contextTokens ?? 0) + estimateTokens(added); next.contextTokensEstimated = true; }
      if (!e.parentId && !progressReplay) {
        if (e.kind === "tool") { next.activity = (message.command || message.title || message.text).slice(0, 240); next.status = message.status === "blocked" ? "blocked" : "tool"; }
        else { next.status = "responding"; next.activity = undefined; }
      }
      next.messages = index < 0 ? [...old.messages, message] : old.messages.map((m, i) => i === index ? message : m);
    }
    if (threads === s.threads) threads = { ...threads };
    threads[e.sessionId] = next;
    }
    return threads === s.threads ? s : { threads };
  }),
}));

/** An expired or dismissed notice must not clear a newer real authentication error. */
export function dismissMcpAuthWarning(sessionId: string, deadline: number) {
  const store = useChatStore.getState();
  if (store.threads[sessionId]?.mcpAuthWarningUntil === deadline) store.patch(sessionId, { mcpAuthWarning: undefined, mcpAuthWarningUntil: undefined });
}

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
    const messages = thread.messages.slice(-20).filter(m => { bytes += messageTextSize(m); return bytes <= Math.min(40_000, budget); });
    budget -= messages.reduce((n, m) => n + messageTextSize(m), 0);
    threads[id] = { ...thread, messages, archivedCount: (thread.archivedCount ?? 0) + thread.messages.length - messages.length, diagnostic: undefined, interactions: undefined, compacting: false, busy: false, mcpAuthWarning: undefined, mcpAuthWarningUntil: undefined };
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
        const keep = new Set(residentMessages(current).map(m => m.id));
        // Output arriving during the transaction still belongs to the next save batch.
        const pending = dirty.get(id);
        const resident = current.messages.filter(m => keep.has(m.id) || pending?.has(m.id));
        if (resident.length < current.messages.length) {
          const retained = new Set(resident.map(m => m.id));
          const evicted = evictedActiveMessages.get(id) ?? new Set<string>();
          for (const message of current.messages) if (current.busy && message.turnId === current.turnId && !retained.has(message.id)) evicted.add(message.id);
          if (evicted.size) evictedActiveMessages.set(id, evicted);
          useChatStore.getState().patch(id, { messages: resident, archivedCount: Math.max(0, total - resident.length) });
        }
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
    const before = old.threads[id];
    const waiting = !!thread.interactions?.some(request => request.blocking);
    if (thread.busy && waiting !== !!before?.interactions?.some(request => request.blocking)) {
      const phase = waiting ? "waiting" : "running";
      useSessionStore.getState().updateSession(id, { status: phase });
      useAgentActivityStore.getState().record(id, { phase });
    }
    if (before && !Object.keys(thread).some(key => !["updatedAt", "lastEventAt", "lastHeartbeatAt", "pid", "status", "activity", "diagnostic", "recoveryNotice", "interactions", "stopRequested"].includes(key) && thread[key as keyof ChatThread] !== before[key as keyof ChatThread])) continue;
    const pending = dirty.get(id) ?? new Map();
    if (thread.messages !== before?.messages) {
      const previous = new Map(before?.messages.map(m => [m.id, m]));
      for (const message of thread.messages) if (previous.get(message.id) !== message) pending.set(message.id, message);
    }
    dirty.set(id, pending);
  }
  for (const id of Object.keys(old.threads)) if (!state.threads[id]) { dirty.delete(id); removed.add(id); }
  if (dirty.size || removed.size) scheduleSave(Object.values(state.threads).some(thread => thread.busy) ? 3000 : 800);
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
    const recovered = cached && (cached.updatedAt ?? 0) > (thread.updatedAt ?? 0) ? { ...thread, ...cached, messages: merged, archivedCount: Math.max(0, (thread.archivedCount ?? 0) + thread.messages.length + newlyRecovered - merged.length), busy: false, interactions: undefined, compacting: false, turnId: undefined, status: undefined } : thread;
    threads[id] = cached && cached !== initialThreads[id] ? { ...recovered, draft: cached.draft, goal: cached.goal, compactionPolicy: cached.compactionPolicy ?? recovered.compactionPolicy } : recovered;
  }
  for (const id of removed) delete threads[id];
  for (const [id, thread] of Object.entries(threads)) if (thread.messages.length || thread.archivedCount) threads[id] = { ...thread, historyRestored: true };
  useChatStore.setState({ threads, historyReady: true });
  // Migrate existing localStorage histories in full before writing a bounded cache.
  for (const [id, thread] of Object.entries(initialThreads)) if (!archived[id]) dirty.set(id, new Map(thread.messages.map(m => [m.id, m])));
  scheduleSave();
}).catch(() => { useChatStore.setState({ historyReady: true, storageError: true }); });
window.addEventListener("pagehide", () => { if (canCache) { try { cacheRecentThreads(); } catch { /* The committed archive still holds the transcript. */ } } void persistChatHistory(); });

let subscription: Promise<() => void> | undefined;
const cancelledTurns = new Set<string>();
const launches = new Map<string, Promise<void>>();
const pendingEvents = new Map<string, BufferedChatEvent>();
const outputLengths = new Map<string, number>();
const evictedActiveMessages = new Map<string, Set<string>>();
const deferredEvents = new Map<string, BufferedChatEvent[]>();
let eventTimer: ReturnType<typeof setTimeout> | undefined;
function flushChatEvents() {
  clearTimeout(eventTimer); eventTimer = undefined;
  const events = [...pendingEvents.values()]; pendingEvents.clear();
  processChatEvents(events);
}
function acceptChatEvent(e: ChatEvent) {
  const receivedAt = (e as BufferedChatEvent).receivedAt ?? Date.now();
  if (e.kind !== "text" && e.kind !== "tool" && !(e.kind === "status" && e.status === "reasoning")) { flushChatEvents(); processChatEvents([{ ...e, receivedAt }]); return; }
  const key = `${e.sessionId}:${e.turnId}:${e.kind}:${e.parentId ?? ""}:${e.itemId ?? e.kind}`; const previous = pendingEvents.get(key);
  const defined = Object.fromEntries(Object.entries(e).filter(([, value]) => value !== undefined));
  const merged: BufferedChatEvent = { ...previous, ...defined, sessionId: e.sessionId, turnId: e.turnId, kind: e.kind, receivedAt };
  if (e.kind === "tool") merged.status = mergeChatToolStatus(previous?.status, e.status);
  if (e.text !== undefined) {
    const delta = !!e.delta && e.output === undefined;
    merged.text = boundedText(delta ? (previous?.text ?? "") + e.text : e.text);
    merged.textDelta = previous?.text !== undefined && delta ? previous.textDelta : delta;
  } else { merged.text = previous?.text; merged.textDelta = previous?.textDelta; }
  if (e.output !== undefined) {
    merged.output = boundedOutput(e.delta ? (previous?.output ?? "") + e.output : e.output);
    merged.outputDelta = previous?.output !== undefined && e.delta ? previous.outputDelta : !!e.delta;
  } else { merged.output = previous?.output; merged.outputDelta = previous?.outputDelta; }
  // Preserve the order of the latest activity when interleaved items are coalesced.
  pendingEvents.delete(key);
  pendingEvents.set(key, merged);
  if (!eventTimer) eventTimer = setTimeout(flushChatEvents, 40);
}
function enqueueChatEvent(incoming: BufferedChatEvent) {
  const e = incoming.receivedAt === undefined ? { ...incoming, receivedAt: Date.now() } : incoming;
  const waiting = deferredEvents.get(e.sessionId);
  if (waiting) { waiting.push(e); return; }
  const id = chatMessageId(e);
  if ((e.kind !== "text" && e.kind !== "tool") || !evictedActiveMessages.get(e.sessionId)?.has(id)) { acceptChatEvent(e); return; }
  flushChatEvents();
  const queued: BufferedChatEvent[] = [e]; deferredEvents.set(e.sessionId, queued);
  void readChatHistoryMessage(e.sessionId, id).then(message => {
    const current = useChatStore.getState().threads[e.sessionId];
    if (message && current?.busy && current.turnId === e.turnId && !current.messages.some(m => m.id === id)) {
      useChatStore.getState().patch(e.sessionId, { messages: [...current.messages, message].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)), archivedCount: Math.max(0, (current.archivedCount ?? 0) - 1) });
    }
    evictedActiveMessages.get(e.sessionId)?.delete(id);
    deferredEvents.delete(e.sessionId);
    for (const event of queued) enqueueChatEvent(event);
    // Apply the recovered item before another archive transaction can evict it again.
    flushChatEvents();
  }).catch(error => {
    deferredEvents.delete(e.sessionId);
    useChatStore.setState({ storageError: true });
    const current = useChatStore.getState().threads[e.sessionId];
    if (current?.busy && current.turnId === e.turnId) useChatStore.getState().patch(e.sessionId, { diagnostic: `${current.diagnostic ?? ""}\n${String(error)}`.slice(-8000) });
    // Preserve the committed item rather than replacing it with an incomplete delta.
    for (const event of queued) if (event.kind !== "text" && event.kind !== "tool") enqueueChatEvent(event);
  });
}
/** Apply one frame of streaming output before notifying React and the activity panels. */
function processChatEvents(events: BufferedChatEvent[]) {
  const state = useChatStore.getState();
  const accepted = events.filter(e => state.threads[e.sessionId]?.busy && state.threads[e.sessionId]?.turnId === e.turnId);
  if (!accepted.length) return;
  state.events(accepted);
  const outputActivity = new Map<string, { bytes: number; at: number; title?: string }>();
  const record = useAgentActivityStore.getState().record;
  for (const e of accepted) {
    recordChatAttention(e, !!useChatStore.getState().threads[e.sessionId]?.error);
    useAgentObservabilityStore.getState().recordChat(e);
    if (e.kind === "session" && e.providerSessionId) {
      useSourceDeliveryStore.getState().bindProvider(e.sessionId, e.providerSessionId);
      useSessionStore.getState().updateSession(e.sessionId, { providerSessionId: e.providerSessionId });
    }
    if (e.kind === "text" || e.kind === "tool") {
      const key = `${e.sessionId}:${e.turnId}:${e.kind}:${e.parentId ?? ""}:${e.itemId ?? e.kind}`;
      const value = e.output ?? e.text ?? "";
      const delta = e.output !== undefined ? e.outputDelta ?? e.delta : e.textDelta ?? e.delta;
      const added = delta ? value : value.slice(outputLengths.get(key) ?? 0);
      outputLengths.set(key, delta ? (outputLengths.get(key) ?? 0) + value.length : value.length);
      const pending = outputActivity.get(e.sessionId);
      outputActivity.set(e.sessionId, { bytes: (pending?.bytes ?? 0) + new TextEncoder().encode(added).length, at: e.receivedAt ?? Date.now(), title: e.kind === "tool" ? e.command || e.title : pending?.title });
    }
    if (e.kind === "status") record(e.sessionId, { phase: useChatStore.getState().threads[e.sessionId]?.interactions?.some(request => request.blocking) ? "waiting" : "running", ...(e.pid ? { pid: e.pid } : {}) });
    if (e.kind === "error") record(e.sessionId, { error: e.text }, "activity.error", e.text);
    if (e.kind === "done") {
      for (const key of outputLengths.keys()) if (key.startsWith(`${e.sessionId}:${e.turnId}:`)) outputLengths.delete(key);
      cancelledTurns.delete(e.turnId);
      evictedActiveMessages.delete(e.sessionId);
      const current = useChatStore.getState().threads[e.sessionId];
      const phase = e.status === "stopped" || e.status === "interrupted" ? "stopped" : current?.error || e.status === "error" ? "error" : "done";
      record(e.sessionId, { phase, endedAt: Date.now() }, `activity.${phase}`);
      // A finished turn is done, not "waiting": that status means the user is needed.
      useSessionStore.getState().updateSession(e.sessionId, { status: phase === "error" ? "error" : phase === "stopped" ? "suspended" : "done" });
      scheduleSave(250);
    }
  }
  for (const [id, pending] of outputActivity) {
    const bytes = useAgentActivityStore.getState().sessions[id]?.bytes ?? 0;
    const busy = useChatStore.getState().threads[id]?.busy;
    const phase = useChatStore.getState().threads[id]?.interactions?.some(request => request.blocking) ? "waiting" as const : "running" as const;
    record(id, { ...(busy ? { phase } : {}), bytes: bytes + pending.bytes, lastOutputAt: pending.at }, busy && pending.title ? "activity.running" : undefined, pending.title);
  }
}
export function ensureChatEvents() {
  if (!subscription) subscription = listen<ChatEvent>("chat-event", ({ payload: e }) => {
    if (e.kind === "status" && e.status === "started" && cancelledTurns.has(e.turnId)) void invoke("stop_chat_turn", { sessionId: e.sessionId }).catch(() => {});
    if (e.kind === "done") cancelledTurns.delete(e.turnId);
    const thread = useChatStore.getState().threads[e.sessionId];
    if (thread?.turnId !== e.turnId || !thread.busy) return;
    enqueueChatEvent(e);
  }).catch(error => { subscription = undefined; throw error; });
  return subscription;
}
export function chatSessionIdentity(session: ClaudeSession): string {
  return JSON.stringify([session.workspaceId, session.workdir, session.worktreePath, session.runner, session.providerSessionId || useChatStore.getState().threads[session.id]?.providerSessionId]);
}
function waitCoordinationReceipt(sessionId: string, messageId: string): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    let unsubscribe = () => {};
    const finish = (accepted: boolean) => { if (done) return; done = true; clearTimeout(timeout); unsubscribe(); resolve(accepted); };
    const check = () => {
      const thread = useChatStore.getState().threads[sessionId];
      const message = thread?.messages.find(item => item.id === messageId);
      if (message?.status === "accepted") finish(true);
      else if (!thread?.busy || !message || message.status === "failed" || thread.error) finish(false);
    };
    const timeout = setTimeout(() => finish(false), 120_000);
    unsubscribe = useChatStore.subscribe(check);
    check();
  });
}
/** Native error when input arrives after the provider closed the turn's input stream. */
const TURN_ENDED = "This response has already ended";
/** Resolves true only when this turn ends successfully; stops, failures and new turns resolve false. */
function waitTurnCompleted(sessionId: string, turnId: string): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    let unsubscribe = () => {};
    const finish = (completed: boolean) => { if (done) return; done = true; clearTimeout(timeout); unsubscribe(); resolve(completed); };
    const check = () => {
      const thread = useChatStore.getState().threads[sessionId];
      if (!thread || thread.turnId !== turnId) finish(false);
      else if (!thread.busy) finish(thread.status === "completed" && !thread.error);
    };
    const timeout = setTimeout(() => finish(false), 30_000);
    unsubscribe = useChatStore.subscribe(check);
    check();
  });
}
export async function sendChatTurn(sessionId: string, prompt: string, attachments: ChatAttachment[], options?: { preserveDraft?: boolean; coordination?: boolean; expectedIdentity?: string; requireIdle?: boolean }): Promise<boolean> {
  await chatHistoryReady;
  const session = useSessionStore.getState().sessions.find(s => s.id === sessionId);
  const old = useChatStore.getState().threads[sessionId] ?? emptyThread;
  if (!session || usePtyRuntimeStore.getState().sessions[sessionId] || (!prompt.trim() && !attachments.length)) return false;
  if (options?.expectedIdentity && chatSessionIdentity(session) !== options.expectedIdentity) return false;
  if (old.busy && options?.requireIdle) return false;
  if (old.busy) return sendChatSupplement(sessionId, prompt, attachments, options);
  const providerSessionId = session.providerSessionId || old.providerSessionId || undefined;
  const goal = old.goal?.trim() ?? "";
  const nativeCommand = prompt.trimStart().startsWith("/");
  const withGoal = () => goal ? `Conversation objective: ${goal}\n\n${prompt.trim()}` : `The previous conversation objective has been cleared. Follow the current request.\n\n${prompt.trim()}`;
  let goalChanged = goal !== (old.lastSentGoal ?? "") && !nativeCommand;
  let transmittedPrompt = goalChanged ? withGoal() : prompt.trim();
  const compactBeforeTurn = !options?.coordination && session.runner.type !== "gemini" && shouldCompact(old, transmittedPrompt, providerSessionId, attachments);
  if (compactBeforeTurn && goal && !nativeCommand) { goalChanged = true; transmittedPrompt = withGoal(); }
  const budget = getCompactionBudget(old, transmittedPrompt, attachments);
  const inputError = chatInputError(transmittedPrompt);
  if (inputError) {
    useChatStore.getState().patch(sessionId, { inputError, draft: options?.preserveDraft && old.draft ? old.draft : prompt });
    return false;
  }
  let releaseLaunch!: () => void;
  const launching = new Promise<void>(resolve => { releaseLaunch = resolve; });
  launches.set(sessionId, launching);
  const turnId = createUuid();
  const message: ChatMessage = { id: `${turnId}:user`, turnId, role: "user", text: prompt.trim(), at: Date.now(), attachments, ...(options?.coordination ? { origin: "team" as const, status: "sending" } : {}) };
  useSourceDeliveryStore.getState().start(sessionId, { hasHistory: !!(old.messages.length || old.archivedCount || old.continuation), providerSessionId });
  useChatStore.getState().patch(sessionId, { busy: true, interactions: undefined, providerSessionId, compacting: compactBeforeTurn, contextPrompts: (old.contextPrompts ?? 0) + 1, contextTokens: budget.projectedTokens, contextTokensEstimated: true, turnInputTokens: budget.promptTokens, turnId, turnStartedAt: message.at, lastEventAt: undefined, lastHeartbeatAt: undefined, pid: undefined, activity: undefined, error: undefined, inputError: undefined, diagnostic: undefined, mcpAuthWarning: undefined, mcpAuthWarningUntil: undefined, recoveryNotice: undefined, recoveryRequired: false, stopRequested: undefined, status: compactBeforeTurn ? "compacting" : "starting", draft: options?.preserveDraft ? old.draft : "", messages: [...old.messages, message] });
  useSessionStore.getState().updateSession(sessionId, { status: "running", ...(!options?.coordination ? { currentTask: prompt.trim() } : {}) });
  if (!old.messages.length && !options?.coordination) useSessionStore.getState().setAutomaticSessionName(sessionId, prompt.trim().slice(0, 44) || attachments[0]?.name || "");
  useAgentActivityStore.getState().record(sessionId, { phase: "starting", startedAt: Date.now(), endedAt: undefined, error: undefined, command: session.runner.type === "codex" ? "codex app-server" : "claude --print", pid: undefined }, "activity.starting");
  try {
    await ensureChatEvents();
    if (!useSessionStore.getState().sessions.some(session => session.id === sessionId)) { cancelledTurns.delete(turnId); return false; }
    if (useChatStore.getState().threads[sessionId]?.turnId !== turnId) { cancelledTurns.delete(turnId); return false; }
    if (cancelledTurns.delete(turnId)) {
      useChatStore.getState().patch(sessionId, { busy: false, compacting: false, contextPrompts: old.contextPrompts, contextTokens: old.contextTokens, status: "stopped", draft: useChatStore.getState().threads[sessionId]?.draft || (options?.coordination ? "" : prompt) });
      useSessionStore.getState().updateSession(sessionId, { status: "suspended" });
      useAgentActivityStore.getState().record(sessionId, { phase: "stopped", endedAt: Date.now() }, "activity.stopped");
      return false;
    }
    await invoke("start_chat_turn", { request: { sessionId, turnId, runnerType: session.runner.type, cliPath: session.runner.cliPath || undefined, workdir: session.worktreePath || session.workdir, projectPath: useWorkspaceStore.getState().workspaces.find(workspace => workspace.id === session.workspaceId)?.path || session.workdir, prompt: transmittedPrompt, providerSessionId, compactBeforeTurn, coordination: options?.coordination === true, ...executionOptions(session.runner, session.worktreePath || session.workdir), model: session.runner.model === "default" ? undefined : session.runner.model || undefined, mode: session.runner.mode === "plan" ? "plan" : "code", attachments } });
    if (goalChanged && useChatStore.getState().threads[sessionId]?.turnId === turnId) useChatStore.getState().patch(sessionId, { lastSentGoal: goal });
    return options?.coordination ? await waitCoordinationReceipt(sessionId, message.id) : true;
  } catch (error) {
    cancelledTurns.delete(turnId);
    if (useChatStore.getState().threads[sessionId]?.turnId !== turnId) return false;
    recordChatAttention({ sessionId, turnId, kind: "error", text: String(error) });
    useChatStore.getState().patch(sessionId, { busy: false, compacting: false, contextPrompts: old.contextPrompts, contextTokens: old.contextTokens, contextTokensEstimated: old.contextTokensEstimated, error: String(error), draft: useChatStore.getState().threads[sessionId]?.draft || (options?.coordination ? "" : prompt) });
    useSessionStore.getState().updateSession(sessionId, { status: "error" });
    useAgentActivityStore.getState().record(sessionId, { phase: "error", endedAt: Date.now(), error: String(error) }, "activity.error", String(error));
    return false;
  } finally { if (launches.get(sessionId) === launching) launches.delete(sessionId); releaseLaunch(); }
}

async function sendChatSupplement(sessionId:string,prompt:string,attachments:ChatAttachment[],options?:{preserveDraft?:boolean;coordination?:boolean;expectedIdentity?:string}): Promise<boolean> {
  const old=useChatStore.getState().threads[sessionId];
  const session=useSessionStore.getState().sessions.find(s=>s.id===sessionId);
  if (!old?.busy || !old.turnId || !session) return false;
  const inputError = chatInputError(prompt.trim());
  if (inputError) {
    if (!options?.coordination) useChatStore.getState().patch(sessionId, { inputError, draft: prompt });
    return false;
  }
  const messageId=createUuid();
  const message:ChatMessage={id:`${messageId}:user`,turnId:old.turnId,role:"user",text:prompt.trim(),attachments,at:Date.now(),status:"sending",...(options?.coordination?{origin:"team" as const}:{})};
  useChatStore.getState().patch(sessionId,{draft:options?.preserveDraft?old.draft:"",inputError:undefined,messages:[...old.messages,message]});
  // The turn ended before delivery: send the message as the next turn. The end of the turn
  // restores an unconfirmed message into the draft; drop that copy, keep anything typed since.
  const resendAsTurn=()=>{
    const current=useChatStore.getState().threads[sessionId];
    const drops = discarded.get(sessionId) ?? new Set(); drops.add(message.id); discarded.set(sessionId, drops);
    dirty.get(sessionId)?.delete(message.id);
    if(current) useChatStore.getState().patch(sessionId,{messages:current.messages.filter(m=>m.id!==message.id),inputError:undefined,draft:current.draft===message.text?"":current.draft});
    return sendChatTurn(sessionId,prompt,attachments,{preserveDraft:true,coordination:options?.coordination,expectedIdentity:options?.expectedIdentity});
  };
  try {
    await launches.get(sessionId);
    const current=useChatStore.getState().threads[sessionId];
    if (!useSessionStore.getState().sessions.some(s=>s.id===sessionId)) return false;
    if (options?.expectedIdentity && chatSessionIdentity(useSessionStore.getState().sessions.find(s=>s.id===sessionId)!) !== options.expectedIdentity) throw new Error("The receiving conversation changed before coordination delivery.");
    if (!current || current.turnId !== old.turnId || current.status === "stopped" || current.error || cancelledTurns.has(old.turnId)) throw new Error("The response was stopped or failed; resend the complement to continue.");
    if (!current?.busy) return resendAsTurn();
    const status=await invoke<string>("steer_chat_turn",{messageId,request:{sessionId,turnId:current.turnId,runnerType:session.runner.type,cliPath:session.runner.cliPath||undefined,projectPath:useWorkspaceStore.getState().workspaces.find(workspace=>workspace.id===session.workspaceId)?.path||session.workdir,workdir:session.worktreePath||session.workdir,prompt:prompt.trim(),attachments,mode:session.runner.mode==="plan"?"plan":"code"}});
    const latest=useChatStore.getState().threads[sessionId];
    if(latest) useChatStore.getState().patch(sessionId,{messages:latest.messages.map(m=>m.id===message.id && m.status==="sending"?{...m,status:status||"queued"}:m)});
    return options?.coordination ? await waitCoordinationReceipt(sessionId, message.id) : true;
  } catch(error) {
    // As in the native CLIs, input typed while a turn finishes is not lost or reported as an error.
    if(!options?.coordination && String(error).includes(TURN_ENDED) && await waitTurnCompleted(sessionId,old.turnId)) return resendAsTurn();
    const latest=useChatStore.getState().threads[sessionId];
    if(latest)useChatStore.getState().patch(sessionId,{messages:latest.messages.map(m=>m.id===message.id?{...m,status:"failed",title:String(error)}:m),...(!options?.coordination?{inputError:String(error),draft:latest.draft||prompt}:{})});
    return false;
  }
}

/** The first stop interrupts the turn natively; a second one ends the process at once. */
export async function stopChatTurn(sessionId: string) {
  const thread = useChatStore.getState().threads[sessionId];
  if (thread?.busy && thread.turnId) { cancelledTurns.add(thread.turnId); useChatStore.getState().patch(sessionId, { stopRequested: true }); }
  try { await invoke("stop_chat_turn", { sessionId }); }
  catch (error) {
    if (thread?.turnId) cancelledTurns.delete(thread.turnId);
    if (useChatStore.getState().threads[sessionId]?.turnId === thread?.turnId) useChatStore.getState().patch(sessionId, { error: String(error), stopRequested: undefined });
  }
}

/** Verify the native process without treating a quiet model as a failed turn. */
export async function refreshChatTurnStatus(sessionId: string): Promise<ChatTurnStatus | undefined> {
  const before = useChatStore.getState().threads[sessionId];
  if (!before?.busy || !before.turnId || launches.has(sessionId)) return undefined;
  const status = await invoke<ChatTurnStatus>("get_chat_turn_status", { sessionId });
  const current = useChatStore.getState().threads[sessionId];
  if (!current?.busy || current.turnId !== before.turnId || launches.has(sessionId)) return status;
  if (!status || typeof status.running !== "boolean") throw new Error("Invalid chat process status.");
  if (status.turnId && status.turnId !== current.turnId) return status;
  if (status.running) {
    useChatStore.getState().patch(sessionId, { lastHeartbeatAt: Date.now(), ...(status.pid ? { pid: status.pid } : {}), ...(status.status && status.status !== "running" ? { status: status.status } : {}) });
    if (status.interactions && current.interactions === before.interactions) {
      useChatStore.getState().patch(sessionId, { interactions: status.interactions });
      for (const previous of current.interactions ?? []) if (!status.interactions.some(request => request.id === previous.id)) recordChatAttention({ sessionId, turnId: current.turnId!, kind: "interaction", status: "resolved", itemId: previous.id });
      for (const interaction of status.interactions) recordChatAttention({ sessionId, turnId: current.turnId!, kind: "interaction", interaction });
    }
  } else {
    flushChatEvents();
    const latest = useChatStore.getState().threads[sessionId];
    if (latest?.busy && latest.turnId === before.turnId) enqueueChatEvent({ sessionId, turnId: before.turnId, kind: "done", status: status.status || "interrupted" });
  }
  return status;
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
