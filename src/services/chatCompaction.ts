import type { ChatThread } from "../store/chatStore";

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
export function shouldCompact(thread: ChatThread, prompt: string, providerSessionId?: string): boolean {
  const policy = compactionPolicy(thread.compactionPolicy);
  const prompts = thread.contextPrompts ?? 0;
  const hasCompacted = (thread.compactionCount ?? 0) > 0 || thread.lastCompactedAt !== undefined;
  // A provider summary can remain above the configured limit. Allow new work before
  // requesting another compaction; native provider context protection still applies.
  const tokenLimitReached = (!hasCompacted || prompts >= TOKEN_COMPACTION_MIN_PROMPTS) && (thread.contextTokens ?? 0) + estimateTokens(prompt) >= policy.maxTokens;
  return !!providerSessionId && policy.enabled && !prompt.trimStart().startsWith("/") && (prompts >= policy.maxPrompts || tokenLimitReached);
}

export const HISTORY_PAGE_SIZE = 80;
export const RESIDENT_MESSAGE_LIMIT = 200;
export const RESIDENT_TEXT_LIMIT = 512_000;
/** Eviction is only allowed after the archive transaction commits. Keep active input/output. */
export function residentMessages(thread: ChatThread) {
  let bytes = 0; let start = thread.messages.length;
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const message = thread.messages[i]; bytes += message.text.length;
    if (thread.messages.length - i > RESIDENT_MESSAGE_LIMIT || bytes > RESIDENT_TEXT_LIMIT) break;
    start = i;
  }
  if (thread.busy) {
    const active = thread.messages.findIndex(m => m.turnId === thread.turnId);
    if (active >= 0) start = Math.min(start, active);
  }
  // Always retain the latest message, even when a single response is unusually large.
  return thread.messages.slice(Math.min(start, Math.max(0, thread.messages.length - 1)));
}
