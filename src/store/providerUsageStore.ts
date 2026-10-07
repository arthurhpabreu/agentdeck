import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";

export type UsageProvider = "codex" | "claude-code";
export type UsageReason = "missing-login" | "expired-login" | "authentication" | "rate-limited" | "network" | "unsupported" | "read-error" | "unavailable";
export interface UsageWindow {
  key: string;
  used_percent: number;
  window_minutes: number | null;
  resets_at: number | null;
  observed_at?: string | null;
}
export interface ProviderUsage {
  provider: UsageProvider;
  status: "ready" | "unavailable" | "error";
  windows: UsageWindow[];
  observed_at: string | null;
  source: string;
  reason?: UsageReason | null;
  retry_at?: number | null;
}
interface UsageState {
  providers: ProviderUsage[];
  refreshing: boolean;
  checkedAt: number | null;
  refresh: (force?: boolean) => Promise<void>;
}

export const USAGE_PROVIDERS: UsageProvider[] = ["codex", "claude-code"];
const emptyUsage = (provider: UsageProvider): ProviderUsage => ({ provider, status: "unavailable", windows: [], observed_at: null, source: "", reason: "unavailable" });

/** The backend decides whether a reading still belongs to the current account. */
function normalizeUsage(value: ProviderUsage): ProviderUsage {
  return {
    ...value,
    retry_at: validTimestamp(value.retry_at),
    windows: Array.isArray(value.windows) ? value.windows
      .filter(window => window != null && typeof window.key === "string" && window.key.length > 0 && Number.isFinite(window.used_percent) && window.used_percent >= 0)
      .map(window => ({ ...window, resets_at: validTimestamp(window.resets_at) })) : [],
  };
}

function validTimestamp(seconds: number | null | undefined): number | null {
  return typeof seconds === "number" && seconds > 0 && Number.isFinite(new Date(seconds * 1000).getTime()) ? seconds : null;
}

export const useProviderUsageStore = create<UsageState>((set, get) => ({
  providers: USAGE_PROVIDERS.map(emptyUsage),
  refreshing: false,
  checkedAt: null,
  refresh: async (force = false) => {
    if (get().refreshing) return;
    if (!("__TAURI_INTERNALS__" in window)) {
      set({ checkedAt: Date.now() });
      return;
    }
    set({ refreshing: true });
    try {
      const result = await invoke<ProviderUsage[]>("get_provider_usage", { force });
      if (!Array.isArray(result)) throw new Error("Invalid provider usage response");
      set({ providers: USAGE_PROVIDERS.map((provider) => normalizeUsage(result.find((item) => item.provider === provider) ?? emptyUsage(provider))), checkedAt: Date.now() });
    } catch {
      // Keep the last real values on a read error, visibly marked as such.
      set({ providers: get().providers.map((provider) => ({ ...provider, status: "error", reason: "read-error" })), checkedAt: Date.now() });
    } finally {
      set({ refreshing: false });
    }
  },
}));

let consumers = 0;
let stopPolling: (() => void) | undefined;

/** One timer and one native listener shared by the footer and optional widget. */
export function useProviderUsage() {
  const state = useProviderUsageStore();
  useEffect(() => {
    consumers += 1;
    if (consumers === 1) {
      let disposed = false;
      let unlisten: UnlistenFn | undefined;
      const refresh = () => {
        if (document.visibilityState !== "hidden") void useProviderUsageStore.getState().refresh();
      };
      refresh();
      const timer = window.setInterval(refresh, 60_000);
      document.addEventListener("visibilitychange", refresh);
      window.addEventListener("focus", refresh);
      if ("__TAURI_INTERNALS__" in window) {
        void listen("provider-usage-updated", refresh).then((off) => { if (disposed) off(); else unlisten = off; }).catch(() => {});
      }
      stopPolling = () => {
        disposed = true;
        window.clearInterval(timer);
        document.removeEventListener("visibilitychange", refresh);
        window.removeEventListener("focus", refresh);
        unlisten?.();
      };
    }
    return () => {
      consumers -= 1;
      if (consumers === 0) { stopPolling?.(); stopPolling = undefined; }
    };
  }, []);
  return state;
}

export function usageObservedAt(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(new Date(parsed).getTime()) ? parsed : null;
}

export function isUsageWindowStale(window: UsageWindow, provider: ProviderUsage, now = Date.now()): boolean {
  const observedAt = usageObservedAt(window.observed_at ?? provider.observed_at);
  return !observedAt || now - observedAt > 15 * 60_000 || (window.resets_at != null && window.resets_at * 1000 <= now);
}
