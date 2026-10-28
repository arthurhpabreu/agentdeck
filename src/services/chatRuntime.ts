import { refreshChatTurnStatus, useChatStore } from "../store/chatStore";

/** A lost final event must recover even when its conversation is not on screen. */
export function startChatRuntime() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const pending = new Set<string>();
  const check = () => {
    const now = Date.now();
    for (const [id, thread] of Object.entries(useChatStore.getState().threads)) {
      if (!thread.busy || pending.has(id) || now - (thread.lastHeartbeatAt ?? thread.lastEventAt ?? thread.turnStartedAt ?? now) < 30_000) continue;
      pending.add(id);
      void refreshChatTurnStatus(id).catch(() => {}).finally(() => pending.delete(id));
    }
  };
  const timer = setInterval(check, 15_000);
  window.addEventListener("focus", check);
  return () => { clearInterval(timer); window.removeEventListener("focus", check); };
}
