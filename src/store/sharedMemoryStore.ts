import { create } from "zustand";
import { memoryCommands, type MemoryConfiguration, type MemoryDraft, type MemoryRecord, type MemoryStatus, type MemoryScope } from "../services/memoryCommands";

export type MemoryFailedAction =
  | { type: "load"; query: string }
  | { type: "save"; draft: MemoryDraft }
  | { type: "pin"; id: string; pinned: boolean }
  | { type: "delete"; id: string }
  | { type: "configure"; patch: Partial<MemoryConfiguration> }
  | { type: "recall"; sessionId: string; provider: string };
interface ProjectMemory {
  status: MemoryStatus | null;
  records: MemoryRecord[];
  query: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  failedAction: MemoryFailedAction | null;
  updatedAt: number | null;
}
export const emptyProjectMemory: ProjectMemory = { status: null, records: [], query: "", loading: false, saving: false, error: null, failedAction: null, updatedAt: null };
interface SharedMemoryState {
  memoryTab: "memory" | "documents";
  setMemoryTab: (tab: "memory" | "documents") => void;
  memoryScope: MemoryScope;
  setMemoryScope: (scope: MemoryScope) => void;
  projects: Record<string, ProjectMemory>;
  load: (path: string, query?: string) => Promise<void>;
  save: (path: string, draft: MemoryDraft) => Promise<MemoryRecord | null>;
  setPinned: (path: string, id: string, pinned: boolean) => Promise<MemoryRecord | null>;
  clearError: (path: string) => void;
  remove: (path: string, id: string) => Promise<boolean>;
  configure: (path: string, configuration: MemoryConfiguration, retryPatch?: Partial<MemoryConfiguration>) => Promise<boolean>;
  resetSession: (path: string, sessionId: string, provider: string) => Promise<boolean>;
}

const requestVersions = new Map<string, number>();
/** Memory content stays in the native project database, never duplicated in localStorage. */
export const useSharedMemoryStore = create<SharedMemoryState>((set, get) => {
  const patch = (path: string, value: Partial<ProjectMemory>) => set(state => {
    const projects = { ...state.projects, [path]: { ...(state.projects[path] ?? emptyProjectMemory), ...value } };
    const oldPaths = Object.keys(projects).filter(key => key !== path && !projects[key].saving).sort((a, b) => (projects[a].updatedAt ?? 0) - (projects[b].updatedAt ?? 0));
    while (Object.keys(projects).length > 8 && oldPaths.length) delete projects[oldPaths.shift()!];
    return { projects };
  });
  const invalidateLoads = (path: string) => requestVersions.set(path, (requestVersions.get(path) ?? 0) + 1);
  return {
    memoryTab: "memory",
    setMemoryTab: memoryTab => set({ memoryTab }),
    memoryScope: "project",
    setMemoryScope: memoryScope => set({ memoryScope }),
    projects: {},
    clearError: path => patch(path, { error: null, failedAction: null }),
    load: async (path, query = "") => {
      if (!path || !("__TAURI_INTERNALS__" in window)) return;
      const version = (requestVersions.get(path) ?? 0) + 1;
      requestVersions.set(path, version);
      const previousFailure = get().projects[path]?.failedAction;
      patch(path, { loading: true, query, ...(!previousFailure || previousFailure.type === "load" ? { error: null, failedAction: null } : {}), ...(get().projects[path]?.query !== query ? { records: [] } : {}) });
      const [statusResult, listResult] = await Promise.allSettled([memoryCommands.status(path), memoryCommands.list(path, query)]);
      if (requestVersions.get(path) !== version) return;
      const update: Partial<ProjectMemory> = { loading: false, updatedAt: Date.now() };
      const errors: string[] = [];
      if (statusResult.status === "fulfilled" && statusResult.value && typeof statusResult.value.enabled === "boolean") update.status = statusResult.value;
      else errors.push(statusResult.status === "rejected" ? String(statusResult.reason) : "Invalid memory status");
      if (listResult.status === "fulfilled" && Array.isArray(listResult.value)) update.records = listResult.value;
      else errors.push(listResult.status === "rejected" ? String(listResult.reason) : "Invalid memory records");
      // A successful background read must not hide a failed write or its retry action.
      const currentFailure = get().projects[path]?.failedAction;
      if (!currentFailure || currentFailure.type === "load") {
        update.error = errors.length ? errors.join(" · ") : null;
        update.failedAction = errors.length ? { type: "load", query } : null;
      }
      patch(path, update);
    },
    save: async (path, draft) => {
      if (get().projects[path]?.saving) return null;
      invalidateLoads(path);
      patch(path, { saving: true, loading: false, error: null, failedAction: null });
      try {
        const record = await memoryCommands.save(path, draft);
        if (!record?.id) throw new Error("Memory record was not saved");
        await get().load(path, get().projects[path]?.query ?? "");
        return record;
      } catch (error) { patch(path, { error: String(error), failedAction: { type: "save", draft: { ...draft } } }); return null; }
      finally { patch(path, { saving: false }); }
    },
    setPinned: async (path, id, pinned) => {
      if (get().projects[path]?.saving) return null;
      invalidateLoads(path);
      patch(path, { saving: true, loading: false, error: null, failedAction: null });
      try {
        const record = await memoryCommands.setPinned(path, id, pinned);
        if (!record?.id) throw new Error("Memory pin state was not saved");
        await get().load(path, get().projects[path]?.query ?? "");
        return record;
      } catch (error) { patch(path, { error: String(error), failedAction: { type: "pin", id, pinned } }); return null; }
      finally { patch(path, { saving: false }); }
    },
    remove: async (path, id) => {
      if (get().projects[path]?.saving) return false;
      invalidateLoads(path);
      patch(path, { saving: true, loading: false, error: null, failedAction: null });
      try {
        await memoryCommands.delete(path, id);
        await get().load(path, get().projects[path]?.query ?? "");
        return true;
      } catch (error) { patch(path, { error: String(error), failedAction: { type: "delete", id } }); return false; }
      finally { patch(path, { saving: false }); }
    },
    configure: async (path, configuration, retryPatch = configuration) => {
      if (get().projects[path]?.saving) return false;
      invalidateLoads(path);
      patch(path, { saving: true, loading: false, error: null, failedAction: null });
      try {
        const status = await memoryCommands.configure(path, configuration);
        if (!status || typeof status.enabled !== "boolean") throw new Error("Memory settings were not saved");
        invalidateLoads(path);
        patch(path, { status, loading: false });
        return true;
      } catch (error) { patch(path, { error: String(error), failedAction: { type: "configure", patch: { ...retryPatch } } }); return false; }
      finally { patch(path, { saving: false }); }
    },
    resetSession: async (path, sessionId, provider) => {
      if (get().projects[path]?.saving) return false;
      invalidateLoads(path);
      patch(path, { saving: true, loading: false, error: null, failedAction: null });
      try { await memoryCommands.resetSession(path, sessionId, provider); return true; }
      catch (error) { patch(path, { error: String(error), failedAction: { type: "recall", sessionId, provider } }); return false; }
      finally { patch(path, { saving: false }); }
    },
  };
});
