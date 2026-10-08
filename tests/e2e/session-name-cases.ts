import { test, expect, type Page } from "@playwright/test";

export function sessionNameCases(setup: (page: Page, locale?: string) => Promise<void>, openSession: (page: Page) => Promise<void>) {
  const dialog = (page: Page) => page.getByRole("dialog", { name: "Renomear sessão", exact: true });
  const session = (page: Page) => page.evaluate(async () => {
    const path = "/src/store/sessionStore.ts";
    return (await import(/* @vite-ignore */ path)).useSessionStore.getState().sessions.find((s: any) => s.id === "session");
  });
  async function rename(page: Page, name: string) {
    await page.locator(".ad-session-tabs").getByRole("button", { name: "Renomear sessão", exact: true }).click();
    await dialog(page).getByRole("textbox", { name: "Nome da sessão", exact: true }).fill(name);
    await dialog(page).getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
  }

  test("sidebar rename supports validation, cancellation, persistence and recovery without changing identity", async ({ page }) => {
    await setup(page);
    const original = await session(page);
    await page.getByText("Implementation", { exact: true }).first().hover();
    await page.getByRole("button", { name: "Renomear sessão", exact: true }).first().click();
    const name = dialog(page).getByRole("textbox", { name: "Nome da sessão", exact: true });
    await expect(name).toBeFocused();
    await expect(name).toHaveValue("Implementation");
    await expect(name).toHaveAttribute("maxlength", "120");
    await name.fill("   ");
    await expect(dialog(page).getByRole("button", { name: "Salvar", exact: true })).toBeDisabled();
    await name.fill("Discard this name");
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    expect((await session(page)).name).toBe("Implementation");
    await expect(page.getByRole("button", { name: "Renomear sessão", exact: true }).first()).toBeFocused();
    await page.keyboard.press("Enter");
    await dialog(page).getByRole("textbox").fill("  Revisão   da memória 🚀  ");
    await dialog(page).getByRole("textbox").press("Enter");
    await expect(dialog(page)).toHaveCount(0);
    const renamed = await session(page);
    expect(renamed).toEqual({ ...original, name: "Revisão da memória 🚀", nameIsCustom: true });
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => ["start_chat_turn", "start_pty_session"].includes(c.command)))).toHaveLength(0);
    await page.reload();
    await expect(page.getByText("Revisão da memória 🚀", { exact: true }).first()).toBeVisible();
    await page.evaluate(async () => {
      const path = "/src/store/sessionStore.ts";
      const store = (await import(/* @vite-ignore */ path)).useSessionStore;
      const current = store.getState().sessions[0];
      store.getState().mergeRecoveredSessions([{ ...current, name: "Recovered task", nameIsCustom: undefined }]);
      store.getState().setAutomaticSessionName(current.id, "New automatic task");
    });
    expect((await session(page)).name).toBe("Revisão da memória 🚀");
    const mirror = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "save_ui_state" && c.args.key === "agentdeck-sessions").at(-1)?.args.value);
    expect(JSON.parse(mirror).state.sessions[0]).toMatchObject({ name: "Revisão da memória 🚀", nameIsCustom: true });
  });

  test("custom names survive the first chat message and can change while the same conversation is running", async ({ page }) => {
    await setup(page); await openSession(page);
    await rename(page, "API review");
    await page.locator(".ad-chat-composer textarea").fill("Review this project architecture");
    await page.locator(".ad-chat-composer textarea").press("Enter");
    await expect(page.getByRole("heading", { name: "Architecture review", exact: true })).toBeVisible();
    expect((await session(page)).name).toBe("API review");
    const before = await session(page);
    await rename(page, "OAuth follow-up");
    const after = await session(page);
    expect(after).toEqual({ ...before, name: "OAuth follow-up" });
    expect(after.providerSessionId).toBe("native-chat-session");
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_chat_turn"))).toHaveLength(1);
  });

  test("native startup respects custom names", async ({ page }) => {
    await setup(page); await openSession(page);
    await rename(page, "Terminal review");
    await page.getByRole("tab", { name: "Terminal nativo", exact: true }).click();
    const input = page.locator(".ad-command-input:visible textarea").first();
    await input.fill("Investigate the native launch behavior");
    await input.press("Enter");
    await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_pty_session").length)).toBe(1);
    expect((await session(page)).name).toBe("Terminal review");
    expect((await session(page)).currentTask).toBe("Investigate the native launch behavior");
  });

  test("existing sessions keep automatic titles until renamed and rename fits a narrow English window", async ({ page }) => {
    await setup(page, "en-US");
    await page.getByText("Implementation", { exact: true }).first().click();
    const open = page.getByTitle("Open conversation", { exact: true });
    if (await open.count()) await open.first().click();
    await page.locator(".ad-chat-composer textarea").fill("Automatic title still works");
    await page.locator(".ad-chat-composer textarea").press("Enter");
    await expect.poll(async () => (await session(page)).name).toBe("Automatic title still works");
    await page.setViewportSize({ width: 820, height: 650 });
    await page.locator(".ad-session-tabs").getByRole("button", { name: "Rename session", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Rename session", exact: true });
    const bounds = await modal.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(820);
    await modal.getByRole("textbox", { name: "Session name", exact: true }).fill("Saved English name");
    await modal.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".ad-session-tabs")).toContainText("Saved English name");
  });
}
