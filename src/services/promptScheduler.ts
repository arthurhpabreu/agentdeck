import { chatHistoryReady, chatSessionIdentity, sendChatTurn, useChatStore } from "../store/chatStore";
import { useSessionStore, type ClaudeSession } from "../store/sessionStore";
import { usePtyRuntimeStore } from "../store/ptyRuntimeStore";
import { usePromptScheduleStore } from "../store/promptScheduleStore";
import { nextScheduleRun } from "./promptScheduleTime";
import { chatInputError } from "./chatInput";

export const scheduledSessionIdentity = (session: ClaudeSession) => JSON.stringify([session.workspaceId, session.workdir, session.worktreePath ?? "", session.runner.type]);
// Late or sleeping machines get a bounded window, never a burst of past prompts.
const LATE_WINDOW = 15 * 60_000;
let ticking = false;
export async function runDuePromptSchedules(now = Date.now()) {
  if (ticking || !useChatStore.getState().historyReady) return;
  ticking = true;
  try {
    const sessions = new Map(useSessionStore.getState().sessions.map(session => [session.id, session]));
    for (const id of usePromptScheduleStore.getState().schedules.map(schedule => schedule.id)) {
      const schedule = usePromptScheduleStore.getState().schedules.find(item => item.id === id);
      if (!schedule?.enabled) continue;
      const store = usePromptScheduleStore.getState(), due = schedule.nextRunAt;
      const session = sessions.get(schedule.sessionId);
      if (!session || scheduledSessionIdentity(session) !== schedule.identity || session.runner.type === "gemini") {
        store.update(schedule.id, { enabled: false, lastResult: "failed", error: "destination" }); continue;
      }
      if (due === undefined || due > now) continue;
      if (chatInputError(schedule.prompt)) { store.update(schedule.id, { enabled: false, lastResult: "failed", error: "launch" }); continue; }
      if (now - due > LATE_WINDOW) {
        store.update(schedule.id, { nextRunAt: nextScheduleRun(schedule, now), lastRunAt: due, lastResult: "missed", error: undefined }); continue;
      }
      if (useChatStore.getState().threads[session.id]?.busy || usePtyRuntimeStore.getState().sessions[session.id]
        || !useSessionStore.getState().worktreeReadyIds.has(session.id)) continue;
      // Commit the occurrence before launching. Failures require an explicit retry;
      // restarting the app must not execute an unconfirmed task twice.
      store.update(schedule.id, { nextRunAt: nextScheduleRun(schedule, now), lastRunAt: due, lastResult: "started", error: undefined });
      try {
        const sent = await sendChatTurn(session.id, schedule.prompt, [], { preserveDraft: true, requireIdle: true, expectedIdentity: chatSessionIdentity(session) });
        if (!sent) store.update(schedule.id, { lastResult: "failed", error: "launch" });
      } catch {
        store.update(schedule.id, { lastResult: "failed", error: "launch" });
      }
    }
  } finally { ticking = false; }
}
export function startPromptScheduler() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  let disposed = false;
  const tick = () => { if (!disposed) void runDuePromptSchedules().catch(() => {}); };
  void Promise.all([chatHistoryReady, usePromptScheduleStore.persist.rehydrate()]).then(tick);
  const timer = setInterval(tick, 15_000);
  const unsubscribe = useSessionStore.subscribe((state, previous) => {
    if (state.sessions === previous.sessions) return;
    const ids = new Set(state.sessions.map(session => session.id));
    const removed = new Set(previous.sessions.filter(session => !ids.has(session.id)).map(session => session.id));
    for (const schedule of usePromptScheduleStore.getState().schedules) if (removed.has(schedule.sessionId)) usePromptScheduleStore.getState().remove(schedule.id);
  });
  window.addEventListener("focus", tick);
  return () => { disposed = true; clearInterval(timer); unsubscribe(); window.removeEventListener("focus", tick); };
}
