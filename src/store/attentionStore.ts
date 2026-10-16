import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { mirroredPersistStorage } from "./persistStorage";
import type { ChatEvent } from "./chatStore";

export type AttentionKind = "question" | "approval" | "error" | "completed";
/** Lower is more urgent. */
export const ATTENTION_RANK: Record<AttentionKind, number> = { approval: 0, question: 1, error: 2, completed: 3 };
export interface AttentionItem { id: string; sessionId: string; kind: AttentionKind; text: string; source: string; at: number; read: boolean }
export const useAttentionStore = create<{
  items: AttentionItem[];
  record: (item: Omit<AttentionItem, "read">) => void;
  readSession: (sessionId: string) => void;
  read: (id: string) => void;
  clearSession: (sessionId: string) => void;
  resolveActions: (sessionId: string) => void;
}>()(persist((set) => ({
  items: [],
  record: item => set(state => state.items.some(existing => existing.id === item.id) ? state : { items: [...state.items, { ...item, read: false }].slice(-500) }),
  readSession: sessionId => set(state => ({ items: state.items.map(item => item.sessionId === sessionId && item.kind === "completed" && !item.read ? { ...item, read: true } : item) })),
  read: id => set(state => ({ items: state.items.map(item => item.id === id ? { ...item, read: true } : item) })),
  clearSession: sessionId => set(state => ({ items: state.items.filter(item => item.sessionId !== sessionId) })),
  resolveActions: sessionId => set(state => ({ items: state.items.map(item => item.sessionId === sessionId && item.kind !== "completed" && !item.read ? { ...item, read: true } : item) })),
}), { name: "agentdeck-attention-v1", storage: createJSONStorage(() => mirroredPersistStorage) }));

/** Only accepted provider events: passive OAuth/heartbeat/silence never enter the inbox. */
export function recordChatAttention(event: ChatEvent, failed = false) {
  if (event.parentId) return;
  if (event.kind === "status" && event.status === "started") useAttentionStore.getState().resolveActions(event.sessionId);
  const kind: AttentionKind | undefined = event.kind === "error" ? "error"
    : event.kind === "tool" && event.status === "blocked" ? "approval"
    : event.kind === "status" && ["needs-input", "question", "approval-required"].includes(event.status ?? "") ? event.status === "approval-required" ? "approval" : "question"
    : event.kind === "done" && !failed && event.status !== "error" && !["stopped", "interrupted"].includes(event.status ?? "") ? "completed" : undefined;
  if (kind) useAttentionStore.getState().record({ id: `chat:${event.sessionId}:${event.turnId}:${kind}:${event.itemId ?? "turn"}`, sessionId: event.sessionId, kind, text: (event.text || event.title || "").slice(0, 1200), source: "provider", at: Date.now() });
}
