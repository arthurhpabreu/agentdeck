import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { RunnerType } from "./settingsStore";

export interface MultiAgentRole { model: string; label: string; effort?: string }
export interface MultiAgentProfile {
  coordinator: MultiAgentRole;
  explorer: MultiAgentRole;
  advisor: MultiAgentRole;
  advisorMode: "native" | "subagent";
}
export interface MultiAgentStatus {
  enabled: boolean;
  available: boolean;
  profile?: MultiAgentProfile | null;
  reason?: "unsupported_provider" | "models_unavailable" | "cli_update_required" | null;
}
export interface MultiAgentContext { runnerType: RunnerType; cliPath?: string; workdir?: string; model?: string; effort?: string }
interface Snapshot { status: MultiAgentStatus | null; refreshing: boolean; error: string | null; checkedAt: number | null }
interface MultiAgentEconomyState {
  entries: Record<string, Snapshot>;
  enabled?: boolean;
  enabledCheckedAt: number | null;
  loadingEnabled: boolean;
  changing: boolean;
  saveError: string | null;
  loadEnabled: () => Promise<void>;
  refresh: (context: MultiAgentContext, force?: boolean) => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
}
const EMPTY: Snapshot = { status: null, refreshing: false, error: null, checkedAt: null };
const requests = new Map<string, number>();
const consumers = new Map<string, { count: number; context: MultiAgentContext }>();
let stopListening: (() => void) | undefined;
let listenerGeneration = 0;
let enabledConsumers = 0;
let settingRevision = 0;
let enabledRequest = 0;
const keyFor = ({ runnerType, cliPath, workdir, model, effort }: MultiAgentContext) => JSON.stringify([runnerType, cliPath || "", workdir || "", model || "default", effort || ""]);
function validStatus(value: unknown): value is MultiAgentStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as MultiAgentStatus;
  if (typeof status.enabled !== "boolean" || typeof status.available !== "boolean") return false;
  if (!status.available && !status.profile) return true;
  const role = (value: MultiAgentRole | undefined) => !!value && typeof value.model === "string" && !!value.model.trim()
    && typeof value.label === "string" && !!value.label.trim() && (value.effort === undefined || typeof value.effort === "string");
  return !!status.profile && role(status.profile.coordinator) && role(status.profile.explorer) && role(status.profile.advisor)
    && ["native", "subagent"].includes(status.profile.advisorMode);
}

/** Capability caches are scoped to the actual CLI; the saved switch is global. */
export const useMultiAgentEconomyStore = create<MultiAgentEconomyState>((set, get) => {
  const patch = (key: string, next: Partial<Snapshot>) => set(state => ({ entries: { ...state.entries, [key]: { ...(state.entries[key] || EMPTY), ...next } } }));
  return {
    entries: {}, enabledCheckedAt: null, loadingEnabled: false, changing: false, saveError: null,
    loadEnabled: async () => {
      const cached = get();
      if (!("__TAURI_INTERNALS__" in window) || cached.loadingEnabled || cached.changing) return;
      if (cached.enabledCheckedAt !== null && Date.now() - cached.enabledCheckedAt < 30_000) return;
      const version = ++enabledRequest, revision = settingRevision;
      set({ loadingEnabled: true });
      try {
        const enabled = await invoke<boolean>("get_multi_agent_enabled");
        if (typeof enabled !== "boolean") throw new Error("Invalid multi-agent setting");
        if (version === enabledRequest && revision === settingRevision) set(state => ({ enabled, enabledCheckedAt: Date.now(), entries: Object.fromEntries(Object.entries(state.entries).map(([key, entry]) => [key, { ...entry, status: entry.status ? { ...entry.status, enabled } : null }])) }));
      } catch {
        if (version === enabledRequest && revision === settingRevision) set({ enabledCheckedAt: Date.now() });
      } finally {
        if (version === enabledRequest) set({ loadingEnabled: false });
      }
    },
    refresh: async (context, force = false) => {
      const key = keyFor(context), cached = get().entries[key] || EMPTY;
      if (!("__TAURI_INTERNALS__" in window) || cached.refreshing || get().changing) return;
      if (!force && cached.checkedAt !== null && Date.now() - cached.checkedAt < 30_000) return;
      const version = (requests.get(key) || 0) + 1, revision = settingRevision;
      requests.set(key, version);
      patch(key, { refreshing: true });
      try {
        const status = await invoke<MultiAgentStatus>("get_multi_agent_status", { ...context, force });
        if (!validStatus(status)) throw new Error("Invalid multi-agent status");
        if (version === requests.get(key) && revision === settingRevision) {
          enabledRequest++;
          set(state => ({ enabled: status.enabled, enabledCheckedAt: Date.now(), loadingEnabled: false, entries: Object.fromEntries(Object.entries(state.entries).map(([entryKey, entry]) => [entryKey, { ...entry, status: entry.status ? { ...entry.status, enabled: status.enabled } : null }])) }));
          patch(key, { status, error: null, checkedAt: Date.now() });
        }
      } catch (error) {
        if (version === requests.get(key) && revision === settingRevision) patch(key, { error: String(error), checkedAt: Date.now() });
      } finally {
        if (version === requests.get(key)) patch(key, { refreshing: false });
      }
    },
    setEnabled: async enabled => {
      if (!("__TAURI_INTERNALS__" in window) || get().changing) return;
      settingRevision++;
      enabledRequest++;
      for (const [key, version] of requests) requests.set(key, version + 1);
      set(state => ({ changing: true, loadingEnabled: false, saveError: null, entries: Object.fromEntries(Object.entries(state.entries).map(([key, entry]) => [key, { ...entry, refreshing: false }])) }));
      try {
        const saved = await invoke<boolean>("set_multi_agent_enabled", { enabled });
        if (typeof saved !== "boolean") throw new Error("Invalid multi-agent setting");
        set(state => ({ enabled: saved, enabledCheckedAt: Date.now(), entries: Object.fromEntries(Object.entries(state.entries).map(([key, entry]) => [key, { ...entry, status: entry.status ? { ...entry.status, enabled: saved } : null }])) }));
      } catch (error) { set({ saveError: String(error) }); }
      finally {
        set({ changing: false });
        for (const [key, consumer] of consumers) if (!get().entries[key]?.status) void get().refresh(consumer.context);
      }
    },
  };
});

/** Share the cheap setting event while either the badge or a profile is visible. */
export function observeMultiAgentEnabled() {
  if (!("__TAURI_INTERNALS__" in window)) return () => {};
  if (++enabledConsumers === 1) {
    const generation = ++listenerGeneration;
    void listen<{ enabled: boolean }>("multi-agent-economy-changed", ({ payload }) => {
      if (typeof payload?.enabled !== "boolean") return;
      settingRevision++;
      enabledRequest++;
      for (const [key, version] of requests) requests.set(key, version + 1);
      useMultiAgentEconomyStore.setState(state => ({ enabled: payload.enabled, enabledCheckedAt: Date.now(), loadingEnabled: false, saveError: null, entries: Object.fromEntries(Object.entries(state.entries).map(([entryKey, entry]) => [entryKey, { ...entry, refreshing: false, status: entry.status ? { ...entry.status, enabled: payload.enabled } : null }])) }));
      for (const [key, consumer] of consumers) if (!useMultiAgentEconomyStore.getState().entries[key]?.status) void useMultiAgentEconomyStore.getState().refresh(consumer.context);
    }).then(stop => { if (generation !== listenerGeneration || !enabledConsumers) stop(); else stopListening = stop; }).catch(() => {});
  }
  return () => {
    if (--enabledConsumers === 0) { listenerGeneration++; stopListening?.(); stopListening = undefined; }
  };
}

export function useMultiAgentEconomy(context: MultiAgentContext) {
  const key = keyFor(context);
  const snapshot = useMultiAgentEconomyStore(state => state.entries[key] || EMPTY);
  const enabled = useMultiAgentEconomyStore(state => state.enabled);
  const changing = useMultiAgentEconomyStore(state => state.changing);
  const saveError = useMultiAgentEconomyStore(state => state.saveError);
  const refresh = useMultiAgentEconomyStore(state => state.refresh);
  const setEnabled = useMultiAgentEconomyStore(state => state.setEnabled);
  useEffect(() => {
    const current = { runnerType: context.runnerType, cliPath: context.cliPath, workdir: context.workdir, model: context.model, effort: context.effort };
    const existing = consumers.get(key);
    consumers.set(key, { count: (existing?.count || 0) + 1, context: current });
    const stopObserving = observeMultiAgentEnabled();
    void refresh(current);
    return () => {
      const consumer = consumers.get(key);
      if (consumer && consumer.count > 1) consumer.count--;
      else consumers.delete(key);
      stopObserving();
    };
  }, [key, context.runnerType, context.cliPath, context.workdir, context.model, context.effort, refresh]);
  return { ...snapshot, enabled, changing, saveError, refresh, setEnabled };
}
