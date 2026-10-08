import { create } from "zustand";
import { persist } from "zustand/middleware";

interface RecoveryNotice { workdir: string; path: string; message: string }
export function recoveryPathKey(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}
export function uniqueRecoveryPaths(paths: string[]) {
  const seen = new Set<string>();
  return paths.filter(path => { const key = recoveryPathKey(path); if (seen.has(key)) return false; seen.add(key); return true; });
}
export const useWorktreeRecoveryStore = create<{
  repositories: string[]; notices: RecoveryNotice[];
  remember: (workdir: string) => void;
  preserved: (workdir: string, path: string, message: string) => void;
  resolved: (path: string) => void;
}>()(persist(set => ({
  repositories: [], notices: [],
  remember: workdir => set(state => ({ repositories: uniqueRecoveryPaths([workdir, ...state.repositories]).slice(0, 100) })),
  preserved: (workdir, path, message) => set(state => ({ repositories: uniqueRecoveryPaths([workdir, ...state.repositories]).slice(0, 100), notices: [...state.notices.filter(notice => recoveryPathKey(notice.path) !== recoveryPathKey(path)), { workdir, path, message }] })),
  resolved: path => set(state => ({ notices: state.notices.filter(notice => recoveryPathKey(notice.path) !== recoveryPathKey(path)) })),
}), { name: "agentdeck-worktree-recovery" }));
