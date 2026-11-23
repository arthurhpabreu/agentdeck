import { refreshChatTurnStatus, useChatStore } from "../store/chatStore";

/** A lost final event must recover even when its conversation is not on screen. */
export function startChatRuntime() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const check = (resumed: boolean) => {
    const now = Date.now();
    for (const [id, thread] of Object.entries(useChatStore.getState().threads)) {
      if (!thread.busy) continue;
      // Heartbeats prove the process is alive, but cannot confirm delivery of its output.
      const quietFor = now - (thread.lastEventAt ?? thread.turnStartedAt ?? now);
      if (resumed || thread.status === "finishing" || quietFor >= 15_000) {
        void refreshChatTurnStatus(id).catch(() => {});
      }
    }
  };
  const resume = () => { if (!document.hidden) check(true); };
  const timer = setInterval(() => check(false), 10_000);
  window.addEventListener("focus", resume);
  document.addEventListener("visibilitychange", resume);
  return () => {
    clearInterval(timer);
    window.removeEventListener("focus", resume);
    document.removeEventListener("visibilitychange", resume);
  };
}
