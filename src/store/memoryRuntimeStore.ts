import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { RetrievalHit } from "../services/memoryIntelligenceCommands";
import type { KnowledgeWarning } from "../services/knowledgeCommands";
import { useSourceDeliveryStore } from "./sourceDeliveryStore";

export interface MemoryContextEvent { sessionId: string; projectKey?: string; recordCount: number; estimatedTokens: number; duplicateCount: number; contextId?: string; policyRevision?: number; phase?: "prepared" | "delivered"; sources?: RetrievalHit[]; warnings?: KnowledgeWarning[] }
interface MemoryRuntime { context?: MemoryContextEvent; error?: string; updatedAt: number; deliveredPolicyRevisions?: number[] }
interface ContextGuard { id: string; preparedAt: number; retired: Set<string>; incomplete: boolean; delivered: boolean }
const contextGuards = new Map<string, ContextGuard>();
const CONTEXT_GUARD_LIMIT = 256;
const RETIRED_CONTEXT_LIMIT = 512;
const PREPARATION_PROOF_TTL = 30 * 60_000;
/** Lightweight guards remain available when the larger source previews are evicted. */
function acceptsContext(event: MemoryContextEvent): boolean {
  if (event.phase !== "prepared" && event.phase !== "delivered") return true;
  if (!event.contextId) return event.phase !== "delivered";
  const previous = contextGuards.get(event.sessionId);
  if (previous?.retired.has(event.contextId)) return false;
  if (event.phase === "delivered") {
    if (!previous || previous.id !== event.contextId) return false;
    if (previous.delivered) return false;
    if (previous.incomplete || Date.now() - previous.preparedAt > PREPARATION_PROOF_TTL) {
      // Once proof expires or cannot be retained, a later phase cannot establish full provenance.
      if (useSourceDeliveryStore.getState().historyBySession[event.sessionId]?.origin === "tracked") useSourceDeliveryStore.getState().markUnknown(event.sessionId);
      return false;
    }
    previous.delivered = true;
    return true;
  }
  if (previous?.id === event.contextId) return !previous.delivered;
  const retired = previous?.retired ?? new Set<string>();
  if (previous) retired.add(previous.id);
  let incomplete = previous?.incomplete ?? false;
  if (retired.size > RETIRED_CONTEXT_LIMIT) {
    retired.delete(retired.values().next().value!);
    incomplete = true;
  }
  contextGuards.delete(event.sessionId);
  contextGuards.set(event.sessionId, { id: event.contextId, preparedAt: Date.now(), retired, incomplete, delivered: false });
  if (contextGuards.size > CONTEXT_GUARD_LIMIT) {
    const oldest = contextGuards.keys().next().value!;
    contextGuards.delete(oldest);
    // The durable marker retains this uncertainty even if old preparations arrive again.
    if (useSourceDeliveryStore.getState().historyBySession[oldest]?.origin === "tracked") useSourceDeliveryStore.getState().markUnknown(oldest);
  }
  return true;
}
useSourceDeliveryStore.subscribe((state, previous) => {
  if (state.historyBySession === previous.historyBySession) return;
  for (const sessionId of Object.keys(previous.historyBySession)) if (!(sessionId in state.historyBySession)) contextGuards.delete(sessionId);
});
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
    if (!acceptsContext(event)) return;
    let confirmedRevision: number | undefined;
    set(state => {
      const current = state.sessions[event.sessionId]?.context;
      if (event.phase === "delivered" && current?.contextId && event.contextId !== current.contextId) return state;
      if (event.phase === "prepared" && current?.phase === "delivered" && event.contextId === current.contextId) return state;
      if (event.phase === "delivered" && typeof event.policyRevision === "number" && Number.isSafeInteger(event.policyRevision) && event.policyRevision >= 0) confirmedRevision = event.policyRevision;
      const context = { ...event,
        sources: Array.isArray(event.sources) ? event.sources.filter(source => source && typeof source.id === "string" && typeof source.title === "string" && typeof source.excerpt === "string").slice(0, 3) : undefined,
        warnings: Array.isArray(event.warnings) ? event.warnings.filter(warning => warning && typeof warning.code === "string" && typeof warning.sourcePath === "string").slice(0, 4) : [],
      };
      const deliveredPolicyRevisions = state.sessions[event.sessionId]?.deliveredPolicyRevisions ?? [];
      const revisions = event.phase === "delivered" && event.policyRevision !== undefined && !deliveredPolicyRevisions.includes(event.policyRevision) ? [...deliveredPolicyRevisions, event.policyRevision] : deliveredPolicyRevisions;
      const sessions = { ...state.sessions, [event.sessionId]: { context, updatedAt: Date.now(), deliveredPolicyRevisions: revisions } };
      const keys = Object.keys(sessions);
      if (keys.length > 100) delete sessions[keys[0]];
      return { sessions };
    });
    // Reject obsolete context IDs before recording durable delivery evidence.
    if (confirmedRevision !== undefined) useSourceDeliveryStore.getState().delivered(event.sessionId, confirmedRevision);
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
