import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { mirroredPersistStorage } from "./persistStorage";

export interface VisualPoint { x: number; y: number }
export interface PresentationLayout { order?: string[]; positions?: Record<string, VisualPoint> }
interface PresentationState {
  layouts: Record<string, PresentationLayout>;
  history: Record<string, PresentationLayout[]>;
  density: "comfortable" | "compact";
  views: Record<string, string>;
  moveItem: (surface: string, context: string, allIds: string[], visibleIds: string[], activeId: string, overId: string) => void;
  setOrder: (surface: string, context: string, ids: string[]) => void;
  movePosition: (surface: string, context: string, id: string, position: VisualPoint) => void;
  setPositions: (surface: string, context: string, positions: Record<string, VisualPoint>) => void;
  reset: (surface: string, context: string) => void;
  undo: (surface: string, context: string) => void;
  setDensity: (density: "comfortable" | "compact") => void;
  setView: (surface: string, view: string) => void;
}
export const presentationKey = (surface: string, context: string) => JSON.stringify([surface, context]);
const unique = (ids: string[]) => [...new Set(ids)];

/** Unknown/new IDs append; filtering never discards a saved position. */
export function applyPresentationOrder(ids: string[], order?: string[]): string[] {
  if (!order) return unique(ids);
  const available = new Set(ids);
  const saved = unique(order).filter(id => available.has(id));
  const known = new Set(saved);
  return [...saved, ...unique(ids).filter(id => !known.has(id))];
}

/** Move only the visible slots; hidden items remain exactly where they were. */
export function moveVisiblePresentation(all: string[], visible: string[], active: string, over: string): string[] {
  const shown = new Set(visible);
  const orderedVisible = all.filter(id => shown.has(id));
  const from = orderedVisible.indexOf(active), to = orderedVisible.indexOf(over);
  if (from < 0 || to < 0 || from === to) return all;
  orderedVisible.splice(to, 0, ...orderedVisible.splice(from, 1));
  let index = 0;
  return all.map(id => shown.has(id) ? orderedVisible[index++] : id);
}

function changeLayout(state: PresentationState, key: string, next: PresentationLayout) {
  const previous = state.layouts[key] ?? {};
  if (JSON.stringify(previous) === JSON.stringify(next)) return state;
  return {
    layouts: { ...state.layouts, [key]: next },
    history: { ...state.history, [key]: [...(state.history[key] ?? []), previous].slice(-20) },
  };
}

/** Presentation is independent from provider state, ownership and source permission. */
export const usePresentationStore = create<PresentationState>()(persist((set) => ({
  layouts: {}, history: {}, density: "comfortable", views: {},
  moveItem: (surface, context, allIds, visibleIds, active, over) => set(state => {
    const key = presentationKey(surface, context);
    const previous = state.layouts[key] ?? {};
    // Backends may return only a query/window subset. Keep remembered hidden
    // IDs until the owning surface is explicitly reset, rather than pruning
    // their positions during an unrelated filtered move.
    const all = applyPresentationOrder(unique([...(previous.order ?? []), ...allIds]), previous.order);
    const next = moveVisiblePresentation(all, visibleIds, active, over);
    return next === all ? state : changeLayout(state, key, { ...previous, order: next });
  }),
  setOrder: (surface, context, ids) => set(state => {
    const key = presentationKey(surface, context);
    return changeLayout(state, key, { ...state.layouts[key], order: unique(ids) });
  }),
  movePosition: (surface, context, id, position) => set(state => {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return state;
    const key = presentationKey(surface, context), previous = state.layouts[key] ?? {};
    return changeLayout(state, key, { ...previous, positions: { ...previous.positions, [id]: { x: Math.max(0, position.x), y: Math.max(0, position.y) } } });
  }),
  setPositions: (surface, context, positions) => set(state => {
    const safe = Object.fromEntries(Object.entries(positions).filter(([, point]) => Number.isFinite(point.x) && Number.isFinite(point.y)).map(([id, point]) => [id, { x: Math.max(0, point.x), y: Math.max(0, point.y) }]));
    const key = presentationKey(surface, context);
    return changeLayout(state, key, { ...state.layouts[key], positions: safe });
  }),
  reset: (surface, context) => set(state => changeLayout(state, presentationKey(surface, context), {})),
  undo: (surface, context) => set(state => {
    const key = presentationKey(surface, context), history = state.history[key];
    if (!history?.length) return state;
    return { layouts: { ...state.layouts, [key]: history[history.length - 1] }, history: { ...state.history, [key]: history.slice(0, -1) } };
  }),
  setDensity: density => set({ density }),
  setView: (surface, view) => set(state => state.views[surface] === view ? state : ({ views: { ...state.views, [surface]: view } })),
}), { name: "agentdeck-presentation", version: 1, storage: createJSONStorage(() => mirroredPersistStorage), partialize: state => ({ layouts: state.layouts, density: state.density, views: state.views }) }));

export function usePresentationOrder<T>(surface: string, context: string, items: T[], getId: (item: T) => string): T[] {
  const order = usePresentationStore(state => state.layouts[presentationKey(surface, context)]?.order);
  return useMemo(() => {
    const byId = new Map(items.map(item => [getId(item), item]));
    return applyPresentationOrder([...byId.keys()], order).map(id => byId.get(id)!);
  }, [items, order, getId]);
}
