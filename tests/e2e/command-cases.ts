import { test, expect, type Page } from "@playwright/test";

export function commandCases(setup: (page: Page, locale?: string) => Promise<void>) {
  async function prepare(page: Page, provider = "claude-code") {
    await setup(page, "en-US");
    await page.evaluate(async (provider) => {
      const w = window as any;
      const entry = (name: string, kind = "builtin", transport = "native", source = "builtin", invocation = "/" + name) => ({ name, kind, transport, source, invocation, description: "Description for " + name, argumentHint: "", path: kind === "skill" ? "C:/Skills/" + name + "/SKILL.md" : null });
      w.__agentCommands = { [provider]: { entries: [
        entry("help"), entry("skills"), entry("model"), entry("effort"), entry("fast"), entry("plan"), entry("code"), entry("status"), entry("compact", "builtin", provider === "claude-code" ? "chat" : "native"),
        entry("security:review", "command", "chat", "project"), entry("review", "skill", "chat", "user", provider === "codex" ? "$review" : provider === "gemini" ? "Use the review skill:" : "/review"),
      ], warnings: [] } };
      const path = "/src/store/sessionStore.ts";
      const { useSessionStore } = await import(/* @vite-ignore */ path);
      useSessionStore.getState().updateSession("session", { runner: { type: provider } });
    }, provider);
    await page.getByText("Implementation", { exact: true }).first().click();
    const open = page.getByTitle("Open conversation", { exact: true });
    if (await open.count()) await open.first().click();
    await expect(page.locator(".ad-command-input:visible textarea").first()).toBeVisible();
  }
  const input = (page: Page) => page.locator(".ad-chat-composer textarea");
  const starts = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_chat_turn"));

  test("command picker inserts a namespaced command without submitting and preserves arguments", async ({ page }) => {
    await prepare(page);
    await input(page).fill("/security");
    await expect(page.getByRole("option").filter({ hasText: "/security:review" })).toBeVisible();
    await input(page).press("Tab");
    await expect(input(page)).toHaveValue("/security:review ");
    expect(await starts(page)).toHaveLength(0);
    await input(page).fill("/security:review src/auth");
    await input(page).press("Enter");
    await expect.poll(async () => (await starts(page))[0]?.args.request.prompt).toBe("/security:review src/auth");
  });

  test("session commands change controls without starting a paid model turn", async ({ page }) => {
    await prepare(page);
    for (const text of ["/model sonnet", "/plan ", "/code ", "/status "]) {
      await input(page).fill(text); await input(page).press("Enter");
      await expect(input(page)).toHaveValue("");
    }
    const model = await page.evaluate(async () => { const p = "/src/store/sessionStore.ts"; return (await import(/* @vite-ignore */ p)).useSessionStore.getState().sessions.find((s: any) => s.id === "session").runner.model; });
    expect(model).toBe("sonnet"); expect(await starts(page)).toHaveLength(0);
  });

  test("unknown slash commands are retained and never sent as ordinary prompts", async ({ page }) => {
    await prepare(page);
    await input(page).fill("/unknown-command "); await input(page).press("Enter");
    await expect(page.getByRole("alert")).toContainText("command");
    await expect(input(page)).toHaveValue("/unknown-command ");
    expect(await starts(page)).toHaveLength(0);
  });

  test("Codex skill selection supports mid-prompt insertion and additional input while busy", async ({ page }) => {
    await prepare(page, "codex");
    await input(page).fill("Please use $rev"); await input(page).press("Tab");
    await expect(input(page)).toHaveValue("Please use $review ");
    await input(page).press("Enter");
    await expect.poll(async () => (await starts(page))[0]?.args.request.prompt).toBe("Please use $review");
    await input(page).fill("Also use $rev"); await input(page).press("Tab"); await input(page).press("Enter");
    await expect.poll(() => page.evaluate(() => (window as any).__calls.find((c: any) => c.command === "steer_chat_turn")?.args.request.prompt)).toBe("Also use $review");
  });

  test("Codex native command handoff uses terminal input, resumes the session and never a model prompt", async ({ page }) => {
    await prepare(page, "codex");
    await page.evaluate(async () => { const p = "/src/store/sessionStore.ts"; (await import(/* @vite-ignore */ p)).useSessionStore.getState().updateSession("session", { providerSessionId: "existing-thread" }); });
    await input(page).fill("/compact "); await input(page).press("Enter");
    await expect(page.getByRole("tab", { name: "Native terminal", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_pty_session").length)).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as any).__calls.find((c: any) => c.command === "send_pty_query")?.args.query), { timeout: 12_000 }).toBe("/compact");
    const launch = await page.evaluate(() => (window as any).__calls.find((c: any) => c.command === "start_pty_session").args);
    expect(launch.args).toContain("existing-thread"); expect(launch.args).not.toContain("/compact"); expect(await starts(page)).toHaveLength(0);
  });

  test("Claude non-interactive commands remain in structured chat", async ({ page }) => {
    await prepare(page);
    await input(page).fill("/compact Preserve decisions"); await input(page).press("Enter");
    await expect.poll(async () => (await starts(page))[0]?.args.request.prompt).toBe("/compact Preserve decisions");
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_pty_session"))).toHaveLength(0);
  });

  test("skill browser can refresh metadata and Escape closes only the picker", async ({ page }) => {
    await prepare(page);
    await page.locator(".ad-chat-composer").getByRole("button", { name: "Skills", exact: true }).click();
    await expect(page.getByRole("option").filter({ hasText: "/review" })).toBeVisible();
    await page.getByRole("button", { name: "Refresh catalogue", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "list_agent_commands" && c.args.force).length)).toBe(1);
    await page.keyboard.press("Escape"); await expect(page.getByRole("listbox")).toHaveCount(0); await expect(input(page)).toBeVisible();
  });

  test("Gemini startup and terminal follow-up inputs share command and skill discovery", async ({ page }) => {
    await prepare(page, "gemini");
    const composer = page.locator(".ad-command-input").filter({ visible: true });
    await composer.getByRole("button", { name: "Skills", exact: true }).click();
    await page.getByRole("option").filter({ hasText: "Use the review skill:" }).click();
    await expect(composer.locator("textarea")).toHaveValue("Use the review skill: ");
    await page.keyboard.press("Escape");
    await composer.locator("textarea").fill("/stats "); await composer.locator("textarea").press("Enter");
    await expect.poll(() => page.evaluate(() => (window as any).__calls.find((c: any) => c.command === "send_pty_query")?.args.query), { timeout: 12_000 }).toBe("/stats");
    await expect(page.locator(".ad-followup textarea")).toBeVisible();
    await page.locator(".ad-followup").getByRole("button", { name: "Commands", exact: true }).click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.getByRole("option").filter({ hasText: "/status" }).click();
    await expect(page.locator(".ad-followup textarea")).toHaveValue("/status ");
  });

  test("command picker fits a small light window and disappears when its chat is hidden", async ({ page }) => {
    await prepare(page);
    await page.setViewportSize({ width: 820, height: 650 });
    await page.evaluate(async () => { const p = "/src/store/settingsStore.ts"; (await import(/* @vite-ignore */ p)).useSettingsStore.setState((state: any) => ({ settings: { ...state.settings, theme: "light" } })); });
    await input(page).fill("/mod");
    const picker = page.getByRole("region", { name: "Commands and skills", exact: true });
    await expect(picker).toBeVisible();
    const bounds = await picker.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(820);
    expect(bounds!.y).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(650);
    await page.keyboard.press("Escape"); await expect(picker).toHaveCount(0);
    await page.locator(".ad-chat-composer").getByRole("button", { name: "Commands", exact: true }).click();
    await page.getByRole("tab", { name: "Native terminal", exact: true }).click();
    await expect(picker).toHaveCount(0);
  });
}
