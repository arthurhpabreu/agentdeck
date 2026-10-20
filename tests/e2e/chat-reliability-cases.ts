import { test, expect, type Page } from "@playwright/test";

export function chatReliabilityCases(setup: (page: Page, locale?: string) => Promise<void>, openSession: (page: Page) => Promise<void>) {
  const state = (page: Page) => page.evaluate(async () => { const path = "/src/store/chatStore.ts"; return (await import(/* @vite-ignore */ path)).useChatStore.getState().threads.session; });
  async function start(page: Page) {
    await setup(page); await openSession(page);
    await page.locator(".ad-chat-composer textarea").fill("Verify chat event reliability");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Architecture review" })).toBeVisible();
  }
  test("chat reliability delivers large Unicode additional input intact and preserves a newer draft on asynchronous failure @macos", async ({ page }) => {
    await start(page);
    await page.evaluate(() => {
      const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = (command: string, args: any) => {
        if (command === "steer_chat_turn") { w.__largeSupplement = args; return Promise.resolve("sending"); }
        return original(command, args);
      };
    });
    const prompt = "REVISÃO INTEGRAL\n" + "Ação e contexto — 漢字 🔍\n".repeat(12000) + "FIM DO CONTEXTO";
    await page.locator(".ad-chat-composer textarea").evaluate((element, text) => {
      const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", text);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles:true, cancelable:true }));
    }, prompt);
    await expect(page.locator(".ad-chat-composer textarea")).toHaveValue(prompt);
    await page.getByRole("button", { name:"Enviar complemento", exact:true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__largeSupplement?.request.prompt.length)).toBe(prompt.length);
    expect(await page.evaluate(() => (window as any).__largeSupplement.request.prompt)).toBe(prompt);
    await page.locator(".ad-chat-composer textarea").fill("Continue preservando meu novo rascunho");
    await page.evaluate(() => {
      const w = window as any; w.__emit("chat-event", { sessionId:"session", turnId:w.__chatTurns.session, kind:"input", itemId:w.__largeSupplement.messageId, status:"failed", text:"Provider did not confirm this input" });
    });
    await expect(page.locator(".ad-chat-composer textarea")).toHaveValue("Continue preservando meu novo rascunho");
    await expect(page.locator(".ad-chat-error[role=alert]")).toContainText("Provider did not confirm this input");
    const current = await state(page); expect(current.busy).toBe(true);
    expect(current.messages.find((m: any) => m.text === prompt).status).toBe("failed");
  });
  test("chat reliability treats the conservative token estimate as advisory for additional input @macos", async ({ page }) => {
    await start(page);
    const result = await page.evaluate(async () => {
      const path = "/src/store/chatStore.ts"; const chat = await import(/* @vite-ignore */ path);
      chat.useChatStore.getState().patch("session", { contextWindow:32000 });
      const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = (command: string, args: any) => {
        if (command === "steer_chat_turn") { w.__estimatedSupplement = args.request.prompt; return Promise.resolve("queued"); }
        return original(command, args);
      };
      const prompt = "x".repeat(120000);
      const ok = await chat.sendChatTurn("session", prompt, []);
      return { ok, exact:w.__estimatedSupplement === prompt, busy:chat.useChatStore.getState().threads.session.busy };
    });
    expect(result).toEqual({ ok:true, exact:true, busy:true });
  });
  test("chat lifecycle tool results survive progress replays within a frame and after the final response", async ({ page }) => {
    await start(page);
    await page.evaluate(() => {
      const w = window as any; const base = { sessionId: "session", turnId: w.__chatTurns.session, kind: "tool" };
      for (const itemId of ["same-frame", "later-progress"]) {
        w.__emit("chat-event", { ...base, itemId, title: "Bash", command: `echo ${itemId}`, status: "running" });
        w.__emit("chat-event", { ...base, itemId, output: "Command completed", exitCode: 0, status: "completed" });
      }
      w.__emit("chat-event", { ...base, itemId: "same-frame", status: "running", elapsedSeconds: 12 });
      w.__emit("chat-event", { ...base, kind: "status", status: "finishing" });
    });
    for (const command of ["echo same-frame", "echo later-progress"]) {
      await expect(page.locator(".ad-tool-card").filter({ hasText: command }).locator("summary")).toContainText("Concluído");
    }
    await page.evaluate(() => {
      const w = window as any;
      w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "tool", itemId: "later-progress", status: "running", elapsedSeconds: 25 });
    });
    await expect.poll(async () => (await state(page)).messages.find((m: any) => m.id.endsWith(":later-progress"))?.elapsedSeconds).toBe(25);
    const thread = await state(page);
    expect(thread.busy).toBe(true); expect(thread.status).toBe("finishing");
    expect(thread.messages.filter((m: any) => ["same-frame", "later-progress"].some(id => m.id.endsWith(`:${id}`))).map((m: any) => m.status)).toEqual(["completed", "completed"]);
    await expect(page.locator(".ad-tool-card").filter({ hasText: "echo later-progress" }).locator("summary")).toContainText("Concluído");
    const tools = await page.evaluate(async () => { const path = "/src/store/agentObservabilityStore.ts"; return (await import(/* @vite-ignore */ path)).useAgentObservabilityStore.getState().live.session.tools; });
    expect(tools.filter((tool: any) => ["same-frame", "later-progress"].some(id => tool.id.endsWith(`:${id}`))).map((tool: any) => tool.status)).toEqual(["completed", "completed"]);
  });
  test("chat lifecycle keeps background work and queued input live until confirmed completion clears activity", async ({ page }) => {
    await start(page);
    await page.evaluate(() => {
      const w = window as any; const invoke = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = (command: string, args: any) => command === "steer_chat_turn" ? Promise.resolve("queued") : invoke(command, args);
    });
    await page.locator(".ad-chat-composer textarea").fill("Follow up after the background task");
    await page.getByRole("button", { name: "Enviar complemento", exact: true }).click();
    await page.evaluate(() => {
      const w = window as any; const base = { sessionId: "session", turnId: w.__chatTurns.session, kind: "tool" };
      for (const [itemId, status] of [["background", "running"], ["started", "started"], ["pending", "pending"], ["queued", "queued"], ["implicit", undefined], ["denied", "blocked"], ["failed", "failed"]]) {
        w.__emit("chat-event", { ...base, itemId, status, title: itemId, command: `task ${itemId}` });
      }
      w.__emit("chat-event", { ...base, itemId: "child-background", parentId: "child", title: "Child task", status: "running" });
      w.__emit("chat-event", { ...base, kind: "text", itemId: "final-answer", text: "Main answer is ready while native work remains." });
      w.__emit("chat-event", { ...base, kind: "status", status: "finishing" });
    });
    let thread = await state(page);
    expect(thread.busy).toBe(true); expect(thread.status).toBe("finishing");
    expect(thread.messages.find((m: any) => m.text === "Follow up after the background task").status).toBe("queued");
    await expect(page.locator(".ad-turn-activity")).toBeVisible();
    await expect(page.locator(".ad-tool-card").filter({ hasText: "task background" }).locator("summary")).toContainText("Executando");
    await page.evaluate(() => { const w = window as any; w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "done", status: "completed" }); });
    await expect(page.locator(".ad-turn-activity")).toHaveCount(0);
    thread = await state(page);
    expect(thread.busy).toBe(false); expect(thread.status).toBe("completed"); expect(thread.activity).toBeUndefined();
    for (const id of ["background", "started", "pending", "queued", "implicit", "child-background"]) expect(thread.messages.find((m: any) => m.id.endsWith(`:tool:${id}`)).status).toBe("completed");
    expect(thread.messages.find((m: any) => m.id.endsWith(":denied")).status).toBe("blocked");
    expect(thread.messages.find((m: any) => m.id.endsWith(":failed")).status).toBe("failed");
    expect(thread.messages.find((m: any) => m.text === "Follow up after the background task").status).toBe("failed");
    const activity = await page.evaluate(async () => {
      const activityPath = "/src/store/agentActivityStore.ts", observedPath = "/src/store/agentObservabilityStore.ts", sessionPath = "/src/store/sessionStore.ts";
      return { phase: (await import(/* @vite-ignore */ activityPath)).useAgentActivityStore.getState().sessions.session.phase,
        tools: (await import(/* @vite-ignore */ observedPath)).useAgentObservabilityStore.getState().live.session.tools,
        session: (await import(/* @vite-ignore */ sessionPath)).useSessionStore.getState().sessions.find((s: any) => s.id === "session").status };
    });
    expect(activity.phase).toBe("done"); expect(activity.session).toBe("waiting");
    for (const id of ["background", "started", "pending", "queued", "implicit", "child-background"]) expect(activity.tools.find((tool: any) => tool.id.endsWith(`:${id}`)).status).toBe("completed");
    expect(activity.tools.find((tool: any) => tool.id.endsWith(":denied")).status).toBe("blocked");
    expect(activity.tools.find((tool: any) => tool.id.endsWith(":failed")).status).toBe("failed");
  });
  for (const ending of ["stopped", "error"]) test(`chat lifecycle ${ending} completion interrupts unfinished tools without claiming success`, async ({ page }) => {
    await start(page);
    await page.evaluate(ending => {
      const w = window as any; const base = { sessionId: "session", turnId: w.__chatTurns.session, kind: "tool" };
      w.__emit("chat-event", { ...base, itemId: "unfinished", title: "Bash", command: "long-running-task", status: "running" });
      w.__emit("chat-event", { ...base, itemId: "failed", title: "Failed task", status: "failed" });
      w.__emit("chat-event", { ...base, kind: "done", status: ending });
    }, ending);
    await expect(page.locator(".ad-turn-activity")).toHaveCount(0);
    await expect(page.locator(".ad-tool-card").filter({ hasText: "long-running-task" }).locator("summary")).toContainText("Interrompido");
    const thread = await state(page);
    expect(thread.busy).toBe(false); expect(thread.status).toBe(ending);
    expect(thread.messages.find((m: any) => m.id.endsWith(":unfinished")).status).toBe("interrupted");
    expect(thread.messages.find((m: any) => m.id.endsWith(":failed")).status).toBe("failed");
    const tools = await page.evaluate(async () => { const path = "/src/store/agentObservabilityStore.ts"; return (await import(/* @vite-ignore */ path)).useAgentObservabilityStore.getState().live.session.tools; });
    expect(tools.find((tool: any) => tool.id.endsWith(":unfinished")).status).toBe("interrupted");
    expect(tools.find((tool: any) => tool.id.endsWith(":failed")).status).toBe("failed");
  });
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
      const w = window as any; const at = Date.now() - 250_000;
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
  test("chat reliability restores unconfirmed additional input after a missed delivery event", async ({ page }) => {
    await start(page);
    const result = await page.evaluate(async () => {
      const path = "/src/store/chatStore.ts", chat = await import(/* @vite-ignore */ path);
      const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = (command: string, args: any) => command === "steer_chat_turn" ? Promise.resolve("queued") : original(command, args);
      await chat.sendChatTurn("session", "Additional context still awaiting confirmation", []);
      const turnId = chat.useChatStore.getState().threads.session.turnId;
      chat.useChatStore.getState().event({ sessionId:"session", turnId, kind:"done", status:"interrupted" });
      const thread = chat.useChatStore.getState().threads.session;
      return { busy:thread.busy, draft:thread.draft, inputError:thread.inputError, status:thread.messages.at(-1).status };
    });
    expect(result).toMatchObject({ busy:false, draft:"Additional context still awaiting confirmation", status:"failed" });
    expect(result.inputError).toContain("did not confirm");
  });

  test("chat reliability preserves a newer draft when cancellation happens before launch", async ({ page }) => {
    await start(page);
    const result = await page.evaluate(async () => {
      const path = "/src/store/chatStore.ts", chat = await import(/* @vite-ignore */ path);
      const previous = chat.useChatStore.getState().threads.session;
      chat.useChatStore.getState().event({ sessionId:"session", turnId:previous.turnId, kind:"done", status:"completed" });
      const launch = chat.sendChatTurn("session", "Request canceled during initialization", []);
      // sendChatTurn first yields to the restored-history barrier, then yields
      // again before launch while listeners are checked.
      await Promise.resolve();
      chat.useChatStore.getState().patch("session", { draft:"Keep my newer notes" });
      const stopped = chat.stopChatTurn("session");
      const sent = await launch;
      await stopped;
      return { sent, draft:chat.useChatStore.getState().threads.session.draft, status:chat.useChatStore.getState().threads.session.status };
    });
    expect(result).toEqual({ sent:false, draft:"Keep my newer notes", status:"stopped" });
  });

  test("chat reliability preserves a newer draft when a queued addition continues after launch completes", async ({ page }) => {
    await start(page);
    const result = await page.evaluate(async () => {
      const path = "/src/store/chatStore.ts", chat = await import(/* @vite-ignore */ path);
      const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
      const previous = chat.useChatStore.getState().threads.session;
      chat.useChatStore.getState().event({ sessionId:"session", turnId:previous.turnId, kind:"done", status:"completed" });
      let release: (() => void) | undefined, starts = 0;
      w.__TAURI_INTERNALS__.invoke = (command: string, args: any) => {
        if (command === "start_chat_turn") {
          starts++;
          if (starts === 1) return new Promise<void>(resolve => { release = resolve; });
          return Promise.resolve();
        }
        return original(command, args);
      };
      const launch = chat.sendChatTurn("session", "First request", []);
      for (let i = 0; i < 20 && !release; i++) await new Promise(resolve => setTimeout(resolve, 0));
      if (!release) throw new Error("The mocked launch did not start");
      const addition = chat.sendChatTurn("session", "Follow-up queued during initialization", []);
      await Promise.resolve();
      const pending = chat.useChatStore.getState().threads.session;
      chat.useChatStore.getState().patch("session", { draft:"Keep notes typed after the follow-up" });
      chat.useChatStore.getState().event({ sessionId:"session", turnId:pending.turnId, kind:"done", status:"completed" });
      release();
      await launch;
      const sent = await addition;
      const thread = chat.useChatStore.getState().threads.session;
      return { sent, starts, draft:thread.draft, lastMessage:thread.messages.at(-1).text };
    });
    expect(result).toEqual({ sent:true, starts:2, draft:"Keep notes typed after the follow-up", lastMessage:"Follow-up queued during initialization" });
  });
}
