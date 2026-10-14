import { test, expect, type Page } from "@playwright/test";

export function performanceUiCases(setup: (page: Page, locale?: string) => Promise<void>, openSession: (page: Page) => Promise<void>) {
  test("inactive chat views stay bounded and retain each conversation draft after eviction", async ({ page }) => {
    await setup(page); await openSession(page);
    await page.evaluate(async () => {
      const sessionPath = "/src/store/sessionStore.ts", chatPath = "/src/store/chatStore.ts";
      const { useSessionStore } = await import(/* @vite-ignore */ sessionPath), { useChatStore } = await import(/* @vite-ignore */ chatPath);
      const original = useSessionStore.getState().sessions[0];
      const extra = Array.from({ length: 7 }, (_, i) => ({ ...original, id: `cache-${i}`, name: `Cache chat ${i}`, createdAt: i + 2 }));
      useSessionStore.setState(state => ({ sessions: [...state.sessions, ...extra], worktreeReadyIds: new Set([...state.worktreeReadyIds, ...extra.map(item => item.id)]) }));
      for (const session of extra) useChatStore.getState().patch(session.id, { draft: `Draft preserved ${session.id}` });
    });
    await page.locator(".ad-chat-composer textarea:visible").fill("Original draft survives seven chats");
    for (let i = 0; i < 7; i++) {
      await page.getByText(`Cache chat ${i}`, { exact: true }).first().click();
      await expect(page.locator(".ad-chat-composer textarea:visible")).toHaveValue(`Draft preserved cache-${i}`);
      expect(await page.locator(".ad-session-tabs").count()).toBeLessThanOrEqual(4);
    }
    await page.getByText("Implementation", { exact: true }).first().click();
    await expect(page.locator(".ad-chat-composer textarea:visible")).toHaveValue("Original draft survives seven chats");
    expect(await page.locator(".ad-session-tabs").count()).toBeLessThanOrEqual(4);
  });

  test("terminal renderer eviction preserves its process and reattaches without resending a prompt", async ({ page }) => {
    await setup(page, "en");
    await page.getByRole("button", { name: "Expand terminal", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Terminal", exact: true });
    await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((call: any) => call.command === "start_pty_session").length)).toBe(1);
    const original = await page.evaluate(() => (window as any).__calls.find((call: any) => call.command === "start_pty_session").args.sessionId);
    for (let i = 0; i < 5; i++) {
      await panel.getByRole("button", { name: "Create terminal tab", exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((call: any) => call.command === "start_pty_session").length)).toBe(i + 2);
    }
    expect(await panel.locator(".ci-pty-terminal").count()).toBeLessThanOrEqual(4);
    await panel.getByRole("tab", { name: "Terminal 1", exact: true }).click();
    await expect(panel.locator(".ci-pty-terminal:visible")).toHaveCount(1);
    await page.waitForTimeout(400);
    const calls = await page.evaluate(id => (window as any).__calls.filter((call: any) => call.args.sessionId === id), original);
    expect(calls.filter((call: any) => call.command === "start_pty_session")).toHaveLength(1);
    expect(calls.filter((call: any) => call.command === "stop_pty_session")).toHaveLength(0);
    expect(await page.evaluate(() => (window as any).__calls.filter((call: any) => call.command === "plugin:event|listen" && call.args.event === "pty-data").length)).toBe(1);
  });
}
