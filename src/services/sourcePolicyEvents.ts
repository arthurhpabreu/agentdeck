import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const subscribers = new Set<() => void>();
let nativeUnlisten: UnlistenFn | undefined;
let initializing: Promise<void> | undefined;
let queued = false;

export function notifySourcePolicyChange() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    window.dispatchEvent(new Event("agentdeck-source-policy-changed"));
  });
}
/** One native subscription bridges changes from every window into local cache invalidation. */
export function subscribeSourcePolicyChanges(listener: () => void) {
  subscribers.add(listener);
  window.addEventListener("agentdeck-source-policy-changed", listener);
  if (!initializing && !nativeUnlisten && "__TAURI_INTERNALS__" in window) {
    initializing = listen("knowledge-policy-changed", notifySourcePolicyChange).then(unlisten => {
      if (subscribers.size) nativeUnlisten = unlisten; else unlisten();
    }).catch(() => {}).finally(() => { initializing = undefined; });
  }
  return () => {
    subscribers.delete(listener);
    window.removeEventListener("agentdeck-source-policy-changed", listener);
    if (!subscribers.size) { nativeUnlisten?.(); nativeUnlisten = undefined; }
  };
}
