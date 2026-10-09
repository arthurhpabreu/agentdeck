import { expect, test, type Page } from "@playwright/test";

type TelegramSettings = {
  enabled: boolean;
  configured: boolean;
  botUsername: string | null;
  chatLabel: string | null;
  lastError: string | null;
};

const disconnected: TelegramSettings = { enabled: false, configured: false, botUsername: null, chatLabel: null, lastError: null };
const connected: TelegramSettings = { enabled: true, configured: true, botUsername: "agentdeck_fixture_bot", chatLabel: "Fixture user", lastError: null };
// Deliberately synthetic; no real bot credentials or notification network is used.
const fixtureToken = "12345:TEST_TOKEN_ONLY";
const pairingUrl = "https://t.me/agentdeck_fixture_bot?start=fixture_pairing_nonce";

async function setup(page: Page, initial = disconnected) {
  await page.addInitScript(({ initial, pairingUrl }) => {
    const w = window as any;
    const callbacks = new Map<number, Function>();
    const listeners = new Map<string, Map<number, number>>();
    let id = 0;
    w.__telegramCalls = [];
    w.__telegramSettings = initial;
    w.__telegramFailures = {};
    w.__notificationsEnabled = true;
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "popup" }, currentWebview: { label: "popup" } },
      transformCallback: (callback: Function) => { callbacks.set(++id, callback); return id; },
      unregisterCallback: (callbackId: number) => callbacks.delete(callbackId),
      invoke: async (command: string, args: any = {}) => {
        w.__telegramCalls.push({ command, args });
        if (w.__telegramFailures[command]) throw w.__telegramFailures[command];
        if (command === "plugin:event|listen") {
          if (!listeners.has(args.event)) listeners.set(args.event, new Map());
          const listenerId = ++id;
          listeners.get(args.event)!.set(listenerId, args.handler);
          return listenerId;
        }
        if (command === "plugin:event|unlisten") { listeners.get(args.event)?.delete(args.eventId); return; }
        if (command === "plugin:window|is_maximized") return false;
        if (command === "plugin:window|scale_factor") return 1;
        if (command === "plugin:window|outer_size") return { width: 1360, height: 900 };
        if (command === "plugin:window|outer_position") return { x: 0, y: 0 };
        if (command === "get_notifications_and_hooks_status") return { enabled: w.__notificationsEnabled };
        if (command === "set_notifications_and_hooks_enabled") { w.__notificationsEnabled = args.enabled; return "updated"; }
        if (command === "get_telegram_notification_settings") return w.__telegramSettings;
        if (command === "start_telegram_pairing") return { pairingId: "fixture-pairing-id", url: pairingUrl, botUsername: "agentdeck_fixture_bot" };
        if (command === "finish_telegram_pairing") {
          w.__telegramSettings = { enabled: false, configured: true, botUsername: "agentdeck_fixture_bot", chatLabel: "Fixture user", lastError: null };
          return w.__telegramSettings;
        }
        if (command === "set_telegram_notifications_enabled") {
          w.__telegramSettings = { ...w.__telegramSettings, enabled: args.enabled };
          return w.__telegramSettings;
        }
        if (command === "send_telegram_test") return;
        if (command === "disconnect_telegram_notifications") {
          w.__telegramSettings = w.__telegramDisconnectResult ?? { enabled: false, configured: false, botUsername: null, chatLabel: null, lastError: null };
          return w.__telegramSettings;
        }
        if (command === "check_app_update") return { installed: "0.6.6", latest: "0.6.6", updateAvailable: false, supported: true, installerKind: "exe" };
        if (command === "check_cli_update") return { provider: args.provider, installed: "test", latest: "test", updateAvailable: false, method: "manual", error: null };
        if (command === "check_cli") return true;
        if (command === "get_git_status") return { staged: [], unstaged: [], untracked: [], conflicts: [], committed: [] };
        if (["recover_workspace_sessions", "backfill_workspace_session_bindings", "list_agent_models", "get_provider_usage", "observe_agent_sessions", "memory_list", "search_knowledge"].includes(command) || command.startsWith("get_git_diff")) return [];
        if (command === "load_ui_states" || command === "load_deleted_ui_state") return {};
        if (command === "get_knowledge_config") return { sourcePath: "", mode: "markdown" };
        if (command === "memory_status") return { enabled: true, captureEnabled: true, budgetTokens: 800, recordCount: 0, projectKey: args.projectPath, storage: "local", retrieval: "fts5", estimatedTokenMethod: "bytes/4" };
        if (command === "get_token_economy_status") return { enabled: true, available: false, scope: "agentdeck", reason: "not-installed", estimationMethod: "bytes/4" };
        return null;
      },
    };
    localStorage.setItem("agentdeck-settings", JSON.stringify({ state: { settings: { locale: "en-US", theme: "dark", splitWidgetPanelCollapsed: true, runner: { type: "codex" } } }, version: 0 }));
    localStorage.setItem("agentdeck-workspaces", JSON.stringify({ state: { workspaces: [{ id: "notifications", name: "Notification test project", path: "C:\\Projects\\Notifications", color: "green", createdAt: 1, order: 0 }], activeWorkspaceId: "notifications" }, version: 0 }));
    localStorage.setItem("agentdeck-sessions", JSON.stringify({ state: { sessions: [], activeSessionId: null }, version: 0 }));
  }, { initial, pairingUrl });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "System", exact: true }).click();
  await expect(panel(page)).toBeVisible();
}

const panel = (page: Page) => page.getByRole("region", { name: "Telegram notifications", exact: true });
const mobileSwitch = (page: Page) => panel(page).getByRole("switch", { name: "Also notify me on Telegram", exact: true });
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__telegramCalls.filter((call: any) => call.command === command), command);
const preferences = (page: Page) => page.evaluate(() => Object.values(localStorage).join("\n"));

test("Telegram private pairing protects the token and sends a test only on request", async ({ page }) => {
  await setup(page);
  const telegram = panel(page);
  await expect(telegram).toContainText("BotFather");
  await expect(telegram).toContainText("/newbot");
  const token = telegram.getByLabel("Bot token", { exact: true });
  await expect(token).toHaveAttribute("type", "password");
  await expect(token).toHaveAttribute("autocomplete", "off");
  await expect(mobileSwitch(page)).toHaveAttribute("aria-checked", "false");
  await expect(mobileSwitch(page)).toBeDisabled();
  expect(await calls(page, "start_telegram_pairing")).toHaveLength(0);
  expect(await calls(page, "send_telegram_test")).toHaveLength(0);

  await token.fill(fixtureToken);
  await telegram.getByRole("button", { name: "Connect Telegram", exact: true }).click();
  await expect(telegram.getByRole("button", { name: "Open bot in Telegram", exact: true })).toBeVisible();
  expect((await calls(page, "start_telegram_pairing"))[0].args).toEqual({ token: fixtureToken });
  expect(await preferences(page)).not.toContain(fixtureToken);
  expect(await calls(page, "plugin:opener|open_url")).toHaveLength(0);
  expect(await calls(page, "finish_telegram_pairing")).toHaveLength(0);

  await telegram.getByRole("button", { name: "Open bot in Telegram", exact: true }).click();
  expect((await calls(page, "plugin:opener|open_url"))[0].args.url).toBe(pairingUrl);
  await telegram.getByRole("button", { name: "I started the conversation", exact: true }).click();
  await expect(telegram).toContainText("Fixture user");
  expect((await calls(page, "finish_telegram_pairing"))[0].args).toEqual({ pairingId: "fixture-pairing-id" });
  await expect(mobileSwitch(page)).toHaveAttribute("aria-checked", "false");
  await mobileSwitch(page).click();
  await expect(mobileSwitch(page)).toHaveAttribute("aria-checked", "true");
  expect((await calls(page, "set_telegram_notifications_enabled"))[0].args).toEqual({ enabled: true });
  expect(await calls(page, "send_telegram_test")).toHaveLength(0);
  await telegram.getByRole("button", { name: "Send test", exact: true }).click();
  await expect(telegram.getByRole("status")).toContainText("sent");
  expect(await calls(page, "send_telegram_test")).toHaveLength(1);
  expect(await preferences(page)).not.toContain(fixtureToken);
});

test("the main notification switch pauses Telegram without losing the pairing and disconnect removes it", async ({ page }) => {
  await setup(page, connected);
  const master = page.getByRole("switch", { name: "Notifications", exact: true });
  await expect(mobileSwitch(page)).toHaveAttribute("aria-checked", "true");
  await master.click();
  await expect(master).toHaveAttribute("aria-checked", "false");
  await expect(mobileSwitch(page)).toBeDisabled();
  await expect(panel(page)).toContainText("Fixture user");
  expect(await calls(page, "set_telegram_notifications_enabled")).toHaveLength(0);
  expect(await calls(page, "send_telegram_test")).toHaveLength(0);

  // Explicit diagnostics stay available while automatic delivery is paused.
  await panel(page).getByRole("button", { name: "Send test", exact: true }).click();
  expect(await calls(page, "send_telegram_test")).toHaveLength(1);
  await master.click();
  await expect(master).toHaveAttribute("aria-checked", "true");
  await expect(mobileSwitch(page)).toBeEnabled();
  await expect(mobileSwitch(page)).toHaveAttribute("aria-checked", "true");
  await mobileSwitch(page).click();
  await expect(mobileSwitch(page)).toHaveAttribute("aria-checked", "false");
  expect((await calls(page, "set_telegram_notifications_enabled"))[0].args).toEqual({ enabled: false });

  await panel(page).getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(panel(page).getByLabel("Bot token", { exact: true })).toHaveValue("");
  await expect(panel(page).getByText("Fixture user", { exact: true })).toHaveCount(0);
  await expect(mobileSwitch(page)).toBeDisabled();
  expect(await calls(page, "disconnect_telegram_notifications")).toHaveLength(1);
  expect(await calls(page, "send_telegram_test")).toHaveLength(1);
});

test("pairing errors can be retried without exposing a bot credential or enabling alerts", async ({ page }) => {
  await setup(page);
  await page.evaluate(token => {
    (window as any).__telegramFailures.start_telegram_pairing = `request failed: https://api.telegram.org/bot${token}/getMe`;
  }, fixtureToken);
  await panel(page).getByLabel("Bot token", { exact: true }).fill(fixtureToken);
  await panel(page).getByRole("button", { name: "Connect Telegram", exact: true }).click();
  await expect(panel(page).getByRole("alert")).toBeVisible();
  await expect(panel(page).getByRole("alert")).toHaveText("Could not complete the Telegram request. Try again.");
  await expect(panel(page)).not.toContainText(fixtureToken);
  await expect(panel(page)).not.toContainText("api.telegram.org");
  expect(await preferences(page)).not.toContain(fixtureToken);
  expect(await calls(page, "finish_telegram_pairing")).toHaveLength(0);
  expect(await calls(page, "set_telegram_notifications_enabled")).toHaveLength(0);

  await page.evaluate(() => {
    delete (window as any).__telegramFailures.start_telegram_pairing;
    (window as any).__telegramFailures.finish_telegram_pairing = "telegram.errors.pairingNotFound";
  });
  await panel(page).getByLabel("Bot token", { exact: true }).fill(fixtureToken);
  await panel(page).getByRole("button", { name: "Connect Telegram", exact: true }).click();
  await panel(page).getByRole("button", { name: "I started the conversation", exact: true }).click();
  await expect(panel(page).getByRole("alert")).toContainText("tap Start in Telegram");
  await expect(mobileSwitch(page)).toHaveAttribute("aria-checked", "false");
  await expect(mobileSwitch(page)).toBeDisabled();
  expect(await calls(page, "send_telegram_test")).toHaveLength(0);

  await page.evaluate(() => { delete (window as any).__telegramFailures.finish_telegram_pairing; });
  await panel(page).getByRole("button", { name: "I started the conversation", exact: true }).click();
  await expect(panel(page)).toContainText("Fixture user");
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
  await expect(mobileSwitch(page)).toHaveAttribute("aria-checked", "false");
  expect(await calls(page, "finish_telegram_pairing")).toHaveLength(2);
  expect(await calls(page, "send_telegram_test")).toHaveLength(0);
});

test("a credential-store disconnect failure pauses alerts and remains available for cleanup retry", async ({ page }) => {
  await setup(page, connected);
  await page.evaluate(settings => {
    (window as any).__telegramDisconnectResult = { ...settings, enabled: false, lastError: "telegram.errors.secureStorage" };
  }, connected);
  await panel(page).getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(mobileSwitch(page)).toHaveAttribute("aria-checked", "false");
  await expect(panel(page).getByRole("alert")).toContainText("Secure storage is unavailable");
  await expect(panel(page)).toContainText("Fixture user");
  await expect(panel(page)).not.toContainText("saved token was removed");
  await expect(panel(page).getByRole("button", { name: "Disconnect", exact: true })).toBeEnabled();
  expect(await calls(page, "send_telegram_test")).toHaveLength(0);

  await page.evaluate(() => { delete (window as any).__telegramDisconnectResult; });
  await panel(page).getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
  await expect(panel(page).getByRole("status")).toContainText("saved token was removed");
  await expect(panel(page).getByLabel("Bot token", { exact: true })).toHaveValue("");
  await expect(mobileSwitch(page)).toBeDisabled();
  expect(await calls(page, "disconnect_telegram_notifications")).toHaveLength(2);
  expect(await calls(page, "send_telegram_test")).toHaveLength(0);
});
