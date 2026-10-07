import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore, type RunnerType } from "./settingsStore";
import { clearAgentModels, loadAgentModels } from "../services/agentExecution";

export interface CliUpdate { provider: RunnerType; installed: string | null; latest: string | null; updateAvailable: boolean; method: "npm" | "native" | "manual"; executable: string; error: string | null }
interface Entry { result?: CliUpdate; checking?: boolean; updating?: boolean; error?: string; checkedAt?: number; updated?: boolean }
export const useCliUpdateStore = create<{ entries: Record<string, Entry>; revision: number }>(() => ({ entries: {}, revision: 0 }));
function patch(provider: string, value: Partial<Entry>) { useCliUpdateStore.setState(state => ({ entries: { ...state.entries, [provider]: { ...state.entries[provider], ...value } } })); }
const cliPath = (provider: RunnerType) => useSettingsStore.getState().getRunnerConfigForType(provider).cliPath || "";
export async function checkCliUpdate(provider: RunnerType) {
  const entries = useCliUpdateStore.getState().entries;
  if (entries[provider]?.checking || Object.values(entries).some(entry => entry.updating)) return;
  patch(provider, { checking: true, error: undefined });
  try { const result = await invoke<CliUpdate>("check_cli_update", { provider, cliPath: cliPath(provider) }); if (result) patch(provider, { result, error: result.error || undefined, checkedAt: Date.now() }); }
  catch (error) { patch(provider, { error: String(error) }); }
  finally { patch(provider, { checking: false }); }
}
let started = false;
export function checkCliUpdatesOnStartup() {
  if (started || !("__TAURI_INTERNALS__" in window)) return;
  started = true;
  void Promise.allSettled((["claude-code", "codex", "gemini"] as const).map(checkCliUpdate));
}
export async function updateCli(provider: RunnerType) {
  if (Object.values(useCliUpdateStore.getState().entries).some(entry => entry.updating || entry.checking)) return;
  patch(provider, { updating: true, error: undefined, updated: false });
  try {
    const result = await invoke<CliUpdate>("update_agent_cli", { provider, cliPath: cliPath(provider) });
    patch(provider, { result, error: result?.error || undefined, checkedAt: Date.now(), updated: true });
    clearAgentModels(provider);
    try { await loadAgentModels(provider, cliPath(provider), true); } catch { patch(provider, { error: "catalogue_unavailable" }); }
    useCliUpdateStore.setState(state => ({ revision: state.revision + 1 }));
  } catch (error) { patch(provider, { error: String(error) }); }
  finally { patch(provider, { updating: false }); }
}
