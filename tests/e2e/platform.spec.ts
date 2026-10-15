import { expect, test, type Page } from "@playwright/test";

/** Exercise native macOS facts independently of the browser used by CI. */
async function setup(page: Page, { locale = "en-US", native = true, update = false, legacyCrypto = false } = {}) {
  await page.addInitScript(({ locale, native, update, legacyCrypto }) => {
    const w = window as any;
    if (legacyCrypto) Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      readText: async () => "Olá macOS 👩‍💻", writeText: async (text: string) => { w.__copiedText = text; },
    } });
    let id = 0;
    const callbacks = new Map<number, Function>();
    const listeners = new Map<string, Map<number, number>>();
    w.__calls = [];
    w.__emit = (event: string, payload: unknown) => {
      for (const [eventId, callback] of listeners.get(event) ?? []) callbacks.get(callback)?.({ event, id: eventId, payload });
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "popup" }, currentWebview: { label: "popup" } },
      transformCallback: (callback: Function) => { callbacks.set(++id, callback); return id; },
      unregisterCallback: (callbackId: number) => callbacks.delete(callbackId),
      invoke: async (command: string, args: any = {}) => {
        w.__calls.push({ command, args });
        if (command === "get_runtime_platform") { if (!native) throw new Error("not available in preview"); return { os: "macos", arch: "aarch64" }; }
        if (command === "get_default_shell") { if (!native) throw new Error("not available in preview"); return { command: "/opt/homebrew/bin/fish", args: ["-l", "-i"] }; }
        if (command === "plugin:event|listen") {
          if (!listeners.has(args.event)) listeners.set(args.event, new Map());
          const eventId = ++id; listeners.get(args.event)!.set(eventId, args.handler); return eventId;
        }
        if (command === "plugin:event|unlisten") { listeners.get(args.event)?.delete(args.eventId); return; }
        if (command === "plugin:window|is_maximized") return false;
        if (command === "plugin:window|is_fullscreen") return !!w.__fullscreen;
        if (command === "plugin:window|set_fullscreen") { w.__fullscreen = args.value; return; }
        if (command === "plugin:window|scale_factor") return 1;
        if (command === "plugin:window|outer_size") return { width: 1360, height: 900 };
        if (command === "plugin:window|outer_position") return { x: 0, y: 0 };
        if (command === "check_app_update") return { installed: "0.7.0", latest: update ? "0.7.1" : "0.7.0", updateAvailable: update, supported: true, platform: "macos", installerKind: "dmg" };
        if (command === "download_app_update") return { version: "0.7.1", filename: "Agentdeck_0.7.1_universal.dmg" };
        if (command === "install_app_update") return;
        if (command === "check_cli") return true;
        if (command === "get_git_status") return { staged: [], unstaged: [], untracked: [], conflicts: [], committed: [] };
        if (["recover_workspace_sessions", "backfill_workspace_session_bindings", "list_agent_models", "get_provider_usage", "observe_agent_sessions", "memory_list", "search_knowledge"].includes(command) || command.startsWith("get_git_diff")) return [];
        if (command === "load_ui_states" || command === "load_deleted_ui_state") return {};
        if (command === "get_knowledge_config") return { sourcePath: "", mode: "markdown" };
        if (command === "memory_status") return { enabled: true, captureEnabled: true, budgetTokens: 800, recordCount: 0, storage: "local", retrieval: "fts5", estimatedTokenMethod: "bytes/4" };
        if (command === "get_token_economy_status") return { enabled: true, available: false, scope: "agentdeck", reason: "not-installed", estimationMethod: "bytes/4" };
        if (command === "save_chat_attachment") return { name: args.name, path: "/Users/test/Library/Application Support/com.tuxao.agentdeck/chat-attachments/" + args.name, mimeType: args.mimeType, size: Math.floor(args.dataBase64.length * 3 / 4) };
        if (command === "steer_chat_turn") return "accepted";
        if (command === "start_pty_session") { w.__emit("pty-started", { session_id: args.sessionId, pid: 9876, command: args.command, workdir: args.workdir }); return; }
        if (command === "start_chat_turn") {
          const emit = (event: unknown) => w.__emit("chat-event", { sessionId: args.request.sessionId, turnId: args.request.turnId, ...event as object });
          emit({ kind: "status", status: "started", pid: 8765 });
          emit({ kind: "session", providerSessionId: "native-mac-session" });
          emit({ kind: "text", itemId: "answer", text: "macOS conversation resumed.", delta: true });
          if (!w.__deferCompletion) emit({ kind: "done", status: "completed" });
          return;
        }
        return null;
      },
    };
    const path = "/Users/test/Projects/Agentdeck";
    localStorage.setItem("agentdeck-settings", JSON.stringify({ state: { settings: { locale, theme: "dark", splitWidgetPanelCollapsed: true, runner: { type: "codex" } } }, version: 0 }));
    localStorage.setItem("agentdeck-workspaces", JSON.stringify({ state: { workspaces: [{ id: "project", name: "Mac project", path, color: "blue", createdAt: 1, order: 0 }], activeWorkspaceId: "project" }, version: 0 }));
    localStorage.setItem("agentdeck-sessions", JSON.stringify({ state: { sessions: [{ id: "mac-session", name: "Mac conversation", workspaceId: "project", workdir: path, status: "idle", currentTask: "", createdAt: 1, diffFiles: [], output: [], runner: { type: "codex" } }], activeSessionId: "mac-session" }, version: 0 }));
  }, { locale, native, update, legacyCrypto });
  await page.goto("/");
  await expect(page.locator(".ad-quick-switch-trigger")).toBeVisible();
}

const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__calls.filter((call: any) => call.command === command), command);

async function openMacConversation(page: Page) {
  await page.getByText("Mac conversation", { exact: true }).first().click();
  const open = page.getByTitle("Open conversation");
  if (await open.count()) await open.first().click();
  await expect(page.locator(".ad-chat-composer textarea:visible")).toBeVisible();
}

async function prepareWarningTurn(page: Page, turnId = "warning-turn") {
  await page.evaluate(async turnId => {
    const path = "/src/store/chatStore.ts";
    const store = await import(/* @vite-ignore */ path);
    await store.ensureChatEvents();
    store.useChatStore.getState().patch("mac-session", { busy: true, turnId, status: "reasoning", activity: "Reviewing the project", lastEventAt: Date.now() - 120000 });
  }, turnId);
}

async function emitWarning(page: Page, text = "MCP authentication failed for server miro. Refresh OAuth login to reconnect.", turnId = "warning-turn") {
  await page.evaluate(({ text, turnId }) => { (window as any).__emit("chat-event", { sessionId: "mac-session", turnId, kind: "status", status: "mcp-auth-warning", text }); }, { text, turnId });
}

test("@macos native platform drives Command navigation, login shell and terminal clipboard", async ({ page }) => {
  // Intel WebKit's first xterm mount can take longer while Vite compiles the lazy module.
  test.setTimeout(60_000);
  await setup(page);
  await expect(page.locator(".ad-quick-switch-trigger kbd")).toHaveText("⌘ K");
  await expect(page.locator(".ad-quick-switch-trigger")).toHaveAttribute("aria-keyshortcuts", "Meta+K");
  await page.keyboard.press("Meta+k");
  const dialog = page.getByRole("dialog", { name: "Quick navigation", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Expand terminal", exact: true }).click();
  await expect.poll(async () => (await calls(page, "start_pty_session")).length, { timeout: 15_000 }).toBe(1);
  const launch = (await calls(page, "start_pty_session"))[0].args;
  expect(launch.command).toBe("/opt/homebrew/bin/fish");
  expect(launch.args).toEqual(["-l", "-i"]);
  expect(launch.workdir).toBe("/Users/test/Projects/Agentdeck");
  const input = page.locator(".ad-terminal-runtime:visible .xterm-helper-textarea");
  await input.focus();
  await page.keyboard.press("Control+c");
  await expect.poll(async () => (await calls(page, "write_pty")).some((call: any) => call.args.data === "Aw==")).toBe(true);
  await page.keyboard.press("Meta+v");
  await expect.poll(async () => (await calls(page, "write_pty")).some((call: any) => Buffer.from(call.args.data, "base64").toString("utf8") === "Olá macOS 👩‍💻")).toBe(true);
  expect(await calls(page, "get_runtime_platform")).toHaveLength(1);
  expect(await calls(page, "get_default_shell")).toHaveLength(1);
  const shellCommand = await page.evaluate(async () => { const path = "/src/services/platform.ts"; return (await import(/* @vite-ignore */ path)).getShellCommand("npm install -g @openai/codex"); });
  expect(shellCommand).toEqual({ command: "/opt/homebrew/bin/fish", args: ["-l", "-c", "npm install -g @openai/codex"] });
});

test("@macos window controls close the window and toggle full screen without quitting", async ({ page }) => {
  await setup(page);
  await expect(page.locator(".ad-brand > .ad-window-controls.is-macos")).toBeVisible();
  await page.getByRole("button", { name: "Enter full screen", exact: true }).click();
  await expect(page.getByRole("button", { name: "Exit full screen", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Exit full screen", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enter full screen", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Minimize", exact: true }).click();
  await page.getByRole("button", { name: "Close window", exact: true }).click();
  expect(await calls(page, "plugin:window|close")).toHaveLength(1);
  expect(await calls(page, "plugin:window|minimize")).toHaveLength(1);
  expect(await calls(page, "exit_app")).toHaveLength(0);
  expect((await calls(page, "plugin:window|set_fullscreen")).map((call: any) => call.args.value)).toEqual([true, false]);
  await page.screenshot({ path: "test-results/macos-titlebar.png", animations: "disabled" });
});

for (const [locale, badge, title, open, status] of [
  ["en-US", "New Agent Deck version 0.7.1", "Agent Deck updates", "Open disk image", "Disk image opened"],
  ["pt-BR", "Nova versão do Agent Deck 0.7.1", "Atualizações do Agent Deck", "Abrir imagem de disco", "Imagem de disco aberta"],
  ["es-ES", "Nueva versión de Agent Deck 0.7.1", "Actualizaciones de Agent Deck", "Abrir imagen de disco", "Imagen de disco abierta"],
]) test(`@macos verified disk image update explains Applications replacement in ${locale}`, async ({ page }) => {
  await setup(page, { locale, update: true });
  await page.getByRole("button", { name: badge, exact: true }).click();
  const panel = page.getByRole("region", { name: title, exact: true });
  const button = panel.getByRole("button", { name: open, exact: true });
  await expect(button).toBeEnabled();
  expect(await calls(page, "download_app_update")).toHaveLength(1);
  expect(await calls(page, "install_app_update")).toHaveLength(0);
  await page.evaluate(async () => { const path = "/src/store/chatStore.ts"; (await import(/* @vite-ignore */ path)).useChatStore.getState().patch("mac-session", { busy: true }); });
  await expect(button).toBeDisabled();
  await page.evaluate(async () => { const path = "/src/store/chatStore.ts"; (await import(/* @vite-ignore */ path)).useChatStore.getState().patch("mac-session", { busy: false }); });
  await button.click();
  await expect(panel.getByRole("status")).toContainText(status);
  await expect(panel.getByRole("status")).toContainText(/Applications|Aplicativos|Aplicaciones/);
  await expect(button).toBeDisabled();
  expect(await calls(page, "install_app_update")).toHaveLength(1);
  expect(await calls(page, "exit_app")).toHaveLength(0);
});

test("@macos structured Codex conversation keeps POSIX paths and resumes provider context", async ({ page }) => {
  await setup(page);
  await page.getByText("Mac conversation", { exact: true }).first().click();
  const open = page.getByTitle("Open conversation");
  if (await open.count()) await open.first().click();
  const input = page.locator(".ad-chat-composer textarea:visible");
  await input.fill("Review the macOS workspace");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("macOS conversation resumed.", { exact: true })).toBeVisible();
  await input.fill("Continue with the existing conversation");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(async () => (await calls(page, "start_chat_turn")).length).toBe(2);
  const turns = await calls(page, "start_chat_turn");
  expect(turns[0].args.request.workdir).toBe("/Users/test/Projects/Agentdeck");
  expect(turns[1].args.request.providerSessionId).toBe("native-mac-session");
});

test("Windows browser preview falls back to Ctrl and cmd when native platform is unavailable", async ({ page }) => {
  await setup(page, { native: false });
  await expect(page.locator(".ad-quick-switch-trigger kbd")).toHaveText("Ctrl K");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Quick navigation", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Expand terminal", exact: true }).click();
  await expect.poll(async () => (await calls(page, "start_pty_session")).length).toBe(1);
  const launch = (await calls(page, "start_pty_session"))[0].args;
  expect(launch.command).toBe("cmd.exe");
  expect(launch.args).toEqual(["/K"]);
});

test("@macos missing randomUUID preserves terminal tabs, active input and chat continuation", async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page, { legacyCrypto: true });
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
  await page.getByRole("button", { name: "Expand terminal", exact: true }).click();
  await page.getByRole("button", { name: "Create terminal tab", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Terminal 2", exact: true })).toBeVisible();
  const terminalId = await page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-settings")!).state.settings.splitWidgetCanvas.items.find((item: any) => item.type === "terminal").tabs.find((tab: any) => tab.title === "Terminal 2").id.slice("terminal-tab-".length));
  await page.getByRole("button", { name: "Collapse terminal", exact: true }).click();
  await page.getByText("Mac conversation", { exact: true }).first().click();
  const open = page.getByTitle("Open conversation");
  if (await open.count()) await open.first().click();
  await page.evaluate(() => { (window as any).__deferCompletion = true; });
  const input = page.locator(".ad-chat-composer textarea:visible");
  await input.fill("Start the macOS review");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("macOS conversation resumed.", { exact: true })).toBeVisible();
  await input.fill("Include the existing architectural decision");
  await page.getByRole("button", { name: "Send additional input", exact: true }).click();
  await expect(page.getByText("Additional input delivered", { exact: true })).toBeVisible();
  const turn = (await calls(page, "start_chat_turn"))[0].args.request;
  const supplement = (await calls(page, "steer_chat_turn"))[0].args;
  expect(supplement.request.turnId).toBe(turn.turnId);
  await page.evaluate(turnId => { (window as any).__emit("chat-event", { sessionId: "mac-session", turnId, kind: "done", status: "completed" }); }, turn.turnId);
  const continuation = page.getByRole("button", { name: "New chat with context", exact: true }).first();
  await expect(continuation).toBeEnabled();
  await continuation.click();
  const review = page.getByRole("dialog", { name: "Review the context to transfer" });
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: "Create conversation with this context", exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-sessions")!).state.activeSessionId)).not.toBe("mac-session");
  const continuationId = await page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-sessions")!).state.activeSessionId);
  const ids = [terminalId, turn.turnId, supplement.messageId, continuationId];
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(new Set(ids).size).toBe(4);
  await expect(input).toHaveValue(/Include the existing architectural decision/);
  expect(await calls(page, "start_chat_turn")).toHaveLength(1);
  expect(await calls(page, "save_chat_attachment")).toHaveLength(1);
  const savedArchive = (await calls(page, "save_chat_attachment"))[0].args;
  const history = JSON.parse(Buffer.from(savedArchive.dataBase64, "base64").toString("utf8"));
  expect(history.session.workdir).toBe("/Users/test/Projects/Agentdeck");
  expect(history.messages.some((message: any) => message.text === "Include the existing architectural decision")).toBe(true);
});

test("@macos optional MCP startup logs stay in details while quoted prompts and successful replies never create warnings", async ({ page }) => {
  await setup(page); await openMacConversation(page);
  const quote = "History quoted: failed to refresh OAuth tokens for server miro. The requested work succeeded.";
  await page.locator(".ad-chat-composer textarea:visible").fill(quote);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".ad-user-text")).toContainText(quote);
  await prepareWarningTurn(page);
  const before = await page.evaluate(async () => { const path = "/src/store/chatStore.ts"; return (await import(/* @vite-ignore */ path)).useChatStore.getState().threads["mac-session"].lastEventAt; });
  const diagnostic = "Optional MCP connector miro could not refresh its login. The conversation can continue. Reconnect this connector in Codex if you need to use it.";
  await page.evaluate(diagnostic => {
    const w = window as any, base = { sessionId: "mac-session", turnId: "warning-turn", kind: "status", status: "diagnostic" };
    w.__emit("chat-event", { ...base, title: "MCP login", text: diagnostic });
    w.__emit("chat-event", { ...base, text: "Connected to Codex; optional connector initialization finished" });
  }, diagnostic);
  const details = page.locator(".ad-chat-execution-details");
  await expect(details.locator("summary")).toHaveText("Execution details");
  await expect(details.locator("pre")).toBeHidden();
  await expect(page.locator(".ad-chat-warning")).toHaveCount(0);
  await expect(page.locator(".ad-turn-activity-detail")).not.toContainText("miro");
  expect(await page.evaluate(async () => { const path = "/src/store/chatStore.ts"; const thread = (await import(/* @vite-ignore */ path)).useChatStore.getState().threads["mac-session"]; return { lastEventAt: thread.lastEventAt, activity: thread.activity, warning: thread.mcpAuthWarning }; })).toEqual({ lastEventAt: before, activity: "Reviewing the project", warning: undefined });
  await details.locator("summary").click();
  await expect(details.locator("pre")).toContainText(diagnostic);
  await page.evaluate(quote => {
    const w = window as any, base = { sessionId: "mac-session", turnId: "warning-turn" };
    w.__emit("chat-event", { ...base, kind: "text", itemId: "quoted-response", text: quote });
    w.__emit("chat-event", { ...base, kind: "tool", itemId: "read-history", title: "Terminal", command: "Read earlier transcript", output: quote, status: "completed", exitCode: 0 });
    w.__emit("chat-event", { ...base, kind: "done", status: "completed" });
  }, quote);
  await expect(page.locator(".ad-message-assistant").last()).toContainText(quote);
  await expect(page.locator('.ad-chat-error[role="alert"]')).toHaveCount(0);
  await expect(page.locator(".ad-chat-warning")).toHaveCount(0);
  await expect(details.locator("pre")).toContainText(diagnostic);
  expect(await page.evaluate(async () => { const path = "/src/store/chatStore.ts"; const thread = (await import(/* @vite-ignore */ path)).useChatStore.getState().threads["mac-session"]; return { busy: thread.busy, status: thread.status, warning: thread.mcpAuthWarning }; })).toEqual({ busy: false, status: "completed", warning: undefined });
  await page.screenshot({ path: ".local/validation/mcp-startup-details.png" });
});

test("@macos requested MCP authentication failures remain visible as real tool and conversation errors", async ({ page }) => {
  await setup(page); await openMacConversation(page); await prepareWarningTurn(page);
  await page.evaluate(() => {
    const w = window as any, base = { sessionId: "mac-session", turnId: "warning-turn" };
    w.__emit("chat-event", { ...base, kind: "tool", itemId: "miro-action", title: "miro · create-board", text: "Miro authentication is required for this action", status: "failed" });
    w.__emit("chat-event", { ...base, kind: "error", text: "The requested Miro action needs authentication" });
    w.__emit("chat-event", { ...base, kind: "done", status: "error" });
  });
  await expect(page.locator(".ad-tool-card")).toContainText("miro · create-board");
  await expect(page.locator('.ad-chat-error[role="alert"]')).toContainText("The requested Miro action needs authentication");
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await expect(page.locator(".ad-chat-warning")).toHaveCount(0);
});

test("@macos real MCP authentication notices expire without duplicate renewal or losing fatal errors", async ({ page }) => {
  test.setTimeout(60_000);
  await page.clock.install();
  await setup(page); await openMacConversation(page); await prepareWarningTurn(page);
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 1000)));
  const warning = page.locator(".ad-chat-warning");
  const before = await page.evaluate(async () => { const path = "/src/store/chatStore.ts"; return (await import(/* @vite-ignore */ path)).useChatStore.getState().threads["mac-session"].lastEventAt; });
  await emitWarning(page);
  await expect(warning).toContainText("miro");
  const deadline = await page.evaluate(async () => { const path = "/src/store/chatStore.ts"; const t = (await import(/* @vite-ignore */ path)).useChatStore.getState().threads["mac-session"]; return { until: t.mcpAuthWarningUntil, lastEventAt: t.lastEventAt, activity: t.activity }; });
  expect(deadline.lastEventAt).toBe(before); expect(deadline.activity).toBe("Reviewing the project");
  await page.clock.runFor(5000);
  await emitWarning(page);
  await page.evaluate(async () => { const path = "/src/store/settingsStore.ts"; (await import(/* @vite-ignore */ path)).useSettingsStore.getState().patchSettings({ theme: "light" }); });
  expect(await page.evaluate(async () => { const path = "/src/store/chatStore.ts"; return (await import(/* @vite-ignore */ path)).useChatStore.getState().threads["mac-session"].mcpAuthWarningUntil; })).toBe(deadline.until);
  await page.clock.runFor(2999); await expect(warning).toBeVisible();
  await page.clock.runFor(1); await expect(warning).toHaveCount(0);
  await emitWarning(page); await expect(warning).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    w.__emit("chat-event", { sessionId: "mac-session", turnId: "warning-turn", kind: "heartbeat", pid: 8765 });
    w.__emit("chat-event", { sessionId: "mac-session", turnId: "warning-turn", kind: "text", itemId: "normal-output", text: "Historical MCP authentication warning mentioned during the review", delta: true });
    w.__emit("chat-event", { sessionId: "mac-session", turnId: "warning-turn", kind: "status", status: "diagnostic", text: "MCP authentication failed for server miro." });
  });
  await page.clock.runFor(40); await expect(warning).toHaveCount(0);
  await emitWarning(page, "MCP authentication failed for server slack. Refresh OAuth login.");
  await expect(warning).toContainText("slack");
  await warning.getByRole("button", { name: "Dismiss authentication notice", exact: true }).click();
  await emitWarning(page, "MCP authentication failed for server slack. Refresh OAuth login.");
  await expect(warning).toHaveCount(0);
  await prepareWarningTurn(page, "next-warning-turn");
  await emitWarning(page, undefined, "next-warning-turn"); await expect(warning).toContainText("miro");
  await page.evaluate(() => { (window as any).__emit("chat-event", { sessionId: "mac-session", turnId: "next-warning-turn", kind: "error", text: "Provider request failed permanently" }); });
  await page.clock.runFor(8000); await expect(warning).toHaveCount(0);
  await expect(page.locator('.ad-chat-error[role="alert"]')).toContainText("Provider request failed permanently");
});

test("@macos restored MCP warnings stay hidden and live notices are omitted from persistent snapshots", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => localStorage.setItem("agentdeck-chat-v1", JSON.stringify({ "mac-session": { messages: [], draft: "Keep this draft", busy: false, mcpAuthWarning: "Legacy miro OAuth warning", mcpAuthWarningUntil: Date.now() + 600000 } })));
  await setup(page); await openMacConversation(page);
  const warning = page.locator(".ad-chat-warning");
  await expect(warning).toHaveCount(0);
  await prepareWarningTurn(page); await emitWarning(page); await expect(warning).toContainText("miro");
  const saved = await page.evaluate(async () => {
    const path = "/src/store/chatStore.ts"; await (await import(/* @vite-ignore */ path)).persistChatHistory();
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("agentdeck-chat-history-v1"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const record = await new Promise<any>((resolve, reject) => { const request = db.transaction("threads").objectStore("threads").get("mac-session"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close(); return { cache: JSON.parse(localStorage.getItem("agentdeck-chat-v1")!)["mac-session"], archive: record.thread };
  });
  expect(saved.cache).not.toHaveProperty("mcpAuthWarning"); expect(saved.cache).not.toHaveProperty("mcpAuthWarningUntil");
  expect(saved.archive).not.toHaveProperty("mcpAuthWarning"); expect(saved.archive).not.toHaveProperty("mcpAuthWarningUntil");
  // Simulate a pre-upgrade IndexedDB record, independently of the clean startup cache.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open("agentdeck-chat-history-v1"); request.onsuccess = () => resolve(request.result); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("threads", "readwrite"), store = tx.objectStore("threads");
      const request = store.get("mac-session"); request.onsuccess = () => store.put({ ...request.result, thread: { ...request.result.thread, mcpAuthWarning: "Archived miro OAuth warning", mcpAuthWarningUntil: Date.now() + 600000 } });
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    }); db.close();
  });
  await page.reload(); await openMacConversation(page); await expect(warning).toHaveCount(0);
  const restored = await page.evaluate(async () => { const path = "/src/store/chatStore.ts"; const store = await import(/* @vite-ignore */ path); await store.chatHistoryReady; return store.useChatStore.getState().threads["mac-session"]; });
  expect(restored.mcpAuthWarning).toBeUndefined(); expect(restored.mcpAuthWarningUntil).toBeUndefined();
  await expect(page.locator(".ad-chat-composer textarea:visible")).toHaveValue("Keep this draft");
});
