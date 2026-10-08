import { create } from "zustand";
import type { MemoryDraft, MemoryRecord } from "../services/memoryCommands";

interface PendingMemoryDraft { draft: MemoryDraft; selected: MemoryRecord | null }

// Unsaved notes stay in memory only. All mounted views observe save/cancel,
// including a view reopened while the original save is still in flight.
export const useMemoryDraftStore = create<{
  drafts: Record<string, PendingMemoryDraft>;
  put: (path: string, draft: MemoryDraft, selected: MemoryRecord | null) => void;
  clear: (path: string) => void;
}>(set => ({
  drafts: {},
  put: (path, draft, selected) => set(state => ({ drafts: { ...state.drafts, [path]: { draft, selected } } })),
  clear: path => set(state => {
    if (!state.drafts[path]) return state;
    const drafts = { ...state.drafts };
    delete drafts[path];
    return { drafts };
  }),
}));
