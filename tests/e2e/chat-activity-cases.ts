import { test, expect, type Page } from "@playwright/test";

export function chatActivityCases(setup: (page: Page, locale?: string) => Promise<void>, openSession: (page: Page) => Promise<void>) {
  async function start(page: Page) {
    await setup(page); await openSession(page);
    await page.locator(".ad-chat-composer textarea").fill("Show the terminal activity");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Architecture review" })).toBeVisible();
  }
  test("terminal command and output stay visible while running and survive completion and reload", async ({ page }) => {
    await start(page);
    await page.evaluate(() => {
      const w = window as any;
      const base = { sessionId: "session", turnId: w.__chatTurns.session, kind: "tool", itemId: "terminal-visible" };
      w.__emit("chat-event", { ...base, title: "Terminal", command: "pnpm build", cwd: "C:\\Projects\\Test Project", status: "running" });
      w.__emit("chat-event", { ...base, output: "Compiling application…\n", delta: true });
      w.__emit("chat-event", { ...base, elapsedSeconds: 65, status: "running" });
    });
    const tool = page.locator(".ad-tool-card").filter({ hasText: "pnpm build" });
    await expect(tool).toHaveAttribute("open", "");
    await expect(tool.locator("summary")).toContainText("Executando");
    await expect(tool.locator(".ad-tool-duration")).toHaveText("1:05");
    await expect(tool.locator(".ad-tool-command pre")).toHaveText("pnpm build");
    await expect(tool.locator(".ad-tool-result pre")).toContainText("Compiling application");
    await expect(page.locator(".ad-turn-activity-detail")).toContainText("pnpm build");
    await expect(page.locator(".ad-turn-activity-detail")).toContainText("PID 8765");
    await page.evaluate(() => {
      const w = window as any; const base = { sessionId: "session", turnId: w.__chatTurns.session };
      w.__emit("chat-event", { ...base, kind: "tool", itemId: "terminal-visible", output: "Build complete", exitCode: 0, status: "completed" });
      w.__emit("chat-event", { ...base, kind: "done", status: "completed" });
    });
    await expect(tool.locator("summary")).toContainText("Concluído");
    await expect(tool.locator(".ad-tool-result pre")).toContainText("Build complete");
    await expect(tool.locator(".ad-tool-command pre")).toHaveText("pnpm build");
    await expect(tool).toContainText("Código de saída: 0");
    await page.evaluate(async () => { const path = "/src/store/chatStore.ts"; await (await import(/* @vite-ignore */ path)).persistChatHistory(); });
    await page.reload();
    await page.getByText("Show the terminal activity", { exact: true }).first().click();
    const open = page.getByTitle("Abrir conversa");
    if (await open.count()) await open.first().click();
    const restored = page.locator(".ad-tool-card").filter({ hasText: "pnpm build" });
    await expect(restored.locator("summary")).toContainText("pnpm build");
    await restored.locator("summary").click();
    await expect(restored.locator(".ad-tool-command pre")).toHaveText("pnpm build");
    await expect(restored.locator(".ad-tool-result pre")).toContainText("Build complete");
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exportar conversa", exact: true }).click();
    const download = await downloadPromise; const stream = await download.createReadStream(); let markdown = "";
    if (stream) for await (const data of stream) markdown += data.toString();
    expect(markdown).toContain("pnpm build"); expect(markdown).toContain("Build complete");
  });
  test("large terminal output shows a bounded live tail and can be expanded", async ({ page }) => {
    await start(page);
    await page.evaluate(() => {
      const w = window as any;
      w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "tool", itemId: "large-output", title: "Terminal", command: "pnpm test", output: "FIRST_LINE\n" + "test output\n".repeat(2000) + "LATEST_LINE", status: "running" });
    });
    const tool = page.locator(".ad-tool-card").filter({ hasText: "pnpm test" });
    await expect(tool.locator(".ad-tool-result pre")).toContainText("LATEST_LINE");
    await expect(tool.locator(".ad-tool-result pre")).not.toContainText("FIRST_LINE");
    expect((await tool.locator(".ad-tool-result pre").textContent())!.length).toBeLessThanOrEqual(8000);
    await tool.getByRole("button", { name: "Ver saída completa", exact: true }).click();
    await expect(tool.locator(".ad-tool-result pre")).toContainText("FIRST_LINE");
    await tool.getByRole("button", { name: "Ver últimas linhas", exact: true }).click();
    await expect(tool.locator(".ad-tool-result pre")).not.toContainText("FIRST_LINE");
  });
  test("silent activity exposes recovery controls without claiming the agent has stopped", async ({ page }) => {
    await start(page);
    await page.evaluate(async () => {
      const path = "/src/store/chatStore.ts"; const store = await import(/* @vite-ignore */ path);
      store.useChatStore.getState().patch("session", { status: "reasoning", turnStartedAt: Date.now() - 90_000, lastEventAt: Date.now() - 70_000, lastHeartbeatAt: Date.now() });
    });
    await expect(page.locator(".ad-chat-progress")).toContainText("Agente pensando");
    await expect(page.locator(".ad-chat-stall")).toContainText("Sem nova atividade há");
    await expect(page.getByRole("button", { name: "Verificar processo", exact: true })).toBeVisible();
    await expect(page.locator(".ad-chat-stall").getByRole("button", { name: "Parar resposta", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Verificar processo", exact: true }).click();
    await expect(page.locator(".ad-chat-stall")).toContainText("Processo em execução");
    await expect(page.getByText("Processo em execução", { exact: true })).toBeInViewport();
    await expect(page.locator(".ad-chat-stall")).toContainText("Sem nova atividade há");
    await page.screenshot({ path: "test-results/chat-activity-recovery.png" });
    await page.locator(".ad-chat-stall").getByRole("button", { name: "Parar resposta", exact: true }).click();
    await expect(page.getByText("Resposta interrompida", { exact: true })).toBeVisible();
    await expect(page.locator(".ad-chat-stall")).toHaveCount(0);
  });
}
