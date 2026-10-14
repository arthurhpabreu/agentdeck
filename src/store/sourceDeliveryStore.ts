import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { mirroredPersistStorage } from "./persistStorage";

interface SourceHistoryEvidence {
  origin: "tracked" | "unknown";
  providerSessionId?: string;
}
interface SourceDeliveryState {
  revisionsBySession: Record<string, number[]>;
  historyBySession: Record<string, SourceHistoryEvidence>;
  /** Register before adding the first outgoing message, while its prior history is still known. */
  start: (sessionId: string, history: { hasHistory: boolean; providerSessionId?: string }) => void;
  markUnknown: (sessionId: string) => void;
  bindProvider: (sessionId: string, providerSessionId: string) => void;
  delivered: (sessionId: string, revision: number) => void;
  requiresReview: (sessionId: string, currentRevision: number) => boolean;
  remove: (sessionId: string) => void;
}
const validRevision = (revision: number) => Number.isSafeInteger(revision) && revision >= 0;

/** Confirmed deliveries and the origin of the entire history survive a restart. */
export const useSourceDeliveryStore = create<SourceDeliveryState>()(persist((set, get) => ({
  revisionsBySession: {},
  historyBySession: {},
  start: (sessionId, history) => {
    if (!sessionId) return;
    set(state => {
      const previous = state.historyBySession[sessionId];
      const providerSessionId = history.providerSessionId?.trim() || undefined;
      if (previous) {
        if (!providerSessionId || previous.providerSessionId === providerSessionId) return state;
        const origin = previous.providerSessionId ? "unknown" : previous.origin;
        return { historyBySession: { ...state.historyBySession, [sessionId]: { origin, providerSessionId } } };
      }
      // An appended delivery proves only that turn, never the provenance of an older history.
      const unknown = history.hasHistory || !!providerSessionId || !!state.revisionsBySession[sessionId]?.length;
      return { historyBySession: { ...state.historyBySession, [sessionId]: { origin: unknown ? "unknown" : "tracked", providerSessionId } } };
    });
  },
  markUnknown: sessionId => {
    if (!sessionId) return;
    set(state => state.historyBySession[sessionId]?.origin === "unknown" ? state : {
      historyBySession: { ...state.historyBySession, [sessionId]: { ...state.historyBySession[sessionId], origin: "unknown" } },
    });
  },
  bindProvider: (sessionId, providerSessionId) => {
    if (!sessionId || !providerSessionId?.trim()) return;
    set(state => {
      const previous = state.historyBySession[sessionId];
      if (previous?.providerSessionId === providerSessionId) return state;
      const origin = !previous || previous.providerSessionId ? "unknown" : previous.origin;
      return { historyBySession: { ...state.historyBySession, [sessionId]: { origin, providerSessionId } } };
    });
  },
  delivered: (sessionId, revision) => {
    if (!sessionId || !validRevision(revision)) return;
    set(state => {
      const revisions = state.revisionsBySession[sessionId] ?? [];
      const history = state.historyBySession[sessionId];
      if (revisions.includes(revision) && history) return state;
      return {
        revisionsBySession: revisions.includes(revision) ? state.revisionsBySession : { ...state.revisionsBySession, [sessionId]: [...revisions, revision] },
        historyBySession: history ? state.historyBySession : { ...state.historyBySession, [sessionId]: { origin: "unknown" } },
      };
    });
  },
  requiresReview: (sessionId, currentRevision) => {
    const state = get();
    const revisions = state.revisionsBySession[sessionId] ?? [];
    return !validRevision(currentRevision) || state.historyBySession[sessionId]?.origin !== "tracked"
      || !revisions.length || revisions.some(revision => !validRevision(revision) || revision !== currentRevision);
  },
  remove: sessionId => set(state => {
    if (!(sessionId in state.revisionsBySession) && !(sessionId in state.historyBySession)) return state;
    const revisionsBySession = { ...state.revisionsBySession };
    const historyBySession = { ...state.historyBySession };
    delete revisionsBySession[sessionId]; delete historyBySession[sessionId];
    return { revisionsBySession, historyBySession };
  }),
}), {
  name: "agentdeck-source-delivery-v1",
  version: 1,
  storage: createJSONStorage(() => mirroredPersistStorage),
  // Existing revision arrays were collected without proving the origin of the prior messages.
  migrate: persisted => {
    const previous = persisted as Partial<SourceDeliveryState> | undefined;
    const revisionsBySession = previous?.revisionsBySession ?? {};
    return {
      revisionsBySession,
      historyBySession: Object.fromEntries(Object.keys(revisionsBySession).map(sessionId => [sessionId, { origin: "unknown" as const }])),
    };
  },
}));
