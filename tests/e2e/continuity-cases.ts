import { test, expect, type Page } from "@playwright/test";

export function continuityCases(setup: (page: Page, locale?: string) => Promise<void>, openSession: (page: Page) => Promise<void>) {
  const state = (page: Page, id = "session") => page.evaluate(async sessionId => {
    const path = "/src/store/chatStore.ts";
    const store = await import(/* @vite-ignore */ path);
    await store.chatHistoryReady;
    return store.useChatStore.getState().threads[sessionId];
  }, id);
  const requests = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_chat_turn").map((c: any) => c.args.request));
  async function seed(page: Page, patch: object = {}) {
    await page.evaluate(async value => {
      const path = "/src/store/chatStore.ts";
      const store = await import(/* @vite-ignore */ path);
      await store.chatHistoryReady;
      store.useChatStore.getState().patch("session", {
        providerSessionId: "existing-session", contextPrompts: 1, contextTokens: 1000,
        compactionPolicy: { enabled: true, maxPrompts: 50, maxTokens: 200000, version: 2 }, ...value,
      });
      (window as any).__autoComplete = true;
    }, patch);
  }
  async function send(page: Page, text: string) {
    await page.locator(".ad-chat-composer textarea").fill(text);
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect.poll(async () => (await state(page)).busy).toBe(false);
  }
  for (const provider of ["Claude Code", "OpenAI Codex"]) {
    test(`${provider} continuity protects the measured context window during the post-compaction cooldown`, async ({ page }) => {
      await setup(page); await openSession(page);
      await page.getByRole("button", { name: provider, exact: true }).click();
      await seed(page, {
        contextPrompts: 1, contextTokens: 120000, contextTokensEstimated: false, contextWindow: 128000,
        compactionCount: 1, lastCompactedAt: Date.now(),
        compactionPolicy: { enabled: true, maxPrompts: 50, maxTokens: 500000, version: 2 },
      });
      await send(page, "Preserve the decisions. " + "x".repeat(18000));
      expect((await requests(page))[0]).toMatchObject({ compactBeforeTurn: true, providerSessionId: "existing-session" });
      expect((await state(page)).compactionCount).toBe(2);
      expect((await state(page)).contextWindow).toBe(128000);
    });

    test(`${provider} continuity includes the conversation goal in the compaction budget`, async ({ page }) => {
      await setup(page); await openSession(page);
      await page.getByRole("button", { name: provider, exact: true }).click();
      const goal = "Preserve this objective: " + "a".repeat(18000);
      await seed(page, { contextPrompts: 1, contextTokens: 196000, goal, lastSentGoal: "Previous objective" });
      await send(page, "Continue with the objective");
      expect((await requests(page))[0]).toMatchObject({ compactBeforeTurn: true, providerSessionId: "existing-session" });
      expect((await requests(page))[0].prompt).toContain(goal);
    });

    test(`${provider} continuity creates a separate chat with the complete archived transcript and an unsent draft`, async ({ page }) => {
      await setup(page); await openSession(page);
      await page.getByRole("button", { name: provider, exact: true }).click();
      await seed(page, { contextWindow: 128000, contextTokens: 85000, contextTokensEstimated: false });
      await page.evaluate(async () => {
        const path = "/src/store/chatStore.ts";
        const { useChatStore, persistChatHistory } = await import(/* @vite-ignore */ path);
        const sessionPath = "/src/store/sessionStore.ts";
        const { useSessionStore } = await import(/* @vite-ignore */ sessionPath);
        useSessionStore.getState().updateSession("session", {
          providerSessionId: "existing-session", worktreePath: "C:\\Projects\\Test Project\\.worktrees\\feature",
          branchName: "feature/continuity", baseBranch: "main",
        });
        useChatStore.getState().patch("session", {
          goal: "Preserve the original architectural decision", draft: "Pending request that must survive",
          messages: Array.from({ length: 420 }, (_, i) => ({
            id: `continuity-${i}`, turnId: `old-${i}`, role: i % 2 ? "assistant" : "user", at: i + 1,
            text: i === 0 ? "ORIGINAL_DECISION_ARCHIVED" : i === 419 ? "LATEST_VERIFICATION_PASSED" : `History entry ${i}`,
            ...(i === 2 ? { attachments: [{ name: "original.txt", path: "C:\\Context\\original.txt", mimeType: "text/plain", size: 99 }] } : {}),
          })),
        });
        await persistChatHistory();
      });
      expect((await state(page)).messages.length).toBeLessThanOrEqual(200);
      await page.locator(".ad-chat-context summary").click();
      if (provider === "OpenAI Codex") await page.screenshot({ path: ".local/validation/chat-continuity/context-controls.png" });
      await page.locator(".ad-chat-context").getByRole("button", { name: "Novo chat com contexto", exact: true }).click();
      const review = page.getByRole("dialog", { name: "Revise o contexto a transferir" });
      await expect(review).toBeVisible();
      await expect(review.getByRole("textbox")).toHaveValue(/ORIGINAL_DECISION_ARCHIVED/);
      await expect(review.getByRole("textbox")).toHaveValue(/LATEST_VERIFICATION_PASSED/);
      expect(await requests(page)).toHaveLength(0);
      await review.getByRole("button", { name: "Criar conversa com este contexto", exact: true }).click();
      await expect.poll(() => page.evaluate(async () => {
        const path = "/src/store/sessionStore.ts";
        return (await import(/* @vite-ignore */ path)).useSessionStore.getState().activeSessionId;
      })).not.toBe("session");
      const targetId = await page.evaluate(async () => {
        const path = "/src/store/sessionStore.ts";
        return (await import(/* @vite-ignore */ path)).useSessionStore.getState().activeSessionId;
      });
      expect(targetId).toBeTruthy(); expect(targetId).not.toBe("session");
      const target = await state(page, targetId!);
      expect(target.providerSessionId).toBeUndefined(); expect(target.busy).toBe(false);
      expect(target.goal).toBeUndefined();
      expect(target.draft).toContain("Preserve the original architectural decision");
      expect(target.continuation).toMatchObject({ sourceSessionId: "session", messageCount: 420 });
      const requiresFurtherReview = await page.evaluate(async id => {
        const deliveries = (await import("/src/store/sourceDeliveryStore.ts" as string)).useSourceDeliveryStore;
        deliveries.getState().delivered(id, 1);
        return (await import("/src/services/chatContinuity.ts" as string)).continuationNeedsSourceReview(id);
      }, targetId!);
      expect(requiresFurtherReview).toBe(true);
      expect(target.draft).toContain("Pending request that must survive");
      expect(target.draft).toContain("ORIGINAL_DECISION_ARCHIVED");
      expect(target.draft).toContain("LATEST_VERIFICATION_PASSED");
      expect(target.draft).not.toContain(target.continuation.archivePath);
      expect(target.draft.length).toBeLessThan(40000);
      expect(await requests(page)).toHaveLength(0);
      const transfer = await page.evaluate(() => {
        const saved = (window as any).__calls.find((c: any) => c.command === "save_chat_attachment");
        return { args: saved.args, archive: JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(saved.args.dataBase64), ch => ch.charCodeAt(0)))) };
      });
      expect(transfer.args).toMatchObject({ sessionId: "session", mimeType: "application/json" });
      expect(transfer.archive).toMatchObject({ format: "agentdeck-chat-continuation", version: 1, goal: "Preserve the original architectural decision", draft: "Pending request that must survive" });
      expect(transfer.archive.messages).toHaveLength(420);
      expect(transfer.archive.messages[0].text).toBe("ORIGINAL_DECISION_ARCHIVED");
      expect(transfer.archive.messages[419].text).toBe("LATEST_VERIFICATION_PASSED");
      expect(transfer.archive.messages[2].attachments[0].path).toBe("C:\\Context\\original.txt");
      expect(transfer.archive.session).toMatchObject({ id: "session", providerSessionId: "existing-session", branchName: "feature/continuity", baseBranch: "main" });
      const original = await state(page);
      expect(original.providerSessionId).toBe("existing-session"); expect(original.draft).toBe("Pending request that must survive");
      const targetSession = await page.evaluate(async id => {
        const path = "/src/store/sessionStore.ts";
        return (await import(/* @vite-ignore */ path)).useSessionStore.getState().sessions.find((s: any) => s.id === id);
      }, targetId);
      expect(targetSession).toMatchObject({ workdir: "C:\\Projects\\Test Project", worktreePath: "C:\\Projects\\Test Project\\.worktrees\\feature", branchName: "feature/continuity", runner: { type: provider === "Claude Code" ? "claude-code" : "codex" } });
      expect(targetSession.providerSessionId).toBeUndefined();
      if (provider === "OpenAI Codex") await page.screenshot({ path: ".local/validation/chat-continuity/new-chat.png" });
      await page.reload();
      expect((await state(page, targetId!)).continuation).toMatchObject({ sourceSessionId: "session", messageCount: 420 });
      expect((await state(page, targetId!)).draft).toContain("Pending request that must survive");
      expect((await state(page)).providerSessionId).toBe("existing-session");
      expect(await requests(page)).toHaveLength(0);
    });
  }

  test("continuity rejects an oversized prompt without launching and keeps it available for editing", async ({ page }) => {
    await setup(page); await openSession(page); await seed(page, { contextWindow: 32000 });
    const prompt = "x".repeat(2 * 1024 ** 2 + 1);
    await page.locator(".ad-chat-composer textarea").fill(prompt);
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.locator(".ad-chat-composer textarea")).toHaveValue(prompt);
    expect(await requests(page)).toHaveLength(0);
    expect((await state(page)).busy).toBe(false);
    await expect(page.locator(".ad-chat-error[role=alert]")).toBeVisible();
  });

  test("continuity rejects an oversized supplement without disturbing the active response", async ({ page }) => {
    await setup(page); await openSession(page); await seed(page, { contextWindow: 32000 });
    await page.evaluate(() => { (window as any).__autoComplete = false; });
    await page.locator(".ad-chat-composer textarea").fill("Continue the active review");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Architecture review" })).toBeVisible();
    const before = await state(page);
    const prompt = "x".repeat(2 * 1024 ** 2 + 1);
    await page.locator(".ad-chat-composer textarea").fill(prompt);
    await page.getByRole("button", { name: "Enviar complemento", exact: true }).click();
    await expect(page.locator(".ad-chat-composer textarea")).toHaveValue(prompt);
    const current = await state(page);
    expect(current.busy).toBe(true); expect(current.turnId).toBe(before.turnId);
    expect(current.error).toBeUndefined();
    expect(current.messages.map((m: any) => m.id)).toEqual(before.messages.map((m: any) => m.id));
    expect(current.providerSessionId).toBe("existing-session");
    expect(await requests(page)).toHaveLength(1);
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "steer_chat_turn").length)).toBe(0);
    await expect(page.locator(".ad-chat-error[role=alert]")).toBeVisible();
    await page.evaluate(() => {
      const w = window as any;
      w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "done", status: "completed" });
    });
    const finished = await state(page);
    expect(finished.busy).toBe(false); expect(finished.status).toBe("completed"); expect(finished.error).toBeUndefined();
    expect(await page.evaluate(async () => { const path = "/src/store/sessionStore.ts"; return (await import(/* @vite-ignore */ path)).useSessionStore.getState().sessions.find((s: any) => s.id === "session").status; })).toBe("waiting");
  });

  test("continuity transfer failure keeps the original draft and provider binding without creating a chat", async ({ page }) => {
    await setup(page); await openSession(page); await seed(page, { draft: "Do not lose this pending work", goal: "Keep the project constraints" });
    await page.evaluate(() => {
      const w = window as any; const original = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
        if (command === "save_chat_attachment") throw new Error("Archive write failed");
        return original(command, args);
      };
    });
    const result = await page.evaluate(async () => {
      const path = "/src/services/chatContinuity.ts";
      try { await (await import(/* @vite-ignore */ path)).createChatContinuation("session", "pt-BR", { reviewedDraft: "User-reviewed pending work" }); return "unexpected success"; }
      catch (error) { return String(error); }
    });
    expect(result).toContain("Archive write failed");
    expect((await state(page)).draft).toBe("Do not lose this pending work");
    expect((await state(page)).providerSessionId).toBe("existing-session");
    expect(await page.evaluate(async () => { const path = "/src/store/sessionStore.ts"; return (await import(/* @vite-ignore */ path)).useSessionStore.getState().sessions.map((s: any) => s.id); })).toEqual(["session"]);
    expect(await requests(page)).toHaveLength(0);
  });

  test("continuity preserves a large UTF-8 transcript losslessly across bounded archive parts", async ({ page }) => {
    test.setTimeout(60000);
    await setup(page); await openSession(page); await seed(page);
    const result = await page.evaluate(async () => {
      const path = "/src/store/chatStore.ts";
      const store = await import(/* @vite-ignore */ path);
      const content = "á🙂漢".repeat(25000);
      store.useChatStore.getState().patch("session", {
        messages: Array.from({ length: 60 }, (_, i) => ({ id: `large-${i}`, turnId: `old-${i}`, role: i % 2 ? "assistant" : "user", at: i + 1, text: `Entry ${i}: ${content}` })),
        draft: "Continue from the complete large transcript",
      });
      await store.persistChatHistory();
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const renderedBodies = [...document.querySelectorAll(".ad-message-body")];
      const rendered = { count: renderedBodies.length, textLength: renderedBodies.reduce((sum, body) => sum + (body.textContent?.length ?? 0), 0), latest: renderedBodies.at(-1)?.textContent?.startsWith("Entry 59:") };
      const w = window as any; const original = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
        const value = await original(command, args);
        return command === "save_chat_attachment" ? { ...value, size: atob(args.dataBase64).length } : value;
      };
      const continuityPath = "/src/services/chatContinuity.ts";
      const service = await import(/* @vite-ignore */ continuityPath);
      const reviewedDraft = await service.prepareReviewedContext("session", "pt-BR");
      const id = await service.createChatContinuation("session", "pt-BR", { reviewedDraft });
      const saves = w.__calls.filter((c: any) => c.command === "save_chat_attachment");
      const manifestCall = saves.find((c: any) => c.args.name === "conversation-context-index.json");
      const decode = (value: string) => Uint8Array.from(atob(value), ch => ch.charCodeAt(0));
      const manifest = JSON.parse(new TextDecoder().decode(decode(manifestCall.args.dataBase64)));
      const partBytes = manifest.parts.map((part: any) => {
        const saved = saves.find((c: any) => part.path.endsWith(c.args.name));
        return decode(saved.args.dataBase64);
      });
      const fullBytes = new Uint8Array(partBytes.reduce((sum: number, part: Uint8Array) => sum + part.length, 0));
      let offset = 0;
      for (const part of partBytes) { fullBytes.set(part, offset); offset += part.length; }
      const archive = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fullBytes));
      const target = store.useChatStore.getState().threads[id];
      return {
        manifest, rendered, sizes: partBytes.map((part: Uint8Array) => part.length), byteLength: fullBytes.length,
        count: archive.messages.length, exact: archive.messages.every((m: any, i: number) => m.text === `Entry ${i}: ${content}`),
        draftLength: target.draft.length, draftWellFormed: new TextDecoder().decode(new TextEncoder().encode(target.draft)) === target.draft, targetCount: target.continuation.messageCount,
        sourceId: store.useChatStore.getState().threads.session.providerSessionId,
      };
    });
    expect(result.manifest).toMatchObject({ format: "agentdeck-chat-continuation-parts", version: 1, encoding: "utf-8", messageCount: 60 });
    expect(result.sizes.length).toBeGreaterThan(1);
    expect(result.sizes.every((size: number) => size <= 8 * 1024 ** 2)).toBe(true);
    expect(result.manifest.byteLength).toBe(result.byteLength);
    expect(result.count).toBe(60); expect(result.exact).toBe(true); expect(result.targetCount).toBe(60);
    expect(result.draftLength).toBeLessThan(40000); expect(result.sourceId).toBe("existing-session");
    expect(result.draftWellFormed).toBe(true);
    expect(result.rendered.count).toBeLessThan(80); expect(result.rendered.textLength).toBeLessThanOrEqual(160000); expect(result.rendered.latest).toBe(true);
    expect(await requests(page)).toHaveLength(0);
  });

  test("continuity pages large messages without skipping archived entries or enlarging the rendered text", async ({ page }) => {
    test.setTimeout(60000);
    await setup(page); await openSession(page); await seed(page);
    const archived = await page.evaluate(async () => {
      const storePath = "/src/store/chatStore.ts";
      const store = await import(/* @vite-ignore */ storePath);
      const content = "á🙂漢".repeat(25000);
      store.useChatStore.getState().patch("session", { messages: Array.from({ length: 60 }, (_, i) => ({ id: `page-${i}`, turnId: `page-turn-${i}`, role: i % 2 ? "assistant" : "user", at: i + 1, text: `Entry ${i}: ${content}` })) });
      await store.persistChatHistory();
      const historyPath = "/src/services/chatHistory.ts";
      const messages = await (await import(/* @vite-ignore */ historyPath)).readChatHistory("session", undefined, Number.MAX_SAFE_INTEGER);
      return { count: messages.length, exact: messages.every((message: any, i: number) => message.text === `Entry ${i}: ${content}`) };
    });
    expect(archived).toEqual({ count: 60, exact: true });
    const renderedPage = () => page.locator(".ad-chat-messages .ad-message-body").evaluateAll(bodies => ({
      count: bodies.length,
      textLength: bodies.reduce((sum, body) => sum + (body.textContent?.length ?? 0), 0),
      entries: bodies.map(body => Number(body.textContent?.match(/^Entry (\d+):/)?.[1])),
    }));
    await expect.poll(async () => (await renderedPage()).entries).toEqual([59]);
    const older = page.getByRole("button", { name: "Ver mensagens anteriores", exact: true });
    for (const entry of [58, 57]) {
      await older.click();
      await expect.poll(async () => (await renderedPage()).entries).toEqual([entry]);
      const rendered = await renderedPage();
      expect(rendered.count).toBeLessThan(80); expect(rendered.textLength).toBeLessThanOrEqual(160000);
    }
    await page.getByRole("button", { name: "Voltar às mensagens recentes", exact: true }).click();
    await expect.poll(async () => (await renderedPage()).entries).toEqual([59]);
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await page.locator(".ad-chat-search input").fill("Entry 10:");
    await expect.poll(async () => (await renderedPage()).entries).toEqual([10]);
    expect((await renderedPage()).textLength).toBeLessThanOrEqual(160000);
    expect(await requests(page)).toHaveLength(0);
  });

  test("continuity refuses an incomplete history transfer when archived storage cannot be read", async ({ page }) => {
    await setup(page); await openSession(page); await seed(page);
    await page.evaluate(async () => {
      const path = "/src/store/chatStore.ts"; const store = await import(/* @vite-ignore */ path);
      store.useChatStore.getState().patch("session", {
        draft: "Keep all archived decisions", messages: Array.from({ length: 300 }, (_, i) => ({ id: `protected-${i}`, turnId: `old-${i}`, role: "user", at: i + 1, text: `Decision ${i}` })),
      });
      await store.persistChatHistory();
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = (() => { throw new Error("Archive read unavailable"); }) as any;
      (window as any).__restoreContinuityTransaction = () => { IDBDatabase.prototype.transaction = original; };
    });
    expect((await state(page)).archivedCount).toBeGreaterThan(0);
    const result = await page.evaluate(async () => {
      const path = "/src/services/chatContinuity.ts";
      try { await (await import(/* @vite-ignore */ path)).createChatContinuation("session", "pt-BR", { reviewedDraft: "User-reviewed pending work" }); return "unexpected success"; }
      catch (error) { return String(error); }
      finally { (window as any).__restoreContinuityTransaction(); }
    });
    expect(result).not.toBe("unexpected success");
    expect((await state(page)).draft).toBe("Keep all archived decisions");
    expect((await state(page)).providerSessionId).toBe("existing-session");
    expect(await page.evaluate(async () => { const path = "/src/store/sessionStore.ts"; return (await import(/* @vite-ignore */ path)).useSessionStore.getState().sessions.map((s: any) => s.id); })).toEqual(["session"]);
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "save_chat_attachment").length)).toBe(0);
    expect(await requests(page)).toHaveLength(0);
  });

  test("continuity rolls back a new chat when saving its draft fails", async ({ page }) => {
    await setup(page); await openSession(page); await seed(page, { draft: "Keep the source draft durable" });
    const result = await page.evaluate(async () => {
      const w = window as any; const originalInvoke = w.__TAURI_INTERNALS__.invoke;
      const originalTransaction = IDBDatabase.prototype.transaction;
      w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
        const value = await originalInvoke(command, args);
        if (command === "save_chat_attachment") IDBDatabase.prototype.transaction = (() => { throw new Error("Target draft write failed"); }) as any;
        return value;
      };
      const path = "/src/services/chatContinuity.ts";
      try { await (await import(/* @vite-ignore */ path)).createChatContinuation("session", "pt-BR", { reviewedDraft: "User-reviewed pending work" }); return "unexpected success"; }
      catch (error) { return String(error); }
      finally { IDBDatabase.prototype.transaction = originalTransaction; }
    });
    expect(result).not.toBe("unexpected success");
    expect((await state(page)).draft).toBe("Keep the source draft durable");
    expect((await state(page)).providerSessionId).toBe("existing-session");
    const sessions = await page.evaluate(async () => {
      const path = "/src/store/sessionStore.ts"; const store = (await import(/* @vite-ignore */ path)).useSessionStore.getState();
      return { ids: store.sessions.map((s: any) => s.id), active: store.activeSessionId };
    });
    expect(sessions).toEqual({ ids: ["session"], active: "session" });
    expect(await requests(page)).toHaveLength(0);
  });

  test("continuity retains the provider's measured summary size and rejects subagent window measurements", async ({ page }) => {
    await setup(page); await openSession(page); await seed(page);
    await page.evaluate(() => { (window as any).__autoComplete = false; });
    await page.locator(".ad-chat-composer textarea").fill("Review the retained summary");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Architecture review" })).toBeVisible();
    await page.evaluate(() => {
      const w = window as any; const base = { sessionId: "session", turnId: w.__chatTurns.session };
      w.__emit("chat-event", { ...base, kind: "compaction", itemId: "main-summary", status: "automatic", contextTokens: 50000, contextWindow: 128000 });
      w.__emit("chat-event", { ...base, kind: "status", parentId: "child", contextTokens: 900000, contextWindow: 1000000 });
      w.__emit("chat-event", { ...base, kind: "done", status: "completed" });
    });
    const thread = await state(page);
    expect(thread.contextTokens).toBe(50000); expect(thread.contextTokensEstimated).toBe(false);
    expect(thread.contextWindow).toBe(128000); expect(thread.compactionCount).toBe(1);
    expect(thread.contextPrompts).toBe(0);
  });

  test("continuity MCP authentication warnings preserve meaningful activity and keep recovery visible", async ({ page }) => {
    await setup(page); await openSession(page);
    await page.getByRole("button", { name: "OpenAI Codex", exact: true }).click();
    await page.locator(".ad-chat-composer textarea").fill("Continue the project review");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Architecture review" })).toBeVisible();
    const at = await page.evaluate(async () => {
      const path = "/src/store/chatStore.ts"; const store = await import(/* @vite-ignore */ path);
      const at = Date.now() - 250000;
      store.useChatStore.getState().patch("session", { status: "reasoning", activity: "Reviewing the architecture", lastEventAt: at });
      const w = window as any;
      for (let i = 0; i < 3; i++) w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "status", status: "mcp-auth-warning", text: "MCP authentication failed for server miro. Refresh OAuth login to reconnect." });
      w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "status", status: "diagnostic", text: "Temporary connection warning" });
      return at;
    });
    const thread = await state(page);
    expect(thread.busy).toBe(true); expect(thread.status).toBe("reasoning");
    expect(thread.activity).toBe("Reviewing the architecture"); expect(thread.lastEventAt).toBe(at);
    expect(thread.mcpAuthWarning).toContain("miro");
    expect(thread.diagnostic).toContain("Temporary connection warning");
    await expect(page.locator(".ad-chat-progress")).toContainText("Agente pensando");
    await expect(page.locator(".ad-chat-stall")).toContainText("Sem nova atividade há");
    await expect(page.getByRole("button", { name: "Verificar processo", exact: true })).toBeVisible();
    await expect(page.locator(".ad-chat")).toContainText("miro");
    await page.screenshot({ path: ".local/validation/chat-continuity/mcp-recovery.png" });
  });

  test("continuity prepares a recovery follow-up without replaying a request and retains the existing draft", async ({ page }) => {
    await setup(page); await openSession(page);
    await page.locator(".ad-chat-composer textarea").fill("Make the requested changes");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Architecture review" })).toBeVisible();
    await page.locator(".ad-chat-composer textarea").fill("Also preserve the verification evidence");
    await page.evaluate(() => {
      const w = window as any; const base = { sessionId: "session", turnId: w.__chatTurns.session };
      w.__emit("chat-event", { ...base, kind: "tool", itemId: "saved-work", title: "Terminal", command: "git status", output: "Work already completed", status: "completed" });
      w.__emit("chat-event", { ...base, kind: "error", status: "recovery-required", text: "Provider stopped after reconnecting. Review completed work before continuing." });
      w.__emit("chat-event", { ...base, kind: "done", status: "error" });
    });
    await expect(page.getByRole("button", { name: "Preparar pedido de continuação", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Preparar pedido de continuação", exact: true }).click();
    const recovered = await state(page);
    expect(recovered.draft).toContain("Also preserve the verification evidence");
    expect(recovered.draft).toContain("retome apenas o que falta");
    expect(recovered.providerSessionId).toBe("native-chat-session");
    expect(recovered.messages.find((m: any) => m.id.endsWith(":saved-work"))).toMatchObject({ output: "Work already completed", status: "completed" });
    expect(await requests(page)).toHaveLength(1);
    expect(recovered.busy).toBe(false);
  });
}
