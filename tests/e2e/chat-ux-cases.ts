import { expect, test, type Page } from "@playwright/test";

export function chatUxCases(setup: (page: Page) => Promise<void>, open: (page: Page) => Promise<void>) {
  const state = (page: Page) => page.evaluate(async () => (await import("/src/store/chatStore.ts" as string)).useChatStore.getState().threads.session);
  async function start(page: Page) {
    await setup(page); await open(page);
    await page.locator(".ad-chat-composer textarea").fill("Verificar o projeto");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Architecture review" })).toBeVisible();
  }
  test("chat UX ignores terminal waiting hooks during a structured response and preserves latest interleaved activity", async ({ page }) => {
    await start(page);
    await page.evaluate(() => {
      const w = window as any, base = { sessionId: "session", turnId: w.__chatTurns.session };
      w.__emit("pty-waiting", { session_id: "session", source: "codex" });
      w.__emit("pty-notification", { session_id: "session", message: "idle prompt" });
      w.__emit("pty-exit", { session_id: "session", exit_code: 0 });
      w.__emit("chat-event", { ...base, kind: "text", itemId: "stream", text: "Primeira parte", delta: true });
      w.__emit("chat-event", { ...base, kind: "tool", itemId: "work", title: "Trabalho paralelo", status: "running" });
      w.__emit("chat-event", { ...base, kind: "text", itemId: "stream", text: " e continuação", delta: true });
    });
    await expect.poll(async () => (await state(page)).status).toBe("responding");
    await expect(page.locator(".ad-chat-progress").first()).toContainText("Escrevendo resposta");
    const result = await page.evaluate(async () => ({
      session: (await import("/src/store/sessionStore.ts" as string)).useSessionStore.getState().sessions[0].status,
      activity: (await import("/src/store/agentActivityStore.ts" as string)).useAgentActivityStore.getState().sessions.session.phase,
    }));
    expect(result).toEqual({ session: "running", activity: "running" });
  });
  for (const decision of ["accept", "cancel"]) test(`chat UX approval waits for the actual ${decision} decision and resolves the inbox`, async ({ page }) => {
    await start(page);
    await page.evaluate(() => {
      const w = window as any, invoke = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
        const result = await invoke(command, args);
        if (command === "respond_chat_interaction") w.__emit("chat-event", { sessionId: args.sessionId, turnId: args.turnId, kind: "interaction", status: "resolved", itemId: args.requestId });
        return result;
      };
      w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "interaction", interaction: { id: "native-approval", kind: "approval", blocking: true, command: "npm run build", cwd: "C:\\Project" } });
    });
    const approval = page.getByRole("region", { name: "Aprovação necessária" });
    await expect(approval).toBeVisible();
    await expect(page.locator(".ad-chat-progress").first()).toContainText("Aguardando sua resposta");
    expect(await page.evaluate(async () => (await import("/src/store/sessionStore.ts" as string)).useSessionStore.getState().sessions[0].status)).toBe("waiting");
    // Parallel native output cannot erase a blocking request's attention state.
    await page.evaluate(() => { const w = window as any; w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "status", status: "reasoning" }); });
    await expect.poll(() => page.evaluate(async () => (await import("/src/store/agentActivityStore.ts" as string)).useAgentActivityStore.getState().sessions.session.phase)).toBe("waiting");
    expect(await page.evaluate(() => (window as any).__calls.filter((call: any) => call.command === "respond_chat_interaction").length)).toBe(0);
    await approval.screenshot({ path: `test-results/chat-approval-pending-${decision}.png` });
    await approval.getByRole("button", { name: decision === "accept" ? "Aprovar esta ação" : "Recusar e parar", exact: true }).click();
    await expect(approval).toHaveCount(0);
    const response = await page.evaluate(() => (window as any).__calls.filter((call: any) => call.command === "respond_chat_interaction"));
    expect(response).toHaveLength(1); expect(response[0].args).toMatchObject({ sessionId: "session", requestId: "native-approval", response: { decision } });
    const unread = await page.evaluate(async () => (await import("/src/store/attentionStore.ts" as string)).useAttentionStore.getState().items.filter((item: any) => item.kind === "approval" && !item.read));
    expect(unread).toHaveLength(0);
    await page.screenshot({ path: `test-results/chat-approval-${decision}.png` });
  });
  test("chat UX labels optional questions without pretending that the agent stopped", async ({ page }) => {
    await start(page);
    await page.evaluate(() => {
      const w = window as any;
      w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "interaction", interaction: { id: "question", kind: "question", blocking: false, questions: [{ id: "q1", header: "Tema", question: "Qual tema?", options: [{ label: "Escuro", description: "Tema escuro" }, { label: "Claro", description: "Tema claro" }] }] } });
    });
    await expect(page.getByText("Pergunta opcional:", { exact: false })).toBeVisible();
    await expect(page.locator(".ad-chat-progress").first()).not.toContainText("Aguardando sua resposta");
    await expect(page.getByRole("button", { name: "Enviar resposta", exact: true })).toBeDisabled();
    await page.getByLabel("Qual tema?", { exact: true }).selectOption("Escuro");
    await page.getByRole("button", { name: "Enviar resposta", exact: true }).click();
    const call = await page.evaluate(() => (window as any).__calls.find((item: any) => item.command === "respond_chat_interaction"));
    expect(call.args.response).toEqual({ answers: { q1: { answers: ["Escuro"] } } });
  });
  test("chat UX automatically reconciles a lost done event outside the four minute silence warning", async ({ page }) => {
    await page.clock.install();
    await start(page);
    await page.evaluate(() => { const w = window as any; w.__chatTurnStatus = { running: false, turnId: w.__chatTurns.session, status: "completed" }; });
    await page.clock.runFor(46_000);
    await expect.poll(async () => (await state(page)).busy).toBe(false);
    await expect(page.locator(".ad-turn-activity")).toHaveCount(0);
  });
  test("chat UX recovers a lost approval event without reviving a decision answered during the status check", async ({ page }) => {
    await start(page);
    const result = await page.evaluate(async () => {
      const w = window as any;
      const { refreshChatTurnStatus, useChatStore: chat } = await import("/src/store/chatStore.ts" as string);
      const interaction = { id: "lost-approval", kind: "approval", blocking: true, command: "cargo test" };
      w.__chatTurnStatus = { running: true, turnId: w.__chatTurns.session, interactions: [interaction] };
      await refreshChatTurnStatus("session");
      const recovered = chat.getState().threads.session.interactions?.length;
      const invoke = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
        const result = await invoke(command, args);
        if (command === "get_chat_turn_status") chat.getState().patch("session", { interactions: [] });
        return result;
      };
      await refreshChatTurnStatus("session");
      return { recovered, remaining: chat.getState().threads.session.interactions?.length };
    });
    expect(result).toEqual({ recovered: 1, remaining: 0 });
  });
  test("chat UX shows project chat count and updates it after closing a chat", async ({ page }) => {
    await setup(page);
    await expect(page.locator(".ad-project-chat-count")).toHaveText("1");
    await page.evaluate(async () => (await import("/src/store/sessionStore.ts" as string)).useSessionStore.getState().removeSession("session"));
    await expect(page.locator(".ad-project-chat-count")).toHaveText("0");
  });
  test("chat UX heartbeat and status updates do not write unchanged history", async ({ page }) => {
    await page.clock.install();
    await start(page);
    await page.evaluate(async () => {
      const { persistChatHistory } = await import("/src/store/chatStore.ts" as string);
      await persistChatHistory();
      const w = window as any, original = IDBObjectStore.prototype.put;
      w.__threadWrites = 0;
      IDBObjectStore.prototype.put = function (...args: any[]) {
        if (this.name === "threads") w.__threadWrites++;
        return original.apply(this, args as [any]);
      };
      for (let index = 0; index < 200; index++) {
        w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "heartbeat", pid: 8765 });
        w.__emit("chat-event", { sessionId: "session", turnId: w.__chatTurns.session, kind: "status", status: "reasoning" });
      }
    });
    await page.clock.runFor(5000);
    expect(await page.evaluate(() => (window as any).__threadWrites)).toBe(0);
  });
  test("prompt schedules save time, date range, weekdays and zone, persist, pause, resume and remove", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-10-28T08:00:00Z") });
    await setup(page); await open(page);
    await page.locator(".ad-chat-composer textarea").fill("Resumo diário do projeto");
    await page.getByRole("button", { name: "Agendar prompt", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Agendamentos", exact: true });
    await dialog.getByLabel("Data inicial", { exact: true }).fill("2026-10-29");
    await dialog.getByLabel("Data final", { exact: true }).fill("2026-11-05");
    await dialog.getByLabel("Fuso horário", { exact: true }).fill("America/Sao_Paulo");
    await dialog.getByRole("button", { name: "Salvar agendamento" }).click();
    await expect(dialog.locator("article")).toHaveCount(1);
    await expect(dialog.locator("article")).toContainText("07:00");
    await expect(dialog.locator("article")).toContainText("America/Sao_Paulo");
    await dialog.screenshot({ path: "test-results/prompt-schedule.png" });
    await dialog.getByRole("button", { name: "Pausar", exact: true }).click();
    await expect(dialog.locator("article")).toContainText("Pausado");
    await page.reload();
    await page.getByText("Implementation", { exact: true }).first().click();
    const openButton = page.getByTitle("Abrir conversa"); if (await openButton.count()) await openButton.first().click();
    await page.getByRole("button", { name: "Agendar prompt", exact: true }).click();
    await expect(dialog.locator("article")).toContainText("Pausado");
    await dialog.getByRole("button", { name: "Retomar", exact: true }).click();
    await expect(dialog.locator("article")).toContainText("Próxima execução");
    await dialog.getByRole("button", { name: "Remover", exact: true }).click();
    await expect(dialog.locator("article")).toHaveCount(0);
  });
  test("prompt schedules calculate inclusive dates, weekday filters and DST in the saved timezone", async ({ page }) => {
    await setup(page);
    const result = await page.evaluate(async () => {
      const { nextScheduleRun } = await import("/src/services/promptScheduleTime.ts" as string);
      const base = { startDate: "2026-10-28", endDate: "2026-10-30", time: "07:00", weekdays: [5], timezone: "America/Sao_Paulo" };
      const next = nextScheduleRun(base, Date.parse("2026-10-28T08:00Z"));
      return { next, end: nextScheduleRun(base, next!), invalid: nextScheduleRun({ ...base, time: "25:00" }, 0),
        dst: nextScheduleRun({ startDate: "2026-03-08", endDate: "2026-03-09", time: "02:30", weekdays: [0, 1], timezone: "America/New_York" }, Date.parse("2026-03-08T00:00Z")) };
    });
    expect(result).toEqual({ next: Date.parse("2026-10-30T10:00Z"), end: undefined, invalid: undefined, dst: Date.parse("2026-03-09T06:30Z") });
  });
  test("prompt schedules wait for idle, send once, preserve drafts and skip missed occurrences", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-10-28T10:01:00Z") });
    await setup(page); await open(page);
    const result = await page.evaluate(async () => {
      const { usePromptScheduleStore: schedules } = await import("/src/store/promptScheduleStore.ts" as string);
      const { useSessionStore: sessions } = await import("/src/store/sessionStore.ts" as string);
      const { runDuePromptSchedules, scheduledSessionIdentity } = await import("/src/services/promptScheduler.ts" as string);
      const { useChatStore: chat } = await import("/src/store/chatStore.ts" as string);
      await (await import("/src/store/chatStore.ts" as string)).chatHistoryReady;
      const session = sessions.getState().sessions.find((item: any) => item.id === "session");
      const due = Date.parse("2026-10-28T10:00Z"), now = Date.now();
      schedules.setState({ schedules: [{ id: "daily", sessionId: "session", identity: scheduledSessionIdentity(session), prompt: "Resumo diário", startDate: "2026-10-28", endDate: "2026-11-01", weekdays: [0,1,2,3,4,5,6], time: "07:00", timezone: "America/Sao_Paulo", enabled: true, nextRunAt: due }] });
      chat.getState().patch("session", { busy: true, turnId: "existing", draft: "Rascunho preservado" });
      await runDuePromptSchedules(now);
      const waitingState = { ...schedules.getState().schedules[0] };
      const waiting = waitingState.nextRunAt === due;
      chat.getState().patch("session", { busy: false });
      await Promise.all([runDuePromptSchedules(now), runDuePromptSchedules(now)]);
      await runDuePromptSchedules(now);
      const w = window as any, calls = w.__calls.filter((call: any) => call.command === "start_chat_turn");
      const count = calls.length, draft = chat.getState().threads.session.draft;
      chat.getState().patch("session", { busy: false });
      schedules.getState().update("daily", { nextRunAt: due - 86400000 });
      await runDuePromptSchedules(now);
      return { waiting, waitingState, count, prompt: calls[0]?.args.request.prompt, draft, result: schedules.getState().schedules[0].lastResult, countAfter: w.__calls.filter((call: any) => call.command === "start_chat_turn").length };
    });
    expect(result).toMatchObject({ waiting: true, count: 1, prompt: "Resumo diário", draft: "Rascunho preservado", result: "missed", countAfter: 1 });
  });
}
