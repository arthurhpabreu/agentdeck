import { test, expect, type Page } from "@playwright/test";

export function compactionCases(setup: (page: Page, locale?: string) => Promise<void>, openSession: (page: Page) => Promise<void>) {
  async function seed(page: Page, patch: object = {}) {
    await page.evaluate(async value => {
      const path = "/src/store/chatStore.ts"; const { useChatStore, chatHistoryReady } = await import(/* @vite-ignore */ path); await chatHistoryReady;
      useChatStore.getState().patch("session", { providerSessionId: "existing-session", contextPrompts: 20, contextTokens: 1000, compactionPolicy: { enabled: true, maxPrompts: 20, maxTokens: 64000, version: 2 }, ...value });
      (window as any).__autoComplete = true;
    }, patch);
  }
  const state = (page: Page) => page.evaluate(async () => { const path = "/src/store/chatStore.ts"; return (await import(/* @vite-ignore */ path)).useChatStore.getState().threads.session; });
  async function send(page: Page, text = "Continue preservando as decisões anteriores") { await page.locator(".ad-chat-composer textarea").fill(text); await page.getByRole("button", { name: "Enviar", exact: true }).click(); }
  for (const provider of ["Claude Code", "OpenAI Codex"]) test(`${provider} compacts by prompt count, preserves identity and resets only after confirmation`, async ({ page }) => {
    await setup(page); await openSession(page); await page.getByRole("button", { name: provider, exact: true }).click(); await seed(page);
    await page.evaluate(() => { (window as any).__compactionDelay = 500; });
    await send(page); await expect(page.locator(".ad-chat-progress")).toContainText("Compactando contexto");
    expect((await state(page)).compactionCount ?? 0).toBe(0);
    await expect.poll(async () => (await state(page)).compactionCount).toBe(1);
    await expect.poll(async () => (await state(page)).busy).toBe(false);
    const request = await page.evaluate(() => (window as any).__calls.find((c: any) => c.command === "start_chat_turn").args.request);
    expect(request.compactBeforeTurn).toBe(true); expect(request.providerSessionId).toBe("existing-session");
    expect((await state(page)).contextPrompts).toBe(1);
    await send(page, "Próximo pedido curto");
    await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_chat_turn").length)).toBe(2);
    const next = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_chat_turn")[1].args.request);
    expect(next.compactBeforeTurn).toBe(false); expect(next.providerSessionId).toBe("existing-session");
  });
  test("context token threshold is separate from lifetime billing and preferences persist", async ({ page }) => {
    await setup(page); await openSession(page); await seed(page, { contextPrompts: 1, contextTokens: 64000, totalUsage: { inputTokens: 900000, cachedInputTokens: 0, outputTokens: 200000 } });
    await send(page); await expect.poll(async () => (await state(page)).compactionCount).toBe(1);
    expect((await state(page)).totalUsage.inputTokens).toBeGreaterThan(900000);
    await page.locator(".ad-chat-context summary").click(); await page.getByRole("spinbutton", { name: "Limite de prompts", exact: true }).fill("25");
    await page.getByRole("switch", { name: "Compactação automática", exact: true }).click();
    await page.evaluate(async () => { const path = "/src/store/chatStore.ts"; await (await import(/* @vite-ignore */ path)).persistChatHistory(); });
    await page.reload(); await expect.poll(async () => (await state(page)).compactionPolicy.enabled).toBe(false);
    expect((await state(page)).compactionPolicy.maxPrompts).toBe(25);
  });
  for (const provider of ["Claude Code", "OpenAI Codex"]) test(`${provider} waits five prompts after compaction even when context remains above the token limit`, async ({ page }) => {
    await setup(page); await openSession(page); await page.getByRole("button", { name: provider, exact: true }).click();
    await seed(page, { contextPrompts: 2, contextTokens: 250000, contextTokensEstimated: provider === "Claude Code", compactionCount: 1, lastCompactedAt: Date.now(), compactionPolicy: { enabled: true, maxPrompts: 50, maxTokens: 200000, version: 2 } });
    await page.evaluate(async () => { const path = "/src/store/chatStore.ts"; await (await import(/* @vite-ignore */ path)).persistChatHistory(); });
    await page.reload(); await openSession(page);
    await page.evaluate(() => { (window as any).__autoComplete = true; });
    for (let i = 0; i < 3; i++) { await send(page, `Continuar sem repetir compactação ${i}`); await expect.poll(async () => (await state(page)).busy).toBe(false); }
    expect((await state(page)).contextPrompts).toBe(5);
    expect((await state(page)).compactionCount).toBe(1);
    await send(page, "Agora reavaliar o limite de tokens"); await expect.poll(async () => (await state(page)).busy).toBe(false);
    expect((await state(page)).compactionCount).toBe(2);
    const requests = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_chat_turn").map((c: any) => c.args.request));
    expect(requests.map((r: any) => r.compactBeforeTurn)).toEqual([false, false, false, true]);
    expect(requests.every((r: any) => r.providerSessionId === "existing-session")).toBe(true);
  });
  test("old enabled defaults migrate once while custom limits and opt-out survive cache and archive reloads", async ({ page }) => {
    await page.addInitScript(() => {
      if (localStorage.getItem("compaction-fixture-archive-only")) localStorage.removeItem("agentdeck-chat-v1");
      if (localStorage.getItem("compaction-fixture-seeded")) return;
      localStorage.setItem("compaction-fixture-seeded", "true");
      const thread = (compactionPolicy: object) => ({ messages: [], draft: "", busy: false, compactionPolicy });
      localStorage.setItem("agentdeck-chat-v1", JSON.stringify({ session: thread({ enabled: true, maxPrompts: 20, maxTokens: 64000 }), custom: thread({ enabled: true, maxPrompts: 35, maxTokens: 90000 }), off: thread({ enabled: false, maxPrompts: 20, maxTokens: 64000 }), explicit: thread({ enabled: true, maxPrompts: 20, maxTokens: 64000, version: 2 }) }));
    });
    await setup(page); await openSession(page);
    const policies = () => page.evaluate(async () => { const path = "/src/store/chatStore.ts"; const store = await import(/* @vite-ignore */ path); await store.chatHistoryReady; return Object.fromEntries(Object.entries(store.useChatStore.getState().threads).map(([id, thread]: any) => [id, thread.compactionPolicy])); });
    const expected = { session: { enabled: true, maxPrompts: 50, maxTokens: 200000, version: 2 }, custom: { enabled: true, maxPrompts: 35, maxTokens: 90000, version: 2 }, off: { enabled: false, maxPrompts: 20, maxTokens: 64000, version: 2 }, explicit: { enabled: true, maxPrompts: 20, maxTokens: 64000, version: 2 } };
    expect(await policies()).toMatchObject(expected);
    await page.locator(".ad-chat-context summary").click();
    await expect(page.getByRole("spinbutton", { name: "Limite de prompts", exact: true })).toHaveValue("50");
    await expect(page.getByRole("spinbutton", { name: "Limite de tokens de contexto", exact: true })).toHaveValue("200000");
    await page.evaluate(async () => {
      const path = "/src/store/chatStore.ts"; const store = await import(/* @vite-ignore */ path); await store.persistChatHistory();
      const historyPath = "/src/services/chatHistory.ts"; const history = await import(/* @vite-ignore */ historyPath);
      await history.saveChatHistory("session", { ...store.useChatStore.getState().threads.session, compactionPolicy: { enabled: true, maxPrompts: 20, maxTokens: 64000 } }, []);
      localStorage.setItem("compaction-fixture-archive-only", "true"); localStorage.removeItem("agentdeck-chat-v1");
    });
    await page.reload(); expect(await policies()).toMatchObject(expected);
  });
  test("subagent output cannot inflate the main measured context or trigger compaction", async ({ page }) => {
    await setup(page); await openSession(page); await seed(page, { contextPrompts: 1 });
    await page.evaluate(() => { (window as any).__autoComplete = false; }); await send(page);
    await expect(page.getByRole("heading", { name: "Architecture review" })).toBeVisible();
    await page.evaluate(() => {
      const w = window as any; const turnId = w.__chatTurns.session;
      w.__emit("chat-event", { sessionId: "session", turnId, kind: "status", status: "running", contextTokens: 1000 });
      w.__emit("chat-event", { sessionId: "session", turnId, kind: "text", itemId: "child-output", parentId: "child", text: "a".repeat(240000) });
      w.__emit("chat-event", { sessionId: "session", turnId, kind: "status", parentId: "child", contextTokens: 900000, usage: { input_tokens: 900000, output_tokens: 200000 } });
      w.__emit("chat-event", { sessionId: "session", turnId, kind: "done", status: "completed" });
    });
    expect((await state(page)).contextTokens).toBe(1000); expect((await state(page)).contextTokensEstimated).toBe(false);
    expect((await state(page)).messages.find((m: any) => m.id.endsWith(":child-output")).text.length).toBe(240000);
    await send(page, "Continuar usando apenas o contexto principal");
    const flags = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_chat_turn").map((c: any) => c.args.request.compactBeforeTurn));
    expect(flags).toEqual([false, false]);
  });
  test("failed compaction preserves the unsent draft and binding without resetting counters", async ({ page }) => {
    await setup(page); await openSession(page); await seed(page);
    await page.evaluate(() => { (window as any).__failCompact = true; }); await send(page, "Pedido preservado");
    await expect(page.locator(".ad-chat-composer textarea")).toHaveValue("Pedido preservado");
    const thread = await state(page); expect(thread.compactionCount ?? 0).toBe(0); expect(thread.contextPrompts).toBeGreaterThanOrEqual(20); expect(thread.providerSessionId).toBe("existing-session");
    await expect(page.getByRole("alert").filter({ hasText: "compaction" })).toBeVisible();
  });
  test("additional input waits through compaction and remains in the same turn", async ({ page }) => {
    await setup(page); await openSession(page); await seed(page); await page.evaluate(() => { (window as any).__compactionDelay = 1000; (window as any).__autoComplete = false; });
    await send(page); await page.locator(".ad-chat-composer textarea").fill("Também preserve os testes"); await page.getByRole("button", { name: "Enviar complemento", exact: true }).click();
    await expect(page.getByText("Complemento entregue", { exact: true })).toBeVisible();
    const thread = await state(page); expect(thread.contextPrompts).toBe(2); expect(thread.compactionCount).toBe(1);
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_chat_turn").length)).toBe(1);
  });
  test("long history is archived, paged, searchable and exported in full after reload", async ({ page }) => {
    await setup(page); await openSession(page);
    await page.evaluate(async () => {
      const path = "/src/store/chatStore.ts"; const store = await import(/* @vite-ignore */ path); await store.chatHistoryReady;
      store.useChatStore.getState().patch("session", { messages: Array.from({ length: 1500 }, (_, i) => ({ id: `history-${i}`, turnId: `old-${i}`, role: i % 2 ? "assistant" : "user", text: `Mensagem histórica ${i}${i === 0 ? " — Decisão original preservada" : ""}`, at: i + 1 })) });
      await store.persistChatHistory();
    });
    expect((await state(page)).messages.length).toBeLessThanOrEqual(200);
    await expect(page.locator(".ad-message")).toHaveCount(80);
    await page.getByRole("button", { name: "Ver mensagens anteriores", exact: true }).click();
    await expect(page.locator(".ad-message")).toHaveCount(80); await expect(page.getByText("Mensagem histórica 1419", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Buscar", exact: true }).click(); await page.getByRole("textbox", { name: "Buscar na conversa", exact: true }).fill("Decisão original preservada");
    await expect(page.getByText("Mensagem histórica 0 — Decisão original preservada", { exact: true })).toBeVisible();
    const downloadPromise = page.waitForEvent("download"); await page.getByRole("button", { name: "Exportar conversa", exact: true }).click(); const download = await downloadPromise;
    const stream = await download.createReadStream(); let markdown = ""; if (stream) for await (const data of stream) markdown += data.toString();
    expect(markdown).toContain("Mensagem histórica 0 — Decisão original preservada"); expect(markdown).toContain("Mensagem histórica 1499"); expect(markdown.match(/## /g)).toHaveLength(1500);
    await page.reload(); await expect.poll(async () => (await state(page))?.messages.length).toBe(80); expect((await state(page)).archivedCount).toBe(1420);
    const cache = await page.evaluate(() => localStorage.getItem("agentdeck-chat-v1")!.length); expect(cache).toBeLessThan(15000);
  });
  test("stream bursts are coalesced and repeated reasoning does not fill diagnostics", async ({ page }) => {
    await setup(page); await openSession(page); await send(page);
    await expect(page.getByRole("heading", { name: "Architecture review" })).toBeVisible();
    await page.evaluate(() => {
      const w = window as any; const turnId = w.__chatTurns.session;
      for (let i = 0; i < 1000; i++) w.__emit("chat-event", { sessionId: "session", turnId, kind: "status", status: "reasoning", text: "Thinking…" });
      for (let i = 0; i < 400; i++) w.__emit("chat-event", { sessionId: "session", turnId, kind: "text", itemId: "burst", text: "a", delta: true });
      w.__emit("chat-event", { sessionId: "session", turnId, kind: "done", status: "completed" });
    });
    expect((await state(page)).diagnostic ?? "").not.toContain("Thinking"); expect((await state(page)).messages.find((m: any) => m.id.endsWith(":burst")).text).toBe("a".repeat(400));
  });
  test("failed archive writes keep resident history and recover without losing messages", async ({ page }) => {
    await setup(page); await openSession(page);
    await page.evaluate(async () => {
      const path = "/src/store/chatStore.ts"; const store = await import(/* @vite-ignore */ path); await store.chatHistoryReady;
      const original = IDBDatabase.prototype.transaction; (window as any).__restoreTransaction = () => { IDBDatabase.prototype.transaction = original; };
      IDBDatabase.prototype.transaction = (() => { throw new Error("Storage test failure"); }) as any;
      store.useChatStore.getState().patch("session", { messages: Array.from({ length: 400 }, (_, i) => ({ id: `pending-${i}`, turnId: `turn-${i}`, role: "user", text: `Preserve ${i}`, at: i })) }); await store.persistChatHistory();
    });
    expect((await state(page)).messages).toHaveLength(400);
    await expect(page.getByRole("alert").filter({ hasText: "armazenamento local" })).toBeVisible();
    await page.evaluate(async () => { (window as any).__restoreTransaction(); const path = "/src/store/chatStore.ts"; await (await import(/* @vite-ignore */ path)).persistChatHistory(); });
    expect((await state(page)).messages.length).toBeLessThanOrEqual(200);
    await page.reload(); await expect.poll(async () => (await state(page)).archivedCount).toBe(320);
  });
  test("legacy migration retains every message after storage cannot open at startup", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("agentdeck-chat-v1", JSON.stringify({ session: { draft: "Rascunho antigo", busy: false, messages: Array.from({ length: 500 }, (_, i) => ({ id: `legacy-${i}`, turnId: `turn-${i}`, role: "user", text: `Histórico anterior ${i}`, at: i })) } }));
      const original = IDBFactory.prototype.open;
      IDBFactory.prototype.open = (() => { throw new Error("Database unavailable at startup"); }) as any;
      (window as any).__restoreDatabaseOpen = () => { IDBFactory.prototype.open = original; };
    });
    await setup(page); await page.getByText("Implementation", { exact: true }).first().click();
    await expect.poll(async () => (await state(page))?.messages.length).toBe(500);
    await page.evaluate(async () => { (window as any).__restoreDatabaseOpen(); const path = "/src/store/chatStore.ts"; await (await import(/* @vite-ignore */ path)).persistChatHistory(); });
    const total = await page.evaluate(async () => { const path = "/src/services/chatHistory.ts"; const messages = await (await import(/* @vite-ignore */ path)).readChatHistory("session", undefined, 1000); return { count: messages.length, first: messages[0].text, last: messages[messages.length - 1].text }; });
    expect(total).toEqual({ count: 500, first: "Histórico anterior 0", last: "Histórico anterior 499" });
    expect((await state(page)).draft).toBe("Rascunho antigo");
  });
  test("high lifetime usage does not compact a small context and opt-out is respected", async ({ page }) => {
    await setup(page); await openSession(page); await seed(page, { contextPrompts: 1, contextTokens: 1000, totalUsage: { inputTokens: 900000, cachedInputTokens: 0, outputTokens: 200000 } });
    await send(page); await expect.poll(async () => (await state(page)).busy).toBe(false);
    await seed(page, { contextPrompts: 100, contextTokens: 100000, compactionPolicy: { enabled: false, maxPrompts: 20, maxTokens: 64000 } });
    await send(page, "Continuar com compactação desativada");
    await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_chat_turn").length)).toBe(2);
    const flags = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_chat_turn").map((c: any) => c.args.request.compactBeforeTurn));
    expect(flags).toEqual([false, false]);
  });
  test("stopping compaction keeps the pending request and ignores late completion", async ({ page }) => {
    await setup(page); await openSession(page); await seed(page); await page.evaluate(() => { (window as any).__compactionDelay = 2000; });
    await send(page, "Continuar depois de interromper"); await expect(page.locator(".ad-chat-progress")).toContainText("Compactando contexto");
    await page.getByRole("button", { name: "Parar resposta", exact: true }).click();
    await expect(page.locator(".ad-chat-composer textarea")).toHaveValue("Continuar depois de interromper");
    await page.evaluate(() => { const w = window as any; w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "compaction", itemId: "late", status: "before-turn" }); });
    const thread = await state(page); expect(thread.busy).toBe(false); expect(thread.compacting).toBe(false); expect(thread.compactionCount ?? 0).toBe(0); expect(thread.providerSessionId).toBe("existing-session");
  });
}
