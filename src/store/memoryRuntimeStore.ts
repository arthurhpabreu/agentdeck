import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { RetrievalHit } from "../services/memoryIntelligenceCommands";
import type { KnowledgeWarning } from "../services/knowledgeCommands";

export interface MemoryContextEvent { sessionId: string; projectKey?: string; recordCount: number; estimatedTokens: number; duplicateCount: number; contextId?: string; phase?: "prepared" | "delivered"; sources?: RetrievalHit[]; warnings?: KnowledgeWarning[] }
interface MemoryRuntime { context?: MemoryContextEvent; error?: string; updatedAt: number }
export const useMemoryRuntimeStore = create<{
  sessions: Record<string, MemoryRuntime>;
  changes: Record<string, number>;
  context: (event: MemoryContextEvent) => void;
  error: (sessionId: string, error: string) => void;
  changed: (projectKey: string) => void;
}>((set) => ({
  sessions: {}, changes: {},
  context: event => {
    if (!event.sessionId || ![event.recordCount, event.estimatedTokens, event.duplicateCount].every(value => Number.isFinite(value) && value >= 0)) return;
    set(state => {
      const current = state.sessions[event.sessionId]?.context;
      if (event.phase === "delivered" && current?.contextId && event.contextId !== current.contextId) return state;
      if (event.phase === "prepared" && current?.phase === "delivered" && event.contextId === current.contextId) return state;
      const context = { ...event,
        sources: Array.isArray(event.sources) ? event.sources.filter(source => source && typeof source.id === "string" && typeof source.title === "string" && typeof source.excerpt === "string").slice(0, 3) : undefined,
        warnings: Array.isArray(event.warnings) ? event.warnings.filter(warning => warning && typeof warning.code === "string" && typeof warning.sourcePath === "string").slice(0, 4) : [],
      };
      const sessions = { ...state.sessions, [event.sessionId]: { context, updatedAt: Date.now() } };
      const keys = Object.keys(sessions);
      if (keys.length > 100) delete sessions[keys[0]];
      return { sessions };
    });
  },
  error: (sessionId, error) => {
    if (!sessionId) return;
    set(state => ({ sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], error, updatedAt: Date.now() } } }));
  },
  changed: projectKey => {
    if (!projectKey) return;
    set(state => ({ changes: { ...state.changes, [projectKey]: (state.changes[projectKey] ?? 0) + 1 } }));
  },
}));

let consumers = 0;
let stop: (() => void) | undefined;
/** One listener group shared by the memory panel and all visible session controls. */
export function useMemoryRuntimeEvents() {
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    consumers += 1;
    if (consumers === 1) {
      let disposed = false;
      const subscriptions: UnlistenFn[] = [];
      void Promise.allSettled([
        listen<MemoryContextEvent>("shared-memory-context", ({ payload }) => useMemoryRuntimeStore.getState().context(payload)),
        listen<{ sessionId: string; error: string }>("shared-memory-error", ({ payload }) => useMemoryRuntimeStore.getState().error(payload.sessionId, payload.error)),
        listen<{ projectKey: string }>("shared-memory-changed", ({ payload }) => useMemoryRuntimeStore.getState().changed(payload.projectKey)),
      ]).then(results => {
        for (const result of results) {
          if (result.status === "fulfilled") { if (disposed) result.value(); else subscriptions.push(result.value); }
          else console.warn("[memory-events] subscription unavailable", result.reason);
        }
      });
      stop = () => { disposed = true; subscriptions.forEach(unsubscribe => unsubscribe()); };
    }
    return () => { consumers -= 1; if (consumers === 0) { stop?.(); stop = undefined; } };
  }, []);
}
