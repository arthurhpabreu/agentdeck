import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { mirroredPersistStorage } from "./persistStorage";

export const WORKSPACE_COLORS = [
  { id: "blue",   hex: "#3b82f6" },
  { id: "green",  hex: "#22c55e" },
  { id: "purple", hex: "#a855f7" },
  { id: "orange", hex: "#f97316" },
  { id: "red",    hex: "#ef4444" },
  { id: "yellow", hex: "#eab308" },
  { id: "gray",   hex: "#6b7280" },
] as const;

export type WorkspaceColorId = typeof WORKSPACE_COLORS[number]["id"];

export function getWorkspaceColor(id: WorkspaceColorId): string {
  return WORKSPACE_COLORS.find((c) => c.id === id)?.hex ?? "#6b7280";
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  color: WorkspaceColorId;
  createdAt: number;
  order: number;
}

interface WorkspaceStore {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  addWorkspace: (path: string, name?: string, color?: WorkspaceColorId) => string;
  removeWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string) => void;
  bringToFront: (id: string) => void;
  updateWorkspace: (id: string, patch: Partial<Pick<Workspace, "name" | "color">>) => void;
}

let _wid = Date.now();
function makeId() { return String(_wid++); }

export function pathBasename(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

const COLOR_CYCLE: WorkspaceColorId[] = ["blue", "green", "purple", "orange", "red", "yellow"];
let _colorIdx = 0;
function nextColor(): WorkspaceColorId {
  return COLOR_CYCLE[_colorIdx++ % COLOR_CYCLE.length];
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set) => ({
      workspaces: [],
      activeWorkspaceId: null,

      addWorkspace: (path, name, color) => {
        const id = makeId();
        const ws: Workspace = {
          id,
          name: name || pathBasename(path),
          path,
          color: color ?? nextColor(),
          createdAt: Date.now(),
          order: 0,
        };
        set((state) => {
          const updated = state.workspaces.map((w) => ({ ...w, order: w.order + 1 }));
          return { workspaces: [ws, ...updated], activeWorkspaceId: id };
        });
        return id;
      },

      removeWorkspace: (id) =>
        set((state) => {
          const workspaces = state.workspaces.filter((w) => w.id !== id);
          const activeWorkspaceId =
            state.activeWorkspaceId === id
              ? (workspaces[0]?.id ?? null)
              : state.activeWorkspaceId;
          return { workspaces, activeWorkspaceId };
        }),

      setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),

      bringToFront: (id) =>
        set((state) => {
          const sorted = [...state.workspaces].sort((a, b) => a.order - b.order);
          const target = sorted.find((w) => w.id === id);
          if (!target) return {};
          const rest = sorted.filter((w) => w.id !== id);
          const reordered = [
            { ...target, order: 0 },
            ...rest.map((w, i) => ({ ...w, order: i + 1 })),
          ];
          return { workspaces: reordered, activeWorkspaceId: id };
        }),

      updateWorkspace: (id, patch) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) =>
            w.id === id ? { ...w, ...patch } : w
          ),
        })),
    }),
    {
      name: "agentdeck-workspaces",
      storage: createJSONStorage(() => mirroredPersistStorage),
    }
  )
);

export function useWorkspacesSorted(): Workspace[] {
  // Do not sort inside a selector: returning a new array each time makes Zustand rerender indefinitely.
  // Memoize against the original workspaces reference and sort only when that array changes.
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  return useMemo(
    () => [...workspaces].sort((a, b) => a.order - b.order),
    [workspaces]
  );
}
