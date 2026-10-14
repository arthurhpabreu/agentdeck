import type { ChatAttachment, ChatMessage, ChatThread } from "../store/chatStore";

export interface CompactionPolicy { enabled: boolean; maxPrompts: number; maxTokens: number; version?: number }
export const defaultCompactionPolicy: CompactionPolicy = { enabled: true, maxPrompts: 50, maxTokens: 200_000, version: 2 };
export function compactionPolicy(value?: Partial<CompactionPolicy>): CompactionPolicy {
  const limit = (n: unknown, fallback: number, min: number, max: number) => typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  return { enabled: value?.enabled !== false, maxPrompts: limit(value?.maxPrompts, defaultCompactionPolicy.maxPrompts, 5, 100), maxTokens: limit(value?.maxTokens, defaultCompactionPolicy.maxTokens, 8_000, 500_000), version: 2 };
}
/** Upgrade the old enabled default once; retain custom limits and explicit opt-out. */
export function restoreCompactionPolicy(value?: Partial<CompactionPolicy>): CompactionPolicy {
  return compactionPolicy(value?.version === undefined && value?.enabled !== false && value?.maxPrompts === 20 && value?.maxTokens === 64_000 ? defaultCompactionPolicy : value);
}
export const TOKEN_COMPACTION_MIN_PROMPTS = 5;
/** A conservative estimate, never a billing counter or an exact tokenizer result. */
export function estimateTokens(text: string): number { return Math.ceil(new TextEncoder().encode(text).length / 3); }
export interface CompactionBudget {
  promptTokens: number;
  projectedTokens: number;
  tokenLimit: number;
  reserveTokens: number;
  contextWindow?: number;
  windowPressure: boolean;
  promptTooLarge: boolean;
}
/** Files are sent as paths, not inline text. Image tokenization remains provider-specific. */
export function estimateChatInputTokens(prompt: string, attachments: ChatAttachment[] = []): number {
  const fileReferences = attachments.length ? `\n\nFiles attached by the user (local paths; read as needed):\n${attachments.map(file => `- ${JSON.stringify(file.name)}: ${JSON.stringify(file.path)}`).join("\n")}\n` : "";
  return estimateTokens(prompt + fileReferences);
}
/** Leave room for replies, tool results and provider instructions without guessing model limits. */
export function getCompactionBudget(thread: ChatThread, prompt: string, attachments: ChatAttachment[] = []): CompactionBudget {
  const policy = compactionPolicy(thread.compactionPolicy);
  const contextWindow = typeof thread.contextWindow === "number" && Number.isFinite(thread.contextWindow) && thread.contextWindow > 0 ? thread.contextWindow : undefined;
  const reserveTokens = contextWindow ? Math.min(Math.floor(contextWindow / 4), Math.max(8_000, Math.min(32_000, Math.ceil(contextWindow * 0.1)))) : 0;
  const windowLimit = contextWindow ? Math.max(1, contextWindow - reserveTokens) : undefined;
  const promptTokens = estimateChatInputTokens(prompt, attachments);
  const projectedTokens = (thread.contextTokens ?? 0) + promptTokens;
  return {
    promptTokens, projectedTokens, reserveTokens, contextWindow,
    tokenLimit: Math.min(policy.maxTokens, windowLimit ?? policy.maxTokens),
    windowPressure: windowLimit !== undefined && projectedTokens >= windowLimit,
    promptTooLarge: contextWindow !== undefined && promptTokens >= contextWindow,
  };
}
export function shouldCompact(thread: ChatThread, prompt: string, providerSessionId?: string, attachments: ChatAttachment[] = []): boolean {
  const policy = compactionPolicy(thread.compactionPolicy);
  const prompts = thread.contextPrompts ?? 0;
  const budget = getCompactionBudget(thread, prompt, attachments);
  const hasCompacted = (thread.compactionCount ?? 0) > 0 || thread.lastCompactedAt !== undefined;
  // A provider summary can remain above the configured limit. Allow new work before
  // requesting another compaction; native provider context protection still applies.
  // A large new request or a reported context-window boundary must not wait out
  // the cooldown intended only to prevent repeat compactions of the same summary.
  const substantialNewInput = budget.promptTokens >= Math.max(8_000, Math.ceil(budget.tokenLimit * 0.1));
  const tokenLimitReached = budget.windowPressure || (!hasCompacted || prompts >= TOKEN_COMPACTION_MIN_PROMPTS || substantialNewInput) && budget.projectedTokens >= budget.tokenLimit;
  return !!providerSessionId && policy.enabled && !prompt.trimStart().startsWith("/") && (prompts >= policy.maxPrompts || tokenLimitReached);
}

export const HISTORY_PAGE_SIZE = 80;
export const RENDERED_TEXT_LIMIT = 160_000;
/** Bound layout work when many large messages are restored or loaded together.
 * Keep the latest message complete; earlier messages remain reachable by cursor.
 */
export function boundedChatMessages(messages: ChatMessage[]): ChatMessage[] {
  let start = messages.length;
  let size = 0;
  for (let index = messages.length - 1; index >= 0 && messages.length - index <= HISTORY_PAGE_SIZE; index--) {
    const nextSize = messageTextSize(messages[index]);
    if (start < messages.length && size + nextSize > RENDERED_TEXT_LIMIT) break;
    size += nextSize;
    start = index;
  }
  return messages.slice(start);
}
export const RESIDENT_MESSAGE_LIMIT = 200;
export const RESIDENT_TEXT_LIMIT = 512_000;
export function messageTextSize(message: ChatMessage): number { return message.text.length + (message.output?.length ?? 0) + (message.command?.length ?? 0); }
/** Eviction is only allowed after the archive transaction commits. Keep active input/output. */
export function residentMessages(thread: ChatThread) {
  let bytes = 0; let start = thread.messages.length;
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const message = thread.messages[i]; bytes += messageTextSize(message);
    if (thread.messages.length - i > RESIDENT_MESSAGE_LIMIT || bytes > RESIDENT_TEXT_LIMIT) break;
    start = i;
  }
  // Always retain the latest message, even when a single response is unusually large.
  start = Math.min(start, Math.max(0, thread.messages.length - 1));
  let latestAssistant = -1;
  if (thread.busy) for (let index = thread.messages.length - 1; index >= 0; index--) if (thread.messages[index].turnId === thread.turnId && thread.messages[index].role === "assistant") { latestAssistant = index; break; }
  return thread.messages.filter((message, index) => index >= start || thread.busy && message.turnId === thread.turnId && (
    index === latestAssistant || message.id === `${thread.turnId}:user` || message.role === "user" && (message.status === "sending" || message.status === "queued") ||
    message.role === "tool" && !["completed", "failed", "error", "stopped", "interrupted"].includes(message.status ?? "")
  ));
}
