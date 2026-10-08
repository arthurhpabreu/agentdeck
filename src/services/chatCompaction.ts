import type { ChatThread } from "../store/chatStore";

export interface CompactionPolicy { enabled: boolean; maxPrompts: number; maxTokens: number }
export const defaultCompactionPolicy: CompactionPolicy = { enabled: true, maxPrompts: 20, maxTokens: 64_000 };
export function compactionPolicy(value?: Partial<CompactionPolicy>): CompactionPolicy {
  const limit = (n: unknown, fallback: number, min: number, max: number) => typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  return { enabled: value?.enabled !== false, maxPrompts: limit(value?.maxPrompts, 20, 5, 100), maxTokens: limit(value?.maxTokens, 64_000, 8_000, 500_000) };
}
/** A conservative estimate, never a billing counter or an exact tokenizer result. */
export function estimateTokens(text: string): number { return Math.ceil(new TextEncoder().encode(text).length / 3); }
export function shouldCompact(thread: ChatThread, prompt: string, providerSessionId?: string): boolean {
  const policy = compactionPolicy(thread.compactionPolicy);
  return !!providerSessionId && policy.enabled && !prompt.trimStart().startsWith("/") &&
    ((thread.contextPrompts ?? 0) >= policy.maxPrompts || (thread.contextTokens ?? 0) + estimateTokens(prompt) >= policy.maxTokens);
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
