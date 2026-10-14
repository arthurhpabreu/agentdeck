import { expect, test } from "@playwright/test";
import { setupImprovements } from "./improvements-fixtures";

test("@macos replaced runner events cannot overwrite the new process or create false completions", async ({ page }) => {
  await setupImprovements(page);
  await expect.poll(() => page.evaluate(() => (window as any).__improvementCalls.filter((call: any) => call.command === "plugin:event|listen" && call.args.event === "runner-starting").length)).toBeGreaterThan(0);
  await page.evaluate(() => {
    const emit = (window as any).__emitImprovement;
    emit("runner-starting", { session_id: "session-0", run_id: "first" });
    emit("runner-started", { session_id: "session-0", run_id: "first", pid: 101 });
    emit("runner-starting", { session_id: "session-0", run_id: "replacement" });
    emit("runner-output", { session_id: "session-0", run_id: "first", line: "Stale output" });
    emit("diff-update", { session_id: "session-0", run_id: "first", files: [{ path: "old.ts" }] });
    emit("runner-done", { session_id: "session-0", run_id: "first", status: "completed" });
  });
  const snapshot = () => page.evaluate(async () => {
    const sessions = (await import("/src/store/sessionStore.ts" as string)).useSessionStore.getState();
    const attention = (await import("/src/store/attentionStore.ts" as string)).useAttentionStore.getState();
    return { session: sessions.sessions.find((session: any) => session.id === "session-0"), attention: attention.items };
  });
  await expect.poll(snapshot).toMatchObject({ session: { status: "running", output: [], diffFiles: [] }, attention: [] });
  expect((await snapshot()).session.pid).toBeUndefined();
  await page.evaluate(() => {
    const emit = (window as any).__emitImprovement;
    emit("runner-started", { session_id: "session-0", run_id: "replacement", pid: 202 });
    emit("runner-done", { session_id: "session-0", run_id: "replacement", status: "error" });
  });
  await expect.poll(snapshot).toMatchObject({ session: { status: "error" }, attention: [{ kind: "error" }] });
  expect((await snapshot()).session.pid).toBeUndefined();
  await page.evaluate(() => {
    const emit = (window as any).__emitImprovement;
    emit("runner-starting", { session_id: "session-0", run_id: "cancelled" });
    emit("runner-done", { session_id: "session-0", run_id: "cancelled", status: "stopped" });
  });
  await expect.poll(async () => (await snapshot()).session.status).toBe("suspended");
  expect((await snapshot()).attention.some((item: any) => item.kind === "completed")).toBe(false);
});
