import { expect, test } from "@playwright/test";
import { setupImprovements } from "./improvements-fixtures";

test("@macos inbox admits confirmed actions and completions, excludes OAuth and silence, and navigates to owner", async ({ page }) => {
  await setupImprovements(page);
  await page.evaluate(async () => {
    const store = await import("/src/store/attentionStore.ts" as string);
    const base = { sessionId: "session-3", turnId: "turn-1" };
    store.recordChatAttention({ ...base, kind: "heartbeat" });
    store.recordChatAttention({ ...base, kind: "status", status: "mcp-auth-warning", text: "Miro failed" });
    store.recordChatAttention({ ...base, kind: "status", status: "diagnostic", text: "No activity" });
    store.recordChatAttention({ ...base, kind: "interaction", interaction: { id: "approval", kind: "approval", blocking: true, command: "Aprovar execução" } });
    store.recordChatAttention({ sessionId: "session-2", turnId: "turn-2", kind: "done", status: "completed" });
    (window as any).__emitImprovement("pty-waiting", { session_id: "session-4", source: "screen-heuristic" });
    (window as any).__emitImprovement("pty-waiting", { session_id: "session-4" });
  });
  await page.getByRole("button", { name: /Precisa de você/ }).click();
  const inbox = page.getByRole("dialog", { name: "Precisa de você" });
  await expect(inbox.locator("article")).toHaveCount(2);
  await expect(inbox).not.toContainText("Miro");
  await inbox.getByRole("button").filter({ hasText: "Conversa 2" }).last().click();
  await expect(page.locator(".ad-session-tabs:visible > span")).toContainText("Conversa 2");
  await page.getByRole("button", { name: /Precisa de você/ }).click();
  await expect(inbox.locator("article")).toHaveCount(1); // Approval remains actionable until handled.
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: /Precisa de você/ }).click();
  await expect(page.getByRole("dialog", { name: "Precisa de você" }).locator("article")).toHaveCount(1);
});

test("@macos a native terminal permission dialog needs you until it is answered in the terminal", async ({ page }) => {
  await setupImprovements(page);
  const unread = () => page.evaluate(async () => (await import("/src/store/attentionStore.ts" as string)).useAttentionStore.getState().items.filter((item: any) => item.sessionId === "session-4" && !item.read).map((item: any) => item.kind));
  // The app subscribes to native events asynchronously after mount (twice for a moment under
  // development StrictMode); repeat the dialog until it is heard.
  await expect.poll(async () => {
    if (!(await unread()).length) await page.evaluate(() => (window as any).__emitImprovement("pty-notification", { session_id: "session-4", title: "", message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" }));
    return (await unread()).length;
  }).toBeGreaterThan(0);
  expect(new Set(await unread())).toEqual(new Set(["approval"]));
  await page.getByRole("button", { name: /Precisa de você/ }).click();
  await expect(page.getByRole("dialog", { name: "Precisa de você" })).toContainText("Claude needs your permission to use Bash");
  await page.keyboard.press("Escape");
  await page.evaluate(async () => { await (await import("/src/services/ptyInput.ts" as string)).writePtyInput("session-4", "1").catch(() => {}); });
  await expect.poll(unread).toEqual([]);
});

test("@macos file navigation reuses editor tab, resolves line, and supports persisted favorites", async ({ page }) => {
  await setupImprovements(page);
  await page.keyboard.press("Control+k"); const dialog = page.getByRole("dialog", { name: "Navegação rápida" });
  await dialog.getByRole("combobox").fill("example.ts:2");
  const file = dialog.getByRole("option").filter({ hasText: "src/example.ts" }); await expect(file).toBeVisible();
  await file.getByRole("button", { name: "Favoritar", exact: true }).click();
  await file.click(); await expect(page.locator(".cm-editor")).toBeVisible();
  await page.keyboard.press("Control+k"); await dialog.getByRole("combobox").fill("example.ts"); await dialog.getByRole("option").filter({ hasText: "src/example.ts" }).click();
  const tabCount = await page.evaluate(async () => Object.values((await import("/src/store/editorStore.ts" as string)).useEditorStore.getState().tabsById).filter((tab: any) => tab.path === "src/example.ts").length);
  expect(tabCount).toBe(1);
  await page.reload(); await expect(page.locator(".ad-quick-switch-trigger")).toBeVisible(); await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Navegação rápida" }).getByRole("group", { name: "Favoritos" })).toContainText("src/example.ts");
});

test("@macos diff range comments detect stale file references and send one batch to the selected agent", async ({ page }) => {
  await setupImprovements(page);
  await page.evaluate(async () => {
    const sessions = (await import("/src/store/sessionStore.ts" as string)).useSessionStore;
    const scm = (await import("/src/store/scmStore.ts" as string)).useScmStore;
    const file = { path: "src/example.ts", type: "modified", additions: 2, deletions: 0, hunks: [{ header: "@@ -1,2 +1,2 @@", lines: [{ type: "added", content: "const first = 1;", newLineNo: 1 }, { type: "added", content: "const second = 2;", newLineNo: 2 }] }] };
    sessions.getState().setDiffFiles("session-0", [file]); scm.getState().setSnapshot("session-0", [file]);
    (await import("/src/services/editorCommands.ts" as string)).openDiff("session-0", file.path, true, "command");
  });
  await page.getByRole("button", { name: "Comentar linhas :1", exact: true }).click();
  await page.getByRole("button", { name: "Comentar linhas :2", exact: true }).click({ modifiers: ["Shift"] });
  await page.getByRole("textbox", { name: "Comentar linhas", exact: true }).fill("Use um nome mais claro.");
  await page.getByRole("button", { name: "Adicionar comentário" }).click();
  await expect(page.getByRole("complementary", { name: "Revisão para o agente" })).toContainText("1-2");
  await page.evaluate(async () => {
    const sessions = (await import("/src/store/sessionStore.ts" as string)).useSessionStore;
    const file = structuredClone(sessions.getState().sessions.find((session: any) => session.id === "session-0").diffFiles[0]); file.hunks[0].lines[0].content = "const renamed = 1;";
    sessions.getState().setDiffFiles("session-0", [file]); (await import("/src/store/scmStore.ts" as string)).useScmStore.getState().setSnapshot("session-0", [file]);
  });
  await expect(page.getByRole("button", { name: "Enviar revisão inteira" })).toBeDisabled();
  await page.getByRole("button", { name: "Confirmar referência atual" }).click();
  await page.getByRole("combobox", { name: "Agente destinatário" }).selectOption("session-2");
  await page.getByRole("button", { name: "Enviar revisão inteira" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__improvementCalls.filter((call: any) => call.command === "start_chat_turn").length)).toBe(1);
  const request = await page.evaluate(() => (window as any).__improvementCalls.find((call: any) => call.command === "start_chat_turn").args.request);
  expect(request.sessionId).toBe("session-2"); expect(request.prompt).toContain("lines 1-2"); expect(request.prompt).toContain("const renamed"); expect(request.prompt).toContain("Use um nome mais claro");
});

test("@macos checkpoint recovery creates a new provider identity using reviewed context without attaching old sources", async ({ page }) => {
  await setupImprovements(page);
  await page.evaluate(async () => { const chat = (await import("/src/store/chatStore.ts" as string)).useChatStore; chat.getState().patch("session-0", { goal: "Objetivo seguro", providerSessionId: "old-provider", messages: [{ id: "user", turnId: "old-turn", role: "user", text: "Pedido histórico sem proveniência", at: 1 }, { id: "assistant", turnId: "old-turn", role: "assistant", text: "Conteúdo de outro vault", at: 2 }] }); });
  await page.getByRole("button", { name: "Checkpoints", exact: true }).click();
  await page.getByRole("button", { name: "Salvar checkpoint", exact: true }).click();
  await expect(page.getByRole("button", { name: "Recuperar como nova conversa" })).toBeVisible();
  await page.getByRole("button", { name: "Recuperar como nova conversa" }).click();
  const review = page.getByRole("dialog", { name: "Revise o contexto a transferir" });
  await review.getByRole("textbox").fill("Retome apenas o objetivo seguro, com as fontes atuais.");
  await review.getByRole("button", { name: "Criar conversa com este contexto" }).click();
  await expect(review).not.toBeVisible();
  const result = await page.evaluate(async () => { const sessions = (await import("/src/store/sessionStore.ts" as string)).useSessionStore.getState(); const chat = (await import("/src/store/chatStore.ts" as string)).useChatStore.getState(); return { session: sessions.sessions.find((session: any) => session.id === sessions.activeSessionId), thread: chat.threads[sessions.activeSessionId], calls: (window as any).__improvementCalls }; });
  expect(result.session.providerSessionId).toBeUndefined(); expect(result.thread.providerSessionId).toBeUndefined(); expect(result.thread.draft).toBe("Retome apenas o objetivo seguro, com as fontes atuais."); expect(result.thread.draft).not.toContain("fixtures"); expect(result.thread.goal).toBeUndefined(); expect(result.thread.messages).toHaveLength(2); expect(result.calls.filter((call: any) => call.command === "start_chat_turn")).toHaveLength(0);
});

test("@macos source provenance keeps legacy history unknown, rejects stale deliveries and survives reload for tracked chats", async ({ page }) => {
  await setupImprovements(page);
  const initial = await page.evaluate(async () => {
    const chat = await import("/src/store/chatStore.ts" as string);
    const delivery = (await import("/src/store/sourceDeliveryStore.ts" as string)).useSourceDeliveryStore;
    const runtime = (await import("/src/store/memoryRuntimeStore.ts" as string)).useMemoryRuntimeStore;
    const continuity = await import("/src/services/chatContinuity.ts" as string);
    await chat.chatHistoryReady;
    chat.useChatStore.getState().patch("session-0", { providerSessionId: "legacy-provider", archivedCount: 5, messages: [{ id: "legacy-user", turnId: "legacy-turn", role: "user", text: "Histórico anterior à evidência de fontes", at: 1 }] });
    await chat.sendChatTurn("session-0", "Pedido novo com a política atual", []);
    const base = { recordCount: 0, estimatedTokens: 0, duplicateCount: 0, policyRevision: 1 };
    runtime.getState().context({ ...base, sessionId: "session-0", contextId: "legacy-new-turn", phase: "prepared" });
    runtime.getState().context({ ...base, sessionId: "session-0", contextId: "legacy-new-turn", phase: "delivered" });
    const legacyReview = await continuity.continuationNeedsSourceReview("session-0");
    const legacyTurn = chat.useChatStore.getState().threads["session-0"].turnId;
    (window as any).__emitImprovement("chat-event", { sessionId: "session-0", turnId: legacyTurn, kind: "done", status: "completed" });

    await chat.sendChatTurn("session-1", "Primeiro pedido rastreado", []);
    runtime.getState().context({ ...base, sessionId: "session-1", contextId: "prepared-old", phase: "prepared", policyRevision: 99 });
    runtime.getState().context({ ...base, sessionId: "session-1", contextId: "prepared-current", phase: "prepared" });
    const preparedReview = delivery.getState().requiresReview("session-1", 1);
    runtime.getState().context({ ...base, sessionId: "session-1", contextId: "prepared-old", phase: "delivered", policyRevision: 99 });
    const staleRevisions = delivery.getState().revisionsBySession["session-1"] ?? [];
    runtime.getState().context({ ...base, sessionId: "session-1", contextId: "prepared-current", phase: "delivered" });
    runtime.getState().context({ ...base, sessionId: "session-1", contextId: "prepared-old", phase: "prepared", policyRevision: 99 });
    runtime.getState().context({ ...base, sessionId: "session-1", contextId: "prepared-old", phase: "delivered", policyRevision: 99 });
    const retiredRevisions = delivery.getState().revisionsBySession["session-1"];
    // Evict source previews while preserving their lightweight preparation guards.
    for (let index = 0; index < 101; index += 1) runtime.getState().context({ ...base, sessionId: `preview-${index}`, contextId: `preview-${index}`, phase: "prepared" });
    runtime.getState().context({ ...base, sessionId: "session-1", contextId: "prepared-old", phase: "delivered", policyRevision: 99 });
    runtime.getState().context({ ...base, sessionId: "orphan-delivery", contextId: "never-prepared", phase: "delivered" });
    const orphanRevisions = delivery.getState().revisionsBySession["orphan-delivery"] ?? [];
    const freshTurn = chat.useChatStore.getState().threads["session-1"].turnId;
    (window as any).__emitImprovement("chat-event", { sessionId: "session-1", turnId: freshTurn, kind: "session", providerSessionId: "tracked-provider" });
    (window as any).__emitImprovement("chat-event", { sessionId: "session-1", turnId: freshTurn, kind: "done", status: "completed" });
    await chat.persistChatHistory();
    return { legacyReview, preparedReview, staleRevisions, retiredRevisions, orphanRevisions, freshReview: await continuity.continuationNeedsSourceReview("session-1"), legacyOrigin: delivery.getState().historyBySession["session-0"].origin, freshOrigin: delivery.getState().historyBySession["session-1"].origin };
  });
  expect(initial).toEqual({ legacyReview: true, preparedReview: true, staleRevisions: [], retiredRevisions: [1], orphanRevisions: [], freshReview: false, legacyOrigin: "unknown", freshOrigin: "tracked" });
  await page.reload();
  const restored = await page.evaluate(async () => {
    const chat = await import("/src/store/chatStore.ts" as string);
    const delivery = (await import("/src/store/sourceDeliveryStore.ts" as string)).useSourceDeliveryStore;
    const runtime = (await import("/src/store/memoryRuntimeStore.ts" as string)).useMemoryRuntimeStore;
    const continuity = await import("/src/services/chatContinuity.ts" as string);
    await chat.chatHistoryReady;
    const legacyReview = await continuity.continuationNeedsSourceReview("session-0");
    const trackedReview = await continuity.continuationNeedsSourceReview("session-1");
    const hasRuntime = !!runtime.getState().sessions["session-1"]?.context;
    delivery.getState().bindProvider("session-1", "unexpected-provider");
    delivery.getState().delivered("session-1", 1);
    const changedProviderReview = delivery.getState().requiresReview("session-1", 1);
    const base = { recordCount: 0, estimatedTokens: 0, duplicateCount: 0, policyRevision: 1 };
    delivery.getState().start("expired-proof", { hasHistory: false });
    const clock = Date.now;
    Date.now = () => clock() - 31 * 60_000;
    try { runtime.getState().context({ ...base, sessionId: "expired-proof", contextId: "expired-proof", phase: "prepared" }); }
    finally { Date.now = clock; }
    runtime.getState().context({ ...base, sessionId: "expired-proof", contextId: "expired-proof", phase: "delivered" });
    const expiredOrigin = delivery.getState().historyBySession["expired-proof"].origin;
    const expiredRevisions = delivery.getState().revisionsBySession["expired-proof"] ?? [];
    delivery.getState().start("bounded-proof", { hasHistory: false });
    for (let index = 0; index < 514; index += 1) runtime.getState().context({ ...base, sessionId: "bounded-proof", contextId: `bounded-proof-${index}`, phase: "prepared" });
    runtime.getState().context({ ...base, sessionId: "bounded-proof", contextId: "bounded-proof-513", phase: "delivered" });
    const boundedOrigin = delivery.getState().historyBySession["bounded-proof"].origin;
    const boundedRevisions = delivery.getState().revisionsBySession["bounded-proof"] ?? [];
    localStorage.setItem("agentdeck-source-delivery-v1", JSON.stringify({ version: 0, state: { revisionsBySession: { "session-2": [1] } } }));
    await delivery.persist.rehydrate();
    return { legacyReview, trackedReview, hasRuntime, changedProviderReview, expiredOrigin, expiredRevisions, boundedOrigin, boundedRevisions, migratedReview: delivery.getState().requiresReview("session-2", 1), migratedOrigin: delivery.getState().historyBySession["session-2"].origin };
  });
  expect(restored).toEqual({ legacyReview: true, trackedReview: false, hasRuntime: false, changedProviderReview: true, expiredOrigin: "unknown", expiredRevisions: [], boundedOrigin: "unknown", boundedRevisions: [], migratedReview: true, migratedOrigin: "unknown" });
});

test("@macos a notification click opens its session in the owning project and resize warnings stay silent", async ({ page }) => {
  await setupImprovements(page);
  await page.evaluate(async () => {
    const { useWorkspaceStore } = await import("/src/store/workspaceStore.ts" as string);
    const { useSessionStore } = await import("/src/store/sessionStore.ts" as string);
    useWorkspaceStore.setState((state: any) => ({ workspaces: [...state.workspaces, { id: "two", name: "Outro projeto", path: "C:/fixtures/two", color: "blue", createdAt: 2, order: 1 }] }));
    useSessionStore.setState((state: any) => ({ sessions: [...state.sessions, { ...state.sessions[0], id: "session-other", name: "Conversa remota", workspaceId: "two", workdir: "C:/fixtures/two" }] }));
    window.dispatchEvent(new ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
    (window as any).__emitImprovement("popup-focused", { session_id: "session-other" });
  });
  await expect.poll(() => page.evaluate(async () => (await import("/src/store/workspaceStore.ts" as string)).useWorkspaceStore.getState().activeWorkspaceId)).toBe("two");
  await expect(page.locator(".ad-session-tabs:visible > span")).toContainText("Conversa remota");
  await expect(page.getByText("ResizeObserver loop", { exact: false })).toHaveCount(0);
});
