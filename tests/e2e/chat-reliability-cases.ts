import { test, expect, type Page } from "@playwright/test";

export function chatReliabilityCases(setup: (page: Page, locale?: string) => Promise<void>, openSession: (page: Page) => Promise<void>) {
  const state = (page: Page) => page.evaluate(async () => { const path = "/src/store/chatStore.ts"; return (await import(/* @vite-ignore */ path)).useChatStore.getState().threads.session; });
  async function start(page: Page) {
    await setup(page); await openSession(page);
    await page.locator(".ad-chat-composer textarea").fill("Verify chat event reliability");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Architecture review" })).toBeVisible();
  }
  test("chat reliability keeps command, streamed output and completion from the same frame", async ({ page }) => {
    await start(page);
    await page.evaluate(() => {
      const w = window as any; const base = { sessionId: "session", turnId: w.__chatTurns.session, kind: "tool", itemId: "build" };
      w.__emit("chat-event", { ...base, title: "Terminal", command: "npm run build", cwd: "C:\\Project", status: "running" });
      w.__emit("chat-event", { ...base, output: "Building…\n", delta: true });
      w.__emit("chat-event", { ...base, output: "Build passed\n", delta: true });
      w.__emit("chat-event", { ...base, status: "completed", exitCode: 0 });
      w.__emit("chat-event", { ...base, kind: "done", status: "completed" });
    });
    const message = (await state(page)).messages.find((m: any) => m.id.endsWith(":build"));
    expect(message).toMatchObject({ command: "npm run build", cwd: "C:\\Project", output: "Building…\nBuild passed\n", status: "completed", exitCode: 0 });
  });
  test("chat reliability separates role and subagent identity even when providers reuse an item ID", async ({ page }) => {
    await start(page);
    await page.evaluate(() => {
      const w = window as any; const base = { sessionId: "session", turnId: w.__chatTurns.session, itemId: "shared" };
      w.__emit("chat-event", { ...base, kind: "tool", command: "pwd", status: "completed", output: "C:\\Project" });
      w.__emit("chat-event", { ...base, kind: "text", text: "Main response" });
      w.__emit("chat-event", { ...base, kind: "text", parentId: "child-one", text: "First child" });
      w.__emit("chat-event", { ...base, kind: "text", parentId: "child-two", text: "Second child" });
      w.__emit("chat-event", { ...base, kind: "done", status: "completed" });
    });
    const messages = (await state(page)).messages.filter((m: any) => m.id.endsWith(":shared"));
    expect(messages).toHaveLength(4);
    expect(messages.map((m: any) => m.text || m.output)).toEqual(["C:\\Project", "Main response", "First child", "Second child"]);
    expect(new Set(messages.map((m: any) => m.id)).size).toBe(4);
  });
  test("chat reliability archives completed tools during long turns and recovers late output without losing identity", async ({ page }) => {
    await start(page);
    await page.evaluate(async () => {
      const w = window as any; const base = { sessionId: "session", turnId: w.__chatTurns.session, kind: "tool" };
      for (let i = 0; i < 800; i++) w.__emit("chat-event", { ...base, itemId: `completed-${i}`, title: "Terminal", command: `echo ${i}`, output: `Output ${i}: ${"x".repeat(4000)}`, status: "completed" });
      w.__emit("chat-event", { ...base, kind: "status", status: "running" });
      const path = "/src/store/chatStore.ts"; await (await import(/* @vite-ignore */ path)).persistChatHistory();
    });
    let thread = await state(page);
    expect(thread.busy).toBe(true); expect(thread.messages.length).toBeLessThanOrEqual(200); expect(thread.archivedCount).toBeGreaterThan(600);
    const original = await page.evaluate(async () => {
      const path = "/src/services/chatHistory.ts"; const messages = await (await import(/* @vite-ignore */ path)).readChatHistory("session", undefined, 1000);
      return messages.find((m: any) => m.id.endsWith(":completed-0"));
    });
    expect(original.command).toBe("echo 0"); expect(original.output).toContain("Output 0: ");
    expect(await page.evaluate(() => localStorage.getItem("agentdeck-chat-v1")!.length)).toBeLessThan(70_000);
    await page.evaluate(() => {
      const w = window as any; const base = { sessionId: "session", turnId: w.__chatTurns.session };
      w.__emit("chat-event", { ...base, kind: "tool", itemId: "completed-0", output: "\nLate verified detail", delta: true, status: "completed" });
      w.__emit("chat-event", { ...base, kind: "done", status: "completed" });
    });
    await expect.poll(async () => (await state(page)).busy).toBe(false);
    await page.evaluate(async () => { const path = "/src/store/chatStore.ts"; await (await import(/* @vite-ignore */ path)).persistChatHistory(); });
    const recovered = await page.evaluate(async messageId => {
      const path = "/src/services/chatHistory.ts"; return (await import(/* @vite-ignore */ path)).readChatHistoryMessage("session", messageId);
    }, original.id);
    expect(recovered).toMatchObject({ id: original.id, order: original.order, at: original.at, command: "echo 0", output: original.output + "\nLate verified detail" });
    expect(await page.evaluate(async () => { const path = "/src/store/chatStore.ts"; return (await import(/* @vite-ignore */ path)).useChatStore.getState().storageError; })).toBe(false);
  });
  test("chat reliability ignores an old launch failure after a new response starts", async ({ page }) => {
    await setup(page); await openSession(page);
    await page.evaluate(() => {
      const w = window as any; const invoke = w.__TAURI_INTERNALS__.invoke; let first = true;
      w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
        const result = await invoke(command, args);
        if (command === "start_chat_turn" && first) {
          first = false;
          await new Promise((_, reject) => { w.__rejectFirstLaunch = () => reject(new Error("Obsolete launch failure")); });
        }
        return result;
      };
    });
    await page.locator(".ad-chat-composer textarea").fill("First task"); await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Architecture review" })).toBeVisible();
    await page.evaluate(() => { const w = window as any; w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "done", status: "completed" }); });
    await page.locator(".ad-chat-composer textarea").fill("Second task"); await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_chat_turn").length)).toBe(2);
    const second = await state(page);
    await page.evaluate(() => (window as any).__rejectFirstLaunch());
    await expect.poll(async () => (await state(page)).turnId).toBe(second.turnId);
    const latest = await state(page); expect(latest.busy).toBe(true); expect(latest.error).toBeUndefined(); expect(latest.draft).toBe("");
    expect(latest.messages.filter((m: any) => m.role === "user").map((m: any) => m.text)).toEqual(["First task", "Second task"]);
  });
  test("chat reliability makes a missed native error completion recoverable", async ({ page }) => {
    await start(page);
    await page.evaluate(async () => {
      const w = window as any; w.__chatTurnStatus = { turnId: w.__chatTurns.session, running: false, status: "error" };
      const path = "/src/store/chatStore.ts"; await (await import(/* @vite-ignore */ path)).refreshChatTurnStatus("session");
    });
    const thread = await state(page);
    expect(thread.busy).toBe(false); expect(thread.status).toBe("error"); expect(thread.error).toBe("Agent process ended with an error.");
    expect(thread.providerSessionId).toBe("native-chat-session");
    await expect(page.locator(".ad-chat-error[role=alert]")).toContainText("Agent process ended with an error.");
    await expect(page.getByRole("button", { name: "Tentar novamente", exact: true })).toBeVisible();
  });
  test("chat reliability separates heartbeat liveness from meaningful activity and rejects stale native status", async ({ page }) => {
    await start(page);
    const lastEventAt = await page.evaluate(async () => {
      const path = "/src/store/chatStore.ts"; const store = await import(/* @vite-ignore */ path);
      const w = window as any; const at = Date.now() - 130_000;
      store.useChatStore.getState().patch("session", { status: "reasoning", activity: "Reviewing the project", lastEventAt: at });
      w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "heartbeat", pid: 5432 });
      return at;
    });
    let thread = await state(page);
    expect(thread.lastEventAt).toBe(lastEventAt); expect(thread.status).toBe("reasoning"); expect(thread.activity).toBe("Reviewing the project"); expect(thread.lastHeartbeatAt).toBeGreaterThan(lastEventAt);
    await page.evaluate(async () => {
      const path = "/src/store/chatStore.ts"; const store = await import(/* @vite-ignore */ path); const w = window as any;
      w.__chatTurnStatus = { turnId: w.__chatTurns.session, running: true, pid: 8765, status: "running" };
      await store.refreshChatTurnStatus("session");
    });
    thread = await state(page);
    expect(thread.busy).toBe(true); expect(thread.status).toBe("reasoning"); expect(thread.lastEventAt).toBe(lastEventAt); expect(thread.pid).toBe(8765);
    await expect(page.locator(".ad-chat-stall")).toContainText("Sem nova atividade há");
    await page.evaluate(async () => {
      const path = "/src/store/chatStore.ts"; const store = await import(/* @vite-ignore */ path); const w = window as any;
      w.__chatTurnStatus = { turnId: "obsolete-turn", running: false, status: "completed" };
      await store.refreshChatTurnStatus("session");
    });
    thread = await state(page); expect(thread.busy).toBe(true); expect(thread.status).toBe("reasoning"); expect(thread.lastEventAt).toBe(lastEventAt);
    await page.evaluate(() => {
      const w = window as any; w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "status", parentId: "child", status: "compacting", text: "Child summary" });
      w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "status", contextTokens: 1234 });
    });
    thread = await state(page); expect(thread.status).toBe("reasoning"); expect(thread.compacting).toBe(false); expect(thread.activity).toBe("Reviewing the project"); expect(thread.contextTokens).toBe(1234);
  });
}
