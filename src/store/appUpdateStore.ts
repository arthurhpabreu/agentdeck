import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface AppUpdateInfo { installed: string; latest: string; updateAvailable: boolean; supported: boolean; installerKind: "exe" | "msi" }
interface DownloadedUpdate { version: string; filename: string }
interface AppUpdateRuntime { result?: AppUpdateInfo; checking: boolean; downloading: boolean; installing: boolean; downloaded?: DownloadedUpdate; installerOpened: boolean; error?: string }
export const useAppUpdateStore = create<AppUpdateRuntime>(() => ({ checking: false, downloading: false, installing: false, installerOpened: false }));
let startupChecked = false;
export function checkAppUpdateOnStartup() {
  if (startupChecked || !("__TAURI_INTERNALS__" in window)) return;
  startupChecked = true;
  void checkAppUpdate();
}
export async function checkAppUpdate() {
  const state = useAppUpdateStore.getState();
  if (state.checking || state.downloading || state.installing) return;
  useAppUpdateStore.setState({ checking: true, error: undefined });
  try {
    const result = await invoke<AppUpdateInfo>("check_app_update");
    if (result) useAppUpdateStore.setState(current => ({ result,
      ...(current.downloaded && current.downloaded.version !== result.latest ? { downloaded: undefined, installerOpened: false } : {}) }));
  } catch (error) { useAppUpdateStore.setState({ error: String(error) }); }
  finally { useAppUpdateStore.setState({ checking: false }); }
}
export async function downloadAppUpdate() {
  const state = useAppUpdateStore.getState();
  if (state.checking || state.downloading || state.installing || !state.result?.updateAvailable || !state.result.supported || state.downloaded) return;
  useAppUpdateStore.setState({ downloading: true, error: undefined, installerOpened: false });
  try {
    const downloaded = await invoke<DownloadedUpdate>("download_app_update");
    if (!downloaded?.filename) throw new Error("download_failed");
    useAppUpdateStore.setState(current => ({ downloaded, result: current.result ? { ...current.result, latest: downloaded.version } : undefined }));
  } catch (error) { useAppUpdateStore.setState({ error: String(error) }); }
  finally { useAppUpdateStore.setState({ downloading: false }); }
}
export async function installAppUpdate() {
  const state = useAppUpdateStore.getState();
  if (!state.downloaded || state.downloading || state.installing || state.installerOpened) return;
  useAppUpdateStore.setState({ installing: true, error: undefined });
  try { await invoke("install_app_update"); useAppUpdateStore.setState({ installerOpened: true }); }
  catch (error) {
    const message = String(error);
    useAppUpdateStore.setState({ error: message, ...(/checksum|installer_invalid|installer_unavailable/.test(message) ? { downloaded: undefined } : {}) });
  }
  finally { useAppUpdateStore.setState({ installing: false }); }
}
