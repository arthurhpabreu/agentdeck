import { test, expect, type Page } from "@playwright/test";

export function chatActivityCases(setup: (page: Page, locale?: string) => Promise<void>, openSession: (page: Page) => Promise<void>) {
  async function start(page: Page) {
    await setup(page); await openSession(page);
    await page.locator(".ad-chat-composer textarea").fill("Show the terminal activity");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Architecture review" })).toBeVisible();
  }
  test("chat lifecycle waiting-background explains live tasks and clears on renewed work or completion @macos", async ({ page }, testInfo) => {
    await page.clock.install();
    await start(page);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await page.evaluate(() => {
      const w = window as any; const base = { sessionId: "session", turnId: w.__chatTurns.session };
      w.__emit("chat-event", { ...base, kind: "tool", itemId: "background-command", title: "Bash", command: "render-video", status: "running" });
      w.__emit("chat-event", { ...base, kind: "status", status: "waiting-background", text: "Response received; waiting for background tasks." });
    });
    const tool = page.locator(".ad-tool-card").filter({ hasText: "render-video" });
    await expect(page.locator(".ad-chat-progress")).toContainText("Aguardando tarefas em segundo plano");
    await expect(tool.locator("summary")).toContainText("Executando");
    await expect(page.locator(".ad-turn-activity-detail")).toContainText("render-video");
    await page.evaluate(async () => {
      const path = "/src/store/chatStore.ts";
      (await import(/* @vite-ignore */ path)).useChatStore.getState().patch("session", { lastEventAt: Date.now() - 250_000 });
    });
    await page.clock.runFor(1000);
    await expect(page.locator(".ad-chat-stall")).toContainText("A resposta principal foi recebida, mas ainda há tarefas ativas em segundo plano.");
    await page.getByRole("button", { name: "Verificar processo", exact: true }).click();
    await expect(page.locator(".ad-chat-stall")).toContainText("Processo em execução");
    await expect(page.locator(".ad-chat-progress")).toContainText("Aguardando tarefas em segundo plano");
    await page.screenshot({ path: testInfo.outputPath("waiting-background.png") });
    await page.evaluate(() => {
      const w = window as any;
      w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "status", status: "running" });
    });
    await expect(page.locator(".ad-chat-progress")).not.toContainText("Aguardando tarefas em segundo plano");
    await expect(page.locator(".ad-chat-progress")).toContainText("Bash · Executando");
    const renewed = await page.evaluate(async () => { const path = "/src/store/chatStore.ts"; return (await import(/* @vite-ignore */ path)).useChatStore.getState().threads.session; });
    expect(renewed.busy).toBe(true); expect(renewed.status).toBe("running"); expect(renewed.activity).toBeUndefined();
    await page.evaluate(() => {
      const w = window as any; const base = { sessionId: "session", turnId: w.__chatTurns.session, kind: "status" };
      w.__emit("chat-event", { ...base, status: "waiting-background" });
      w.__emit("chat-event", { ...base, status: "blocked" });
    });
    await expect(page.locator(".ad-chat-progress")).toContainText("Permissão negada");
    await page.evaluate(async () => {
      const path = "/src/store/chatStore.ts"; const store = (await import(/* @vite-ignore */ path)).useChatStore;
      store.getState().patch("session", { status: "waiting-background", compacting: true });
    });
    await expect(page.locator(".ad-chat-progress")).toContainText("Compactando contexto");
    await page.evaluate(() => {
      const w = window as any;
      w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "done", status: "completed" });
    });
    await expect(page.locator(".ad-turn-activity")).toHaveCount(0);
    await expect(tool.locator("summary")).toContainText("Concluído");
  });
  test("tool details stay collapsed until opened and retain output after completion and reload", async ({ page }) => {
    await start(page);
    await page.evaluate(() => {
      const w = window as any;
      const base = { sessionId: "session", turnId: w.__chatTurns.session, kind: "tool", itemId: "terminal-visible" };
      w.__emit("chat-event", { ...base, title: "Terminal", command: "pnpm build", cwd: "C:\\Projects\\Test Project", status: "running" });
      w.__emit("chat-event", { ...base, output: "Compiling application…\n", delta: true });
      w.__emit("chat-event", { ...base, elapsedSeconds: 65, status: "running" });
    });
    const tool = page.locator(".ad-tool-card").filter({ hasText: "pnpm build" });
    await expect(tool).not.toHaveAttribute("open");
    await expect(tool.locator(".ad-tool-body")).toHaveCount(0);
    await expect(tool.locator("summary")).toContainText("Executando");
    await expect(tool.locator(".ad-tool-duration")).toHaveText("1:05");
    for (const [status, label] of [["failed", "Falhou"], ["blocked", "Permissão negada"]]) {
      await page.evaluate(status => {
        const w = window as any;
        w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "tool", itemId: "terminal-visible", status });
      }, status);
      await expect(tool.locator("summary")).toContainText(label);
      await expect(tool).not.toHaveAttribute("open");
      await expect(tool.locator(".ad-tool-body")).toHaveCount(0);
    }
    await tool.locator("summary").click();
    await expect(tool).toHaveAttribute("open", "");
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
    await page.locator(".ad-session-card").getByRole("button", { name: "Show the terminal activity Claude Code", exact: true }).click();
    const open = page.getByTitle("Abrir conversa");
    if (await open.count()) await open.first().click();
    const restored = page.locator(".ad-tool-card").filter({ hasText: "pnpm build" });
    await expect(restored.locator("summary")).toContainText("pnpm build");
    await expect(restored).not.toHaveAttribute("open");
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
    await expect(tool).not.toHaveAttribute("open");
    await tool.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(tool.locator(".ad-tool-result pre")).toContainText("LATEST_LINE");
    await expect(tool.locator(".ad-tool-result pre")).not.toContainText("FIRST_LINE");
    expect((await tool.locator(".ad-tool-result pre").textContent())!.length).toBeLessThanOrEqual(8000);
    await tool.getByRole("button", { name: "Ver saída completa", exact: true }).click();
    await expect(tool.locator(".ad-tool-result pre")).toContainText("FIRST_LINE");
    await tool.getByRole("button", { name: "Ver últimas linhas", exact: true }).click();
    await expect(tool.locator(".ad-tool-result pre")).not.toContainText("FIRST_LINE");
    await tool.locator("summary").click();
    await page.evaluate(() => {
      const w = window as any;
      w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "tool", itemId: "large-output", output: "\nMORE_OUTPUT", delta: true, status: "running" });
    });
    await expect(tool).not.toHaveAttribute("open");
    await tool.locator("summary").click();
    await expect(tool.locator(".ad-tool-result pre")).toContainText("MORE_OUTPUT");
  });
  test("file tools name their target and show edits and Codex patches as line diffs once opened", async ({ page }) => {
    await start(page);
    await page.evaluate(() => {
      const w = window as any; const base = { sessionId: "session", turnId: w.__chatTurns.session, kind: "tool" };
      const root = "C:\Projects\Test Project\\";
      w.__emit("chat-event", { ...base, itemId: "claude-edit", title: "Edit", status: "running", text: JSON.stringify({ file_path: root + "src\server.ts", new_string: "const port = 8080;\nstart(port);", old_string: "const port = 3000;\nstart(port);" }) });
      w.__emit("chat-event", { ...base, itemId: "claude-edit", output: "The file has been updated.", status: "completed" });
      w.__emit("chat-event", { ...base, itemId: "claude-read", title: "Read", status: "completed", text: JSON.stringify({ file_path: root + "docs\guide.md" }), output: "# Guide" });
      w.__emit("chat-event", { ...base, itemId: "codex-files", title: "Files", status: "completed", text: JSON.stringify([
        { diff: "@@ -1,2 +1,2 @@\n-export const mode = \"dev\";\n+export const mode = \"prod\";\n export default mode;\n", kind: { move_path: null, type: "update" }, path: root + "src\config.ts" },
        { diff: "first note\n", kind: { type: "add" }, path: root + "notes.md" },
      ]) });
      w.__emit("chat-event", { ...base, itemId: "partial-write", title: "Write", status: "running", text: "{\"content\":\"draft" });
    });
    const cards = page.locator(".ad-tool-card");
    const edit = cards.filter({ hasText: "src/server.ts" });
    await expect(edit.locator("summary")).toContainText("Edit");
    await expect(edit.locator("summary .ad-tool-command-preview")).toHaveText("src/server.ts");
    await expect(edit.locator("summary")).toContainText("Concluído");
    await expect(edit).not.toHaveAttribute("open");
    await expect(edit.locator(".ad-tool-body")).toHaveCount(0);
    await edit.locator("summary").click();
    await expect(edit.locator(".ad-tool-diff .is-del")).toHaveCount(1);
    await expect(edit.locator(".ad-tool-diff .is-del")).toContainText("const port = 3000;");
    await expect(edit.locator(".ad-tool-diff .is-add")).toHaveCount(1);
    await expect(edit.locator(".ad-tool-diff .is-add")).toContainText("const port = 8080;");
    await expect(edit.locator(".ad-tool-diff .is-ctx")).toContainText("start(port);");
    await expect(edit.locator(".ad-tool-result")).toContainText("Resultado");
    await expect(edit.locator(".ad-tool-result pre")).toHaveText("The file has been updated.");
    await expect(edit.locator(".ad-tool-body")).not.toContainText("old_string");
    const read = cards.filter({ hasText: "docs/guide.md" });
    await expect(read.locator("summary")).toContainText("Read");
    await read.locator("summary").click();
    await expect(read.locator(".ad-tool-result pre")).toHaveText("# Guide");
    const files = cards.filter({ hasText: "src/config.ts +1" });
    await expect(files.locator("summary")).toContainText("Files");
    await expect(files).not.toHaveAttribute("open");
    await files.locator("summary").click();
    await expect(files.locator(".ad-tool-file").first()).toContainText("src/config.ts");
    await expect(files.locator(".ad-tool-file").last()).toContainText("notes.md");
    await expect(files.locator(".ad-tool-file").last()).toContainText("Arquivo novo");
    const patches = files.locator(".ad-tool-diff");
    await expect(patches).toHaveCount(2);
    await expect(patches.first().locator(".is-hunk")).toContainText("@@ -1,2 +1,2 @@");
    await expect(patches.first().locator(".is-del")).toContainText('export const mode = "dev";');
    await expect(patches.first().locator(".is-add")).toContainText('export const mode = "prod";');
    await expect(patches.first().locator(".is-ctx")).toContainText("export default mode;");
    await expect(patches.last().locator(".is-add")).toContainText("first note");
    // Incomplete input keeps the raw rendering instead of guessing.
    const partial = cards.filter({ has: page.locator("summary strong", { hasText: "Write" }) });
    await expect(partial.locator("summary .ad-tool-command-preview")).toHaveCount(0);
    await partial.locator("summary").click();
    await expect(partial.locator(".ad-tool-result pre")).toHaveText('{"content":"draft');
  });
  test("silent activity exposes recovery controls without claiming the agent has stopped", async ({ page }) => {
    await page.clock.install();
    await start(page);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await page.evaluate(async () => {
      const path = "/src/store/chatStore.ts"; const store = await import(/* @vite-ignore */ path);
      store.useChatStore.getState().patch("session", { status: "reasoning", turnStartedAt: Date.now() - 150_000, lastEventAt: Date.now() - 119_000, lastHeartbeatAt: Date.now() });
    });
    await expect(page.locator(".ad-chat-progress")).toContainText("Agente pensando");
    await expect(page.locator(".ad-chat-stall")).toHaveCount(0);
    await expect(page.getByText("Atividade do agente", { exact: true })).toHaveCount(0);
    await page.clock.runFor(2000);
    await expect(page.locator(".ad-chat-stall")).toHaveCount(0);
    await page.clock.runFor(120_000);
    await expect(page.locator(".ad-chat-stall")).toContainText("Sem nova atividade há");
    await expect(page.getByRole("button", { name: "Verificar processo", exact: true })).toBeVisible();
    await expect(page.locator(".ad-chat-stall").getByRole("button", { name: "Parar resposta", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Verificar processo", exact: true }).click();
    await expect(page.locator(".ad-chat-stall")).toContainText("Processo em execução");
    // A confirmed live process is a long-running step, not a stall.
    await expect(page.locator(".ad-chat-stall")).toHaveClass(/is-alive/);
    await expect(page.locator(".ad-chat-stall")).toContainText("O processo continua ativo");
    await expect(page.getByText("Processo em execução", { exact: true })).toBeInViewport();
    await expect(page.locator(".ad-chat-stall")).toContainText("Sem nova atividade há");
    await page.screenshot({ path: "test-results/chat-activity-recovery.png" });
    await page.locator(".ad-chat-stall").getByRole("button", { name: "Parar resposta", exact: true }).click();
    await expect(page.getByText("Resposta interrompida", { exact: true })).toBeVisible();
    await expect(page.locator(".ad-chat-stall")).toHaveCount(0);
  });
}
