import { expect, test, type Page } from "@playwright/test";
import { setupImprovements } from "./improvements-fixtures";

const remoteProject = "C:\\fixtures\\recipient-project";
const remoteWorktree = "C:\\fixtures\\recipient-worktree";
const teamRequest = "[Agentdeck team]\nRequest from the UI project: implement the agreed API contract in your own project.";

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    const state = await page.evaluate(() => {
      const w = window as any;
      return { calls: w.__teamCalls, acks: w.__teamAcks, session: w.__teamTest?.sessions.useSessionStore.getState().sessions.find((session: any) => session.id === "session-1"), thread: w.__teamTest?.chat.useChatStore.getState().threads["session-1"] };
    }).catch(() => null);
    await info.attach("team-delivery-state", { body: JSON.stringify(state, null, 2), contentType: "application/json" });
  }
});

async function setupTeamDelivery(page: Page) {
  await setupImprovements(page);
  await page.evaluate(async () => {
    const w = window as any;
    const [chat, sessions, workspaces, pty, coordination] = await Promise.all([
      import("/src/store/chatStore.ts" as string),
      import("/src/store/sessionStore.ts" as string),
      import("/src/store/workspaceStore.ts" as string),
      import("/src/store/ptyRuntimeStore.ts" as string),
      import("/src/services/projectCoordination.ts" as string),
    ]);
    await chat.chatHistoryReady;
    await chat.ensureChatEvents();
    sessions.useSessionStore.setState({ sessions: sessions.useSessionStore.getState().sessions.map((session: any) => ({ ...session, coordinationEnabled: false })) });
    w.__teamTest = { chat, sessions, workspaces, pty, coordination };
    w.__teamCalls = [];
    w.__teamQueue = [];
    w.__teamAcks = [];
    w.__heldTeamReceipts = [];
    const receipt = (request: any, itemId: string) => {
      const event = { sessionId: request.sessionId, turnId: request.turnId, kind: "input", itemId, status: "accepted" };
      if (w.__holdTeamReceipt) w.__heldTeamReceipts.push(event);
      else setTimeout(() => w.__emitImprovement("chat-event", event), 0);
    };
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
      w.__teamCalls.push({ command, args });
      if (command === "coordination_team_pending") {
        const pending = w.__teamQueue.splice(0);
        await w.__beforeTeamPending?.();
        return pending;
      }
      if (command === "coordination_team_finish_delivery") {
        w.__teamAcks.push(args);
        return null;
      }
      if (command === "start_chat_turn") {
        if (w.__failTeamStart) throw new Error("Provider receipt is uncertain; the transport failed.");
        receipt(args.request, args.request.turnId);
        return null;
      }
      if (command === "steer_chat_turn") { receipt(args.request, args.messageId); return "queued"; }
      if (command === "get_chat_turn_status") {
        const thread = chat.useChatStore.getState().threads[args.sessionId];
        return { turnId: thread?.turnId, running: !!thread?.busy, status: thread?.status || "running" };
      }
      return original(command, args);
    };
  });
}

async function prepareRecipient(page: Page, busy = false) {
  await page.evaluate(({ project, worktree, busy }) => {
    const w = window as any, { chat, sessions, workspaces } = w.__teamTest;
    const store = workspaces.useWorkspaceStore.getState();
    workspaces.useWorkspaceStore.setState({ workspaces: [...store.workspaces, { id: "recipient-workspace", name: "Recipient API", path: project, color: "blue", createdAt: 2, order: 1 }] });
    sessions.useSessionStore.getState().updateSession("session-1", {
      workspaceId: "recipient-workspace", workdir: project, worktreePath: worktree,
      runner: { type: "claude-code", mode: "code" }, providerSessionId: "native-recipient",
      coordinationEnabled: true, status: busy ? "running" : "idle", name: "Recipient API chat",
      currentTask: "Deliver the original recipient API task",
    });
    chat.useChatStore.getState().patch("session-1", {
      draft: "Keep this unsent user draft", busy, compacting: false, recoveryRequired: false,
      error: undefined, inputError: undefined, providerSessionId: "native-recipient",
      turnId: busy ? "existing-recipient-turn" : undefined, status: busy ? "running" : undefined,
      goal: "The recipient's approved objective", lastSentGoal: "The recipient's approved objective",
      contextPrompts: busy ? 1 : 0,
      messages: busy ? [{ id: "original-user", turnId: "existing-recipient-turn", role: "user", text: "Original recipient request", at: 1 }] : [],
    });
  }, { project: remoteProject, worktree: remoteWorktree, busy });
}

async function enqueue(page: Page, text = teamRequest, token = "delivery-token") {
  await page.evaluate(({ project, text, token }) => {
    (window as any).__teamQueue.push({ sessionId: "session-1", projectPath: project, delivery: { token, text, messageIds: [41] } });
  }, { project: remoteProject, text, token });
}

async function dispatch(page: Page, settle = true) {
  const expectedAcks = await page.evaluate(async () => {
    const w = window as any, expected = w.__teamAcks.length + w.__teamQueue.length;
    await w.__teamTest.coordination.dispatchTeamMessages();
    return expected;
  });
  if (settle) await expect.poll(() => page.evaluate(() => (window as any).__teamAcks.length)).toBe(expectedAcks);
}

const modelCalls = (page: Page) => page.evaluate(() => (window as any).__teamCalls.filter((call: any) => ["start_chat_turn", "steer_chat_turn", "send_pty_query"].includes(call.command)));
const recipientState = (page: Page) => page.evaluate(() => {
  const { chat, sessions } = (window as any).__teamTest;
  const session = sessions.useSessionStore.getState().sessions.find((item: any) => item.id === "session-1");
  const thread = chat.useChatStore.getState().threads["session-1"];
  return { name: session.name, currentTask: session.currentTask, thread };
});

test("automatic team requests wake the cross-project recipient with its own identity and preserve the user's work @macos", async ({ page }) => {
  await setupTeamDelivery(page);
  await prepareRecipient(page);
  await enqueue(page);
  // Exercise the application's periodic dispatcher without a user starting a turn.
  await expect.poll(async () => (await modelCalls(page)).length, { timeout: 10_000 }).toBe(1);
  const [call] = await modelCalls(page);
  expect(call.command).toBe("start_chat_turn");
  expect(call.args.request).toMatchObject({
    sessionId: "session-1", runnerType: "claude-code", providerSessionId: "native-recipient",
    projectPath: remoteProject, workdir: remoteWorktree, prompt: teamRequest, attachments: [],
  });
  const state = await recipientState(page);
  expect(state).toMatchObject({ name: "Recipient API chat", currentTask: "Deliver the original recipient API task" });
  expect(state.thread).toMatchObject({ draft: "Keep this unsent user draft", goal: "The recipient's approved objective", providerSessionId: "native-recipient" });
  expect(state.thread.messages).toHaveLength(1);
  expect(state.thread.messages[0]).toMatchObject({ role: "user", origin: "team", text: teamRequest });
  await expect.poll(() => page.evaluate(() => (window as any).__teamAcks)).toEqual([{ projectPath: remoteProject, sessionId: "session-1", token: "delivery-token", success: true }]);
  expect(await page.evaluate(() => (window as any).__teamTest.chat.useChatStore.getState().threads["session-0"]?.messages || [])).toEqual([]);
  expect((await recipientState(page)).thread.contextPrompts).toBe(1);
});

test("a team delivery waits for the native receipt while other members continue receiving requests @macos", async ({ page }) => {
  await setupTeamDelivery(page);
  await prepareRecipient(page);
  await page.evaluate(() => { (window as any).__holdTeamReceipt = true; });
  await enqueue(page);
  await dispatch(page, false);
  await expect.poll(async () => (await modelCalls(page)).length).toBe(1);
  expect(await page.evaluate(() => (window as any).__teamAcks)).toEqual([]);
  expect((await recipientState(page)).thread.messages.at(-1)).toMatchObject({ origin: "team", status: "sending" });
  await dispatch(page, false);
  expect(await modelCalls(page)).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).__teamAcks)).toEqual([]);

  await page.evaluate(() => {
    const w = window as any, { sessions, chat } = w.__teamTest;
    sessions.useSessionStore.getState().updateSession("session-2", { coordinationEnabled: true, providerSessionId: "native-other-member" });
    chat.useChatStore.getState().patch("session-2", { providerSessionId: "native-other-member", draft: "", busy: false, messages: [] });
    w.__holdTeamReceipt = false;
    w.__teamQueue.push({ sessionId: "session-2", projectPath: "C:\\fixtures\\one", delivery: { token: "other-member-token", text: "An independently authorized team request.", messageIds: [42] } });
  });
  await dispatch(page);
  expect(await modelCalls(page)).toHaveLength(2);
  expect(await page.evaluate(() => (window as any).__teamAcks)).toEqual([{ projectPath: "C:\\fixtures\\one", sessionId: "session-2", token: "other-member-token", success: true }]);
  expect((await recipientState(page)).thread.messages.at(-1).status).toBe("sending");

  await page.evaluate(() => {
    const w = window as any;
    w.__emitImprovement("chat-event", w.__heldTeamReceipts.shift());
  });
  await expect.poll(() => page.evaluate(() => (window as any).__teamAcks.find((ack: any) => ack.sessionId === "session-1"))).toEqual({ projectPath: remoteProject, sessionId: "session-1", token: "delivery-token", success: true });
  expect((await recipientState(page)).thread.messages.at(-1).status).toBe("accepted");
  expect((await recipientState(page)).thread.draft).toBe("Keep this unsent user draft");
});

test("team requests supplement an existing native turn and retain the recipient's draft, name and task @macos", async ({ page }) => {
  await setupTeamDelivery(page);
  await prepareRecipient(page, true);
  await enqueue(page);
  await dispatch(page);
  const calls = await modelCalls(page);
  expect(calls).toHaveLength(1);
  expect(calls[0].command).toBe("steer_chat_turn");
  expect(calls[0].args.request).toMatchObject({ sessionId: "session-1", turnId: "existing-recipient-turn", runnerType: "claude-code", projectPath: remoteProject, workdir: remoteWorktree, prompt: teamRequest });
  const state = await recipientState(page);
  expect(state).toMatchObject({ name: "Recipient API chat", currentTask: "Deliver the original recipient API task" });
  expect(state.thread.draft).toBe("Keep this unsent user draft");
  expect(state.thread.messages.at(-1)).toMatchObject({ origin: "team", text: teamRequest, status: "accepted" });
  expect(state.thread.contextPrompts).toBe(2);
  const targets = await page.evaluate(() => (window as any).__teamCalls.find((call: any) => call.command === "coordination_team_pending").args.targets);
  expect(targets).toEqual([{ sessionId: "session-1", projectPath: remoteProject, allowUpdates: true }]);
});

for (const ending of ["input-failed", "turn-interrupted"]) {
  test(`an unconfirmed team supplement stays out of the user composer after ${ending} @macos`, async ({ page }) => {
    await setupTeamDelivery(page);
    await prepareRecipient(page, true);
    await page.evaluate(() => { (window as any).__holdTeamReceipt = true; });
    await enqueue(page);
    await dispatch(page, false);
    await expect.poll(async () => (await modelCalls(page)).length).toBe(1);
    await page.evaluate(ending => {
      const w = window as any, chat = w.__teamTest.chat.useChatStore.getState();
      chat.patch("session-1", { draft: "" });
      const steer = w.__teamCalls.find((call: any) => call.command === "steer_chat_turn");
      chat.event(ending === "input-failed"
        ? { sessionId: "session-1", turnId: "existing-recipient-turn", kind: "input", itemId: steer.args.messageId, status: "failed", text: "The provider did not confirm the team note." }
        : { sessionId: "session-1", turnId: "existing-recipient-turn", kind: "done", status: "interrupted" });
    }, ending);
    const { thread } = await recipientState(page);
    expect(thread.draft).toBe("");
    expect(thread.inputError).toBeUndefined();
    expect(thread.messages.at(-1)).toMatchObject({ origin: "team", status: "failed" });
    await expect.poll(() => page.evaluate(() => (window as any).__teamAcks)).toEqual([{ projectPath: remoteProject, sessionId: "session-1", token: "delivery-token", success: false }]);
    await dispatch(page);
    expect(await modelCalls(page)).toHaveLength(1);
  });
}

test("automatic delivery excludes unsupported, stopped, unbound and recovering chats even if a stale queue returns them @macos", async ({ page }) => {
  await setupTeamDelivery(page);
  await prepareRecipient(page);
  await page.evaluate(({ project, text }) => {
    const w = window as any, { sessions, chat, pty } = w.__teamTest;
    const template = sessions.useSessionStore.getState().sessions.find((session: any) => session.id === "session-1");
    const blocked = [
      { id: "blocked-gemini", runner: { type: "gemini" } },
      { id: "blocked-pty" },
      { id: "blocked-suspended", status: "suspended" },
      { id: "blocked-error", status: "error" },
      { id: "blocked-unbound", providerSessionId: undefined },
      { id: "blocked-compacting" },
      { id: "blocked-recovery" },
      { id: "blocked-thread-error" },
      { id: "blocked-disabled", coordinationEnabled: false },
    ].map(patch => ({ ...template, ...patch, name: patch.id }));
    sessions.useSessionStore.setState({ sessions: [...sessions.useSessionStore.getState().sessions, ...blocked] });
    pty.usePtyRuntimeStore.getState().set("blocked-pty", "running");
    chat.useChatStore.getState().patch("blocked-compacting", { busy: true, compacting: true });
    chat.useChatStore.getState().patch("blocked-recovery", { recoveryRequired: true });
    chat.useChatStore.getState().patch("blocked-thread-error", { error: "Existing provider failure" });
    w.__teamQueue = [...blocked.map((session: any, index: number) => ({ sessionId: session.id, projectPath: project, delivery: { token: `blocked-${index}`, text, messageIds: [index + 50] } })), { sessionId: "session-1", projectPath: project, delivery: { token: "allowed", text, messageIds: [80] } }];
  }, { project: remoteProject, text: teamRequest });
  await dispatch(page);
  const calls = await modelCalls(page);
  expect(calls).toHaveLength(1);
  expect(calls[0].args.request.sessionId).toBe("session-1");
  const inspected = await page.evaluate(() => (window as any).__teamCalls.find((call: any) => call.command === "coordination_team_pending").args.targets);
  expect(inspected).toEqual([{ sessionId: "session-1", projectPath: remoteProject, allowUpdates: false }]);
  expect(await page.evaluate(() => (window as any).__teamAcks.filter((ack: any) => ack.sessionId.startsWith("blocked-")).every((ack: any) => ack.success === false))).toBe(true);
});

for (const changed of ["provider", "project", "workdir", "runner"]) {
  test(`pending team delivery is cancelled when the recipient's ${changed} changes during queue inspection @macos`, async ({ page }) => {
    await setupTeamDelivery(page);
    await prepareRecipient(page);
    await enqueue(page);
    await page.evaluate(changed => {
      const w = window as any, { sessions, chat } = w.__teamTest;
      w.__beforeTeamPending = () => {
        if (changed === "provider") {
          sessions.useSessionStore.getState().updateSession("session-1", { providerSessionId: "different-native-conversation" });
          chat.useChatStore.getState().patch("session-1", { providerSessionId: "different-native-conversation" });
        } else if (changed === "project") {
          sessions.useSessionStore.getState().updateSession("session-1", { workspaceId: "one", workdir: "C:\\fixtures\\one", worktreePath: undefined });
        } else if (changed === "workdir") {
          sessions.useSessionStore.getState().updateSession("session-1", { worktreePath: "C:\\fixtures\\another-checkout" });
        } else {
          sessions.useSessionStore.getState().updateSession("session-1", { runner: { type: "codex" } });
        }
      };
    }, changed);
    await dispatch(page);
    expect(await modelCalls(page)).toEqual([]);
    expect(await page.evaluate(() => (window as any).__teamAcks)).toEqual([{ projectPath: remoteProject, sessionId: "session-1", token: "delivery-token", success: false }]);
    const state = await recipientState(page);
    expect(state.thread.draft).toBe("Keep this unsent user draft");
    expect(state.thread.messages).toEqual([]);
  });
}

test("an uncertain launch is marked failed and is not retried after an unrelated chat recovery @macos", async ({ page }) => {
  await setupTeamDelivery(page);
  await prepareRecipient(page);
  await page.evaluate(() => { (window as any).__failTeamStart = true; });
  await enqueue(page);
  await dispatch(page);
  expect(await modelCalls(page)).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).__teamAcks)).toEqual([{ projectPath: remoteProject, sessionId: "session-1", token: "delivery-token", success: false }]);
  let state = await recipientState(page);
  expect(state.thread).toMatchObject({ draft: "Keep this unsent user draft", busy: false });
  expect(state.thread.error).toContain("receipt is uncertain");
  await page.evaluate(() => {
    const w = window as any, { sessions, chat } = w.__teamTest;
    // Recovery does not produce a new authorized request or reset the failed delivery.
    w.__failTeamStart = false;
    sessions.useSessionStore.getState().updateSession("session-1", { status: "idle" });
    chat.useChatStore.getState().patch("session-1", { error: undefined, busy: false });
  });
  await dispatch(page);
  await dispatch(page);
  expect(await modelCalls(page)).toHaveLength(1);
  state = await recipientState(page);
  expect(state.thread.messages.filter((message: any) => message.origin === "team")).toHaveLength(1);
  expect(state.thread.draft).toBe("Keep this unsent user draft");
});

test("successive queue inspections include members beyond the backend's eight-target batch @macos", async ({ page }) => {
  await setupTeamDelivery(page);
  const batches = await page.evaluate(async () => {
    const w = window as any, { sessions, chat, coordination } = w.__teamTest;
    const template = sessions.useSessionStore.getState().sessions[0];
    const members = Array.from({ length: 9 }, (_, index) => ({
      ...template, id: `fair-member-${index}`, name: `Team member ${index}`,
      coordinationEnabled: true, providerSessionId: `native-fair-member-${index}`,
    }));
    sessions.useSessionStore.setState({ sessions: [...sessions.useSessionStore.getState().sessions, ...members] });
    for (const member of members) chat.useChatStore.getState().patch(member.id, { busy: false, messages: [], draft: "", providerSessionId: member.providerSessionId });
    // No pending messages are needed: the backend examines only the first eight
    // submitted targets, so fairness must also advance through empty queues.
    await coordination.dispatchTeamMessages();
    await coordination.dispatchTeamMessages();
    return w.__teamCalls.filter((call: any) => call.command === "coordination_team_pending")
      .slice(-2).map((call: any) => call.args.targets.slice(0, 8).map((target: any) => target.sessionId));
  });
  expect(batches).toHaveLength(2);
  expect(batches.every((batch: string[]) => batch.length === 8)).toBe(true);
  expect([...new Set(batches.flat())].sort()).toEqual(Array.from({ length: 9 }, (_, index) => `fair-member-${index}`));
  expect(await modelCalls(page)).toEqual([]);
});
