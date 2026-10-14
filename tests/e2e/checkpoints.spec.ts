import { expect, test } from "@playwright/test";
import { setupImprovements } from "./improvements-fixtures";

test("@macos checkpoint migration lists metadata, reads one owned snapshot and restores its exact messages", async ({ page }) => {
  await setupImprovements(page);
  const migration = await page.evaluate(async () => {
    const chat = await import("/src/store/chatStore.ts" as string);
    await chat.chatHistoryReady;
    const messages = [{ id: "snapshot-user", turnId: "old", role: "user", text: "Pedido íntegro ç 中文", at: 1 }, { id: "snapshot-assistant", turnId: "old", role: "assistant", text: "Resposta original\nsegunda linha", at: 2 }];
    chat.useChatStore.getState().patch("session-0", { messages, goal: "Objetivo revisável", providerSessionId: "old-provider" });
    const thread = { ...chat.emptyThread, messages, providerSessionId: "old-provider" };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("agentdeck-chat-checkpoints", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("checkpoints", { keyPath: "id" }).createIndex("session", "sessionId");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const transaction = request.result.transaction("checkpoints", "readwrite");
        const store = transaction.objectStore("checkpoints");
        for (let index = 1; index <= 12; index++) store.put({ id: `legacy-${index}`, version: 1, sessionId: "session-0", name: "Legacy checkpoint", at: index, archivePath: `legacy-${index}.json`, thread: index === 12 ? thread : { ...thread, messages: [{ ...messages[0], text: "x".repeat(1024 * 1024) }] } });
        store.put({ id: "foreign", version: 1, sessionId: "session-1", name: "Other owner", at: 20, archivePath: "foreign.json", thread });
        transaction.oncomplete = () => { request.result.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
    const fullReads: string[] = [], listReads: string[] = [];
    const originalGet = IDBObjectStore.prototype.get, originalGetAll = IDBIndex.prototype.getAll;
    IDBObjectStore.prototype.get = function (...args: any[]) { if (this.name === "checkpoints") fullReads.push(String(args[0])); return originalGet.apply(this, args as [IDBValidKey]); };
    IDBIndex.prototype.getAll = function (...args: any[]) { listReads.push(this.objectStore.name); return originalGetAll.apply(this, args as []); };
    const checkpoints = await import("/src/services/chatCheckpoints.ts" as string);
    const summaries = await checkpoints.listChatCheckpoints("session-0");
    const listFullReads = fullReads.length;
    let foreignRejected = false;
    try { await checkpoints.readCheckpoint("session-0", "foreign"); } catch { foreignRejected = true; }
    const foreignFullReads = fullReads.length;
    const selected = await checkpoints.readCheckpoint("session-0", "legacy-12");
    const pty = (await import("/src/store/ptyRuntimeStore.ts" as string)).usePtyRuntimeStore;
    pty.getState().set("session-0", "running");
    let runningRejected = false;
    try { await checkpoints.saveChatCheckpoint("session-0"); } catch { runningRejected = true; }
    pty.getState().set("session-0");
    const saved = await checkpoints.saveChatCheckpoint("session-0");
    const retained = await checkpoints.listChatCheckpoints("session-0");
    const foreign = await checkpoints.readCheckpoint("session-1", "foreign");
    return { summaries, listReads, listFullReads, foreignRejected, foreignFullReads, selectedMessages: selected.thread.messages, selectedArchive: selected.archivePath, retainedIds: retained.map((entry: any) => entry.id), foreignArchive: foreign.archivePath, runningRejected, expectedMessages: messages, savedMessages: saved.thread.messages };
  });
  expect(migration.summaries).toHaveLength(12);
  expect(migration.summaries.every((entry: any) => !Object.hasOwn(entry, "thread"))).toBe(true);
  expect(migration.listReads.every((store: string) => store === "summaries")).toBe(true);
  expect(migration.listFullReads).toBe(0);
  expect(migration.foreignRejected).toBe(true); expect(migration.foreignFullReads).toBe(0);
  expect(migration.selectedMessages).toEqual(migration.expectedMessages);
  expect(migration.selectedArchive).toBe("legacy-12.json");
  expect(migration.retainedIds).toHaveLength(10); expect(migration.retainedIds).not.toContain("legacy-1");
  expect(migration.foreignArchive).toBe("foreign.json"); expect(migration.runningRejected).toBe(true);
  await page.getByRole("button", { name: "Checkpoints", exact: true }).click();
  await page.getByRole("button", { name: "Recuperar como nova conversa" }).first().click();
  const review = page.getByRole("dialog", { name: "Revise o contexto a transferir" });
  await review.getByRole("textbox").fill("Continuar com apenas este contexto revisado.");
  await review.getByRole("button", { name: "Criar conversa com este contexto" }).click();
  await expect(review).not.toBeVisible();
  const restored = await page.evaluate(async () => {
    const sessions = (await import("/src/store/sessionStore.ts" as string)).useSessionStore.getState();
    return (await import("/src/store/chatStore.ts" as string)).useChatStore.getState().threads[sessions.activeSessionId];
  });
  expect(restored.messages).toEqual(migration.savedMessages);
  expect(restored.providerSessionId).toBeUndefined();
  expect(restored.draft).toBe("Continuar com apenas este contexto revisado.");
});

test("@macos cancelling checkpoint review clears the selected history before a normal reviewed continuation", async ({ page }) => {
  await setupImprovements(page);
  await page.evaluate(async () => {
    const chat = await import("/src/store/chatStore.ts" as string); await chat.chatHistoryReady;
    chat.useChatStore.getState().patch("session-0", { goal: "Current objective", messages: [{ id: "old", turnId: "old", role: "user", text: "Checkpoint-only history", at: 1 }] });
    await (await import("/src/services/chatCheckpoints.ts" as string)).saveChatCheckpoint("session-0");
    chat.useChatStore.getState().patch("session-0", { messages: [{ id: "current", turnId: "current", role: "user", text: "Current conversation history", at: 2 }] });
  });
  await page.getByRole("button", { name: "Checkpoints", exact: true }).click();
  await page.getByRole("button", { name: "Recuperar como nova conversa" }).click();
  const review = page.getByRole("dialog", { name: "Revise o contexto a transferir" });
  await expect(review).toBeVisible(); await review.getByRole("button", { name: "Cancelar", exact: true }).click();
  await page.getByRole("button", { name: "Novo chat com fontes corretas", exact: true }).click();
  await review.getByRole("textbox").fill("Current reviewed objective only.");
  await review.getByRole("button", { name: "Criar conversa com este contexto" }).click();
  await expect(review).not.toBeVisible();
  const messages = await page.evaluate(async () => {
    const sessions = (await import("/src/store/sessionStore.ts" as string)).useSessionStore.getState();
    return (await import("/src/store/chatStore.ts" as string)).useChatStore.getState().threads[sessions.activeSessionId].messages;
  });
  expect(messages).toEqual([]);
});

test("@macos a delayed checkpoint read cannot open a review after switching conversations", async ({ page }) => {
  await setupImprovements(page);
  await page.evaluate(async () => {
    const chat = await import("/src/store/chatStore.ts" as string); await chat.chatHistoryReady;
    chat.useChatStore.getState().patch("session-0", { recoveryKind: "provider-resumed", continuation: { sourceSessionId: "original", sourceSessionName: "Original", archivePath: "old.json", messageCount: 1, createdAt: 1 }, messages: [{ id: "old", turnId: "old", role: "user", text: "Previous checkpoint context", at: 1 }] });
    await (await import("/src/services/chatCheckpoints.ts" as string)).saveChatCheckpoint("session-0");
    const original = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (...args: any[]) {
      const request = original.apply(this, args as [IDBValidKey]);
      if (this.name === "checkpoints") Object.defineProperty(request, "onsuccess", { set(handler) { request.addEventListener("success", event => { (window as any).__resumeCheckpointRead = () => handler.call(request, event); }); } });
      return request;
    };
  });
  await expect(page.locator(".ad-chat-recovery .ad-hint:visible")).toHaveText("Sessão do provedor retomada");
  await page.getByRole("button", { name: "Checkpoints", exact: true }).click();
  const restore = page.getByRole("button", { name: "Recuperar como nova conversa", includeHidden: true });
  await restore.click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__resumeCheckpointRead === "function")).toBe(true);
  await page.getByText("Conversa 1", { exact: true }).first().click();
  await page.evaluate(async () => { (window as any).__resumeCheckpointRead(); await Promise.resolve(); await Promise.resolve(); });
  await expect(restore).toBeEnabled();
  await expect(page.locator("dialog.ad-context-review[open]")).toHaveCount(0);
});
