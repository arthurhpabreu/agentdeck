import { expect, test } from "@playwright/test";
import { setupImprovements } from "./improvements-fixtures";

test("@macos tracked continuity still requires review and removes legacy automatic archive references", async ({ page }) => {
  await setupImprovements(page);
  const archivePath = "C:\\fixtures\\old-source\\conversation-context.json";
  const result = await page.evaluate(async path => {
    const chat = (await import("/src/store/chatStore.ts" as string)).useChatStore;
    const sessions = (await import("/src/store/sessionStore.ts" as string)).useSessionStore;
    const evidence = (await import("/src/store/sourceDeliveryStore.ts" as string)).useSourceDeliveryStore;
    const service = await import("/src/services/chatContinuity.ts" as string);
    const messages = [{ id: "decision", turnId: "old", role: "user" as const, text: "Preserve the reviewed architecture", at: 1 }];
    chat.getState().patch("session-0", { messages, goal: "Continue the approved work", draft: "Keep this pending request" });
    evidence.getState().start("session-0", { hasHistory: false }); evidence.getState().delivered("session-0", 1);
    const session = sessions.getState().sessions.find((item: any) => item.id === "session-0")!;
    const thread = chat.getState().threads["session-0"];
    const legacyDraft = service.buildContinuityDraft(session, thread, messages, path, "en");
    chat.getState().patch("session-0", { draft: legacyDraft, continuation: { sourceSessionId: "session-1", sourceSessionName: "Old source", archivePath: path, messageCount: 1, createdAt: 1 } });
    let blocked = false, malformedBlocked = false;
    try { await service.createChatContinuation("session-0", "pt-BR"); } catch { blocked = true; }
    try { await service.createChatContinuation("session-0", "pt-BR", {}); } catch { malformedBlocked = true; }
    return { knownSources: !await service.continuationNeedsSourceReview("session-0"), blocked, malformedBlocked };
  }, archivePath);
  expect(result).toEqual({ knownSources: true, blocked: true, malformedBlocked: true });
  await page.getByRole("button", { name: "Novo chat com contexto", exact: true }).first().click();
  const review = page.getByRole("dialog", { name: "Revise o contexto a transferir" });
  const draft = await review.getByRole("textbox").inputValue();
  expect(draft).toContain("Keep this pending request");
  expect(draft).not.toContain(archivePath); expect(draft).not.toContain(JSON.stringify(archivePath));
  expect(draft).not.toContain("Before acting, inspect the local history archive");
  await page.evaluate(() => {
    const w = window as any, invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      const value = await invoke(command, args);
      return command === "get_source_policy" ? { ...value, revision: 2 } : value;
    };
  });
  await review.getByRole("button", { name: "Criar conversa com este contexto" }).click();
  await expect(review).not.toBeVisible();
  const transferred = await page.evaluate(async () => {
    const sessions = (await import("/src/store/sessionStore.ts" as string)).useSessionStore.getState();
    const chat = (await import("/src/store/chatStore.ts" as string)).useChatStore.getState();
    return { id: sessions.activeSessionId, thread: chat.threads[sessions.activeSessionId], requests: (window as any).__improvementCalls.filter((call: any) => call.command === "start_chat_turn") };
  });
  expect(transferred.id).not.toBe("session-0"); expect(transferred.thread.draft).toBe(draft);
  expect(transferred.thread.providerSessionId).toBeUndefined(); expect(transferred.thread.goal).toBeUndefined();
  expect(transferred.thread.continuation.reviewedContext).toBe(true); expect(transferred.requests).toHaveLength(0);
});

test("@macos context review strips Windows variants and nested legacy archives while preserving pending work and original history", async ({ page }) => {
  await setupImprovements(page);
  const result = await page.evaluate(async () => {
    const chat = await import("/src/store/chatStore.ts" as string);
    const sessions = (await import("/src/store/sessionStore.ts" as string)).useSessionStore;
    const service = await import("/src/services/chatContinuity.ts" as string);
    await chat.chatHistoryReady;
    const path = "C:\\fixtures\\Old Source\\conversation-context.json";
    const ancestorPath = "C:\\fixtures\\removed-ancestor\\conversation-context-index.json";
    const pending = "PENDING_REQUEST: implement the approved fix without changing src/original.ts";
    const session = sessions.getState().sessions.find((item: any) => item.id === "session-0")!;
    const initial = { ...chat.emptyThread, goal: "ORIGINAL_OBJECTIVE", draft: pending };
    const legacy = ["en", "pt-BR", "es"].map(locale => service.buildContinuityDraft(session, initial, [], ancestorPath, locale)).join("\n");
    const nested = JSON.stringify({ role: "user", text: JSON.stringify({ role: "assistant", text: legacy }) });
    const variants = [path, path.split("\\").join("/"), path.toLowerCase(), path.toUpperCase(), JSON.stringify(path), JSON.stringify(JSON.stringify(path))];
    const unrelated = `${path}.backup`;
    const originalDraft = [pending, ...variants.map(value => `Old reference ${value}`), `Preserve unrelated file ${unrelated}`, nested].join("\n");
    const messages = [{ id: "nested-legacy", turnId: "old-turn", role: "user", text: nested, at: 1 }];
    chat.useChatStore.getState().patch("session-0", { goal: "ORIGINAL_OBJECTIVE", draft: originalDraft, messages, continuation: { sourceSessionId: "removed-session", sourceSessionName: "Removed ancestor", archivePath: path, messageCount: 1, createdAt: 1 } });
    const review = await service.prepareReviewedContext("session-0", "pt-BR");
    const original = chat.useChatStore.getState().threads["session-0"];
    await service.createChatContinuation("session-0", "pt-BR", { reviewedDraft: review });
    const calls = (window as any).__improvementCalls;
    const saved = calls.find((call: any) => call.command === "save_chat_attachment");
    const bytes = Uint8Array.from(atob(saved.args.dataBase64), character => character.charCodeAt(0));
    return { review, pending, unrelated, originalDraft, original: { draft: original.draft, message: original.messages[0].text }, nested, archive: JSON.parse(new TextDecoder().decode(bytes)), calls: calls.filter((call: any) => call.command === "start_chat_turn") };
  });
  expect(result.review).toContain(result.pending); expect(result.review).toContain("ORIGINAL_OBJECTIVE");
  expect(result.review).toContain(result.unrelated);
  expect(result.review).not.toContain("Old reference C:"); expect(result.review).not.toContain("Old reference c:");
  expect(result.review).not.toContain("removed-ancestor");
  expect(result.review).not.toContain("Before acting, inspect the local history archive");
  expect(result.review).not.toContain("Antes de agir, consulte o arquivo de histórico");
  expect(result.review).not.toContain("Antes de actuar, consulta el archivo local");
  expect(result.review).not.toContain("Previous archive:");
  expect(result.original).toEqual({ draft: result.originalDraft, message: result.nested });
  expect(result.archive.draft).toBe(result.originalDraft); expect(result.archive.messages[0].text).toBe(result.nested);
  expect(result.calls).toHaveLength(0);
});
