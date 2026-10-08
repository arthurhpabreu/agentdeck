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
  { id: "teal", hex: "#14b8a6" },
  { id: "cyan", hex: "#06b6d4" },
  { id: "sky", hex: "#38bdf8" },
  { id: "indigo", hex: "#6366f1" },
  { id: "violet", hex: "#8b5cf6" },
  { id: "pink", hex: "#ec4899" },
  { id: "rose", hex: "#fb7185" },
  { id: "lime", hex: "#84cc16" },
  { id: "amber", hex: "#f59e0b" },
  { id: "brown", hex: "#a16207" },
  { id: "slate", hex: "#94a3b8" },
] as const;

export type WorkspaceColorId = typeof WORKSPACE_COLORS[number]["id"] | `#${string}`;

export function normalizeWorkspaceColor(value: string): WorkspaceColorId {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase() as WorkspaceColorId;
  return WORKSPACE_COLORS.find(color => color.id === value)?.id ?? "gray";
}

export function getWorkspaceColor(id: WorkspaceColorId): string {
  const color = normalizeWorkspaceColor(id);
  return color.startsWith("#") ? color : WORKSPACE_COLORS.find(c => c.id === color)!.hex;
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

const COLOR_CYCLE: WorkspaceColorId[] = WORKSPACE_COLORS.filter(color => color.id !== "gray").map(color => color.id);
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
          color: color ? normalizeWorkspaceColor(color) : nextColor(),
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
            w.id === id ? { ...w, ...patch, ...(patch.color !== undefined ? { color: normalizeWorkspaceColor(patch.color) } : {}) } : w
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
