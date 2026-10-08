import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

export type TokenEconomyScope = "global" | "project" | "agentdeck";
export interface TokenEconomyStatus {
  enabled: boolean;
  available: boolean;
  version?: string | null;
  totalInputTokens?: number | null;
  totalOutputTokens?: number | null;
  savedTokens?: number | null;
  savingsPercent?: number | null;
  commandCount?: number | null;
  scope: TokenEconomyScope;
  source: string;
  reason?: string | null;
  claudeHookAvailable: boolean;
  codexHookAvailable?: boolean;
  estimationMethod?: string;
  executablePath?: string | null;
  databasePath?: string | null;
  projectPath?: string | null;
}

interface Snapshot {
  status: TokenEconomyStatus | null;
  refreshing: boolean;
  error: string | null;
  checkedAt: number | null;
}
interface TokenEconomyState {
  entries: Record<string, Snapshot>;
  changing: boolean;
  refresh: (force?: boolean, workdir?: string, scope?: TokenEconomyScope) => Promise<void>;
  setEnabled: (enabled: boolean, workdir?: string, scope?: TokenEconomyScope) => Promise<void>;
}

const EMPTY: Snapshot = { status: null, refreshing: false, error: null, checkedAt: null };
const keyFor = (workdir: string | undefined, scope: TokenEconomyScope) => scope === "project" ? `project:${workdir || ""}` : scope;
const requests = new Map<string, number>();
function validStatus(value: unknown): value is TokenEconomyStatus {
  return !!value && typeof value === "object" && typeof (value as TokenEconomyStatus).enabled === "boolean" && typeof (value as TokenEconomyStatus).available === "boolean";
}

/** Each scope has its own cache, so switching projects never reuses another project's counts. */
export const useTokenEconomyStore = create<TokenEconomyState>((set, get) => {
  const patch = (key: string, next: Partial<Snapshot>) => set(state => ({ entries: { ...state.entries, [key]: { ...(state.entries[key] || EMPTY), ...next } } }));
  return {
    entries: {}, changing: false,
    refresh: async (force = false, workdir, scope = "agentdeck") => {
      const key = keyFor(workdir, scope);
      const cached = get().entries[key] || EMPTY;
      if (!("__TAURI_INTERNALS__" in window) || cached.refreshing || get().changing) return;
      if (!force && cached.checkedAt && Date.now() - cached.checkedAt < 30_000) return;
      const version = (requests.get(key) || 0) + 1;
      requests.set(key, version);
      patch(key, { refreshing: true });
      try {
        const status = await invoke<TokenEconomyStatus>("get_token_economy_status", { workdir, scope, force });
        if (!validStatus(status)) throw new Error("Invalid token economy status");
        if (version === requests.get(key)) patch(key, { status, error: null, checkedAt: Date.now() });
      } catch (error) {
        if (version === requests.get(key)) patch(key, { error: String(error), checkedAt: Date.now() });
      } finally {
        if (version === requests.get(key)) patch(key, { refreshing: false });
      }
    },
    setEnabled: async (enabled, workdir, scope = "agentdeck") => {
      if (!("__TAURI_INTERNALS__" in window) || get().changing) return;
      const key = keyFor(workdir, scope);
      // Retire in-flight reads so an old setting cannot overwrite a successful save.
      for (const [requestKey, version] of requests) requests.set(requestKey, version + 1);
      set(state => ({ changing: true, entries: Object.fromEntries(Object.entries(state.entries).map(([entryKey, entry]) => [entryKey, { ...entry, refreshing: false }])) }));
      try {
        const status = await invoke<TokenEconomyStatus>("set_token_economy_enabled", { enabled, workdir, scope });
        if (!validStatus(status)) throw new Error("Invalid token economy status");
        set(state => ({ entries: Object.fromEntries(Object.entries(state.entries).map(([entryKey, entry]) => [entryKey, { ...entry, status: entry.status ? { ...entry.status, enabled: status.enabled } : null }])) }));
        patch(key, { status, error: null, checkedAt: Date.now() });
      } catch (error) {
        patch(key, { error: String(error) });
      } finally { set({ changing: false }); }
    },
  };
});

const consumers = new Map<string, { count: number; workdir?: string; scope: TokenEconomyScope }>();
let stopPolling: (() => void) | undefined;

/** One timer services visible scopes, including split views of different projects. */
export function useTokenEconomy(visible = true, workdir?: string, scope: TokenEconomyScope = "agentdeck") {
  const key = keyFor(workdir, scope);
  const snapshot = useTokenEconomyStore(state => state.entries[key] || EMPTY);
  const changing = useTokenEconomyStore(state => state.changing);
  const refresh = useTokenEconomyStore(state => state.refresh);
  const setEnabled = useTokenEconomyStore(state => state.setEnabled);
  useEffect(() => {
    if (!visible) return;
    const consumer = consumers.get(key);
    consumers.set(key, { count: (consumer?.count || 0) + 1, workdir, scope });
    void refresh(false, workdir, scope);
    if (!stopPolling) {
      const refreshVisible = () => {
        if (!document.hidden) for (const current of consumers.values()) void useTokenEconomyStore.getState().refresh(false, current.workdir, current.scope);
      };
      const timer = window.setInterval(refreshVisible, 60_000);
      document.addEventListener("visibilitychange", refreshVisible);
      let disposed = false;
      let unlisten: (() => void) | undefined;
      if ("__TAURI_INTERNALS__" in window) void listen<{ enabled: boolean }>("token-economy-changed", ({ payload }) => {
        useTokenEconomyStore.setState(state => ({ entries: Object.fromEntries(Object.entries(state.entries).map(([entryKey, entry]) => [entryKey, { ...entry, status: entry.status ? { ...entry.status, enabled: payload.enabled } : null, checkedAt: null }])) }));
      }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => {});
      stopPolling = () => { disposed = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", refreshVisible); unlisten?.(); };
    }
    return () => {
      const current = consumers.get(key);
      if (current && current.count > 1) current.count -= 1;
      else consumers.delete(key);
      if (!consumers.size) { stopPolling?.(); stopPolling = undefined; }
    };
  }, [key, visible, workdir, scope, refresh]);
  return { ...snapshot, changing, refresh, setEnabled };
}

export function hasEconomyMeasurements(status: TokenEconomyStatus | null): boolean {
  return !!status && typeof status.commandCount === "number" && Number.isFinite(status.commandCount) && status.commandCount >= 0
    && [status.totalInputTokens, status.totalOutputTokens, status.savedTokens, status.savingsPercent].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)
    && status.savingsPercent! <= 100 && status.savedTokens! <= status.totalInputTokens!;
}
