import { expect, test, type Page } from "@playwright/test";

async function setupEconomy(page: Page, available = true) {
  await page.addInitScript(({ available }) => {
    const w = window as any;
    const callbacks = new Map<number, Function>();
    const listeners = new Map<string, Map<number, number>>();
    let nextId = 0;
    w.__economyCalls = [];
    w.__economyReject = false;
    w.__economyStatus = { enabled: true, available, version: available ? "rtk 0.39.0" : null, totalInputTokens: available ? 10000 : null, totalOutputTokens: available ? 2500 : null, savedTokens: available ? 7500 : null, savingsPercent: available ? 75 : null, commandCount: available ? 12 : null, scope: "agentdeck", source: "rtk gain --format json", estimationMethod: "bytes/4", claudeHookAvailable: available };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "popup" }, currentWebview: { label: "popup" } },
      transformCallback: (callback: Function) => { callbacks.set(++nextId, callback); return nextId; },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        w.__economyCalls.push({ command, args });
        if (command === "get_token_economy_status") return { ...w.__economyStatus, scope: args.scope ?? w.__economyStatus.scope };
        if (command === "set_token_economy_enabled") {
          if (w.__economyReject) throw new Error("Cannot save configuration");
          w.__economyStatus.enabled = args.enabled;
          return { ...w.__economyStatus };
        }
        if (command === "plugin:event|listen") { if (!listeners.has(args.event)) listeners.set(args.event, new Map()); listeners.get(args.event)!.set(++nextId, args.handler); return nextId; }
        if (command === "plugin:event|unlisten") { listeners.get(args.event)?.delete(args.eventId); return; }
        if (command === "plugin:window|is_maximized") return false;
        if (command === "plugin:window|scale_factor") return 1;
        if (command === "plugin:window|outer_size") return { width: 1360, height: 900 };
        if (command === "plugin:window|outer_position") return { x: 0, y: 0 };
        if (command === "get_git_status") return { staged: [], unstaged: [], untracked: [], conflicts: [], committed: [] };
        if (command === "check_cli") return true;
        if (["recover_workspace_sessions", "backfill_workspace_session_bindings", "list_agent_models", "get_provider_usage"].includes(command) || command.startsWith("get_git_diff")) return [];
        if (command === "load_ui_states" || command === "load_deleted_ui_state") return {};
        return null;
      },
    };
    localStorage.setItem("agentdeck-settings", JSON.stringify({ state: { settings: { locale: "pt-BR", theme: "dark", splitWidgetPanelCollapsed: true, runner: { type: "codex" } } }, version: 0 }));
    localStorage.setItem("agentdeck-workspaces", JSON.stringify({ state: { workspaces: [{ id: "workspace", name: "Agentdeck", path: "C:\\Project", color: "green", createdAt: 1, order: 0 }], activeWorkspaceId: "workspace" }, version: 0 }));
    localStorage.setItem("agentdeck-sessions", JSON.stringify({ state: { sessions: [{ id: "economy", name: "Economy session", workspaceId: "workspace", workdir: "C:\\Project", status: "idle", currentTask: "", createdAt: 1, diffFiles: [], output: [], runner: { type: "codex" } }], activeSessionId: "economy" }, version: 0 }));
    localStorage.setItem("agentdeck-chat-v1", JSON.stringify({ economy: { messages: [], draft: "", busy: false, lastUsage: { inputTokens: 1000, outputTokens: 125, cachedInputTokens: 400 } } }));
  }, { available });
  await page.goto("/");
  await page.getByText("Economy session", { exact: true }).first().click();
  const open = page.getByTitle("Abrir conversa");
  if (await open.count()) await open.first().click();
  await page.getByRole("button", { name: "Economia de tokens", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Economia de tokens" })).toBeVisible();
}

test("token economy separates measured RTK estimates from CLI usage and persists the shared toggle", async ({ page }) => {
  await setupEconomy(page);
  const panel = page.getByRole("dialog", { name: "Economia de tokens" });
  await expect(panel.getByRole("heading", { name: "Histórico do RTK no Agentdeck" })).toBeVisible();
  await expect(panel.getByText("≈ 75%", { exact: true })).toBeVisible();
  await expect(panel.getByText("≈ 7.500", { exact: true })).toBeVisible();
  const usage = panel.getByRole("region", { name: "Última resposta" });
  await expect(usage.getByText("1.000", { exact: true })).toBeVisible();
  await expect(usage.getByText("400", { exact: true })).toBeVisible();
  await expect(usage.getByText("125", { exact: true })).toBeVisible();
  await expect(usage.getByText("O cache já faz parte da entrada; os valores não são somados novamente.")).toBeVisible();
  const toggle = panel.getByRole("switch", { name: "Economia em todas as conversas" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(await page.evaluate(() => (window as any).__economyCalls.some((call: any) => call.command === "set_token_economy_enabled" && call.args.enabled === false))).toBe(true);
  await page.evaluate(() => { (window as any).__economyReject = true; });
  await toggle.click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Economia de tokens", exact: true })).toBeFocused();
});

test("missing RTK exposes an official installation command without invented savings", async ({ page }) => {
  await setupEconomy(page, false);
  const panel = page.getByRole("dialog", { name: "Economia de tokens" });
  await expect(panel.getByText("RTK não encontrado", { exact: true })).toBeVisible();
  await expect(panel.getByText("Sem medições disponíveis", { exact: true })).toBeVisible();
  await expect(panel.locator(".ad-economy-saved")).toHaveCount(0);
  await expect(panel.locator(".ad-economy-install code")).toHaveText(/winget install rtk-ai\.rtk|cargo install --git https:\/\/github.com\/rtk-ai\/rtk/);
  await expect(panel.getByRole("switch", { name: "Economia em todas as conversas" })).toBeChecked();
  const position = await panel.boundingBox();
  expect(position!.y).toBeGreaterThan(44);
  expect(position!.x).toBeGreaterThanOrEqual(0);
  await expect(panel).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "test-results/token-economy.png", animations: "disabled" });
});

test("conversation usage accumulates provider reports once and persists without inventing historical usage", async ({ page }) => {
  await setupEconomy(page);
  const measured = await page.evaluate(async () => {
    const modulePath = "/src/store/chatStore.ts";
    const { useChatStore } = await import(/* @vite-ignore */ modulePath);
    const store = useChatStore.getState();
    const report = (turnId: string, usage: unknown, extra = {}) => store.event({ sessionId: "economy", turnId, kind: "status", usage, ...extra });
    store.patch("economy", { turnId: "first", busy: true });
    report("first", { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 125 });
    report("first", { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 125 });
    report("first", { input_tokens: 1200, cached_input_tokens: 500, output_tokens: 150 });
    report("first", { input_tokens: 9999, output_tokens: 9999 }, { parentId: "subagent" });
    store.patch("economy", { turnId: "second" });
    report("first", { input_tokens: 9999, output_tokens: 9999 });
    report("second", { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 50, output_tokens: 75 });
    report("second", { input_tokens: -1, output_tokens: 9 });
    report("second", { input_tokens: null, output_tokens: 9 });
    store.event({ sessionId: "economy", turnId: "second", kind: "done" });
    const current = useChatStore.getState().threads.economy;
    window.dispatchEvent(new Event("pagehide"));
    const persisted = JSON.parse(localStorage.getItem("agentdeck-chat-v1")!).economy;
    return { total: current.totalUsage, last: current.lastUsage, turns: current.meteredTurns, persisted: persisted.totalUsage };
  });
  expect(measured.total).toEqual({ inputTokens: 1550, cachedInputTokens: 700, outputTokens: 225 });
  expect(measured.last).toEqual({ inputTokens: 350, cachedInputTokens: 200, outputTokens: 75 });
  expect(measured.turns).toBe(2);
  expect(measured.persisted).toEqual(measured.total);
  const total = page.getByRole("region", { name: "Uso registrado nesta conversa" });
  await expect(total.getByText("1.550", { exact: true })).toBeVisible();
  await expect(total.getByText("225", { exact: true })).toBeVisible();
  await expect(total.getByText("45,2%", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Economia de tokens", exact: true })).toContainText("45,2% cache");
});

test("RTK shows measured zero and switches scope without attributing global savings to the project", async ({ page }) => {
  await setupEconomy(page);
  const panel = page.getByRole("dialog", { name: "Economia de tokens" });
  await page.evaluate(() => Object.assign((window as any).__economyStatus, { totalInputTokens: 0, totalOutputTokens: 0, savedTokens: 0, savingsPercent: 0, commandCount: 0 }));
  await panel.getByRole("button", { name: "Atualizar economia de tokens", exact: true }).click();
  await expect(panel.getByText("≈ 0", { exact: true })).toHaveCount(3);
  await expect(panel.getByText("Sem medições disponíveis", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("Conversas sem comandos não geram medições RTK. O uso e o cache da IA aparecem abaixo quando o provedor os informa.", { exact: true })).toBeVisible();
  const scope = panel.getByRole("combobox", { name: "Escopo das medições" });
  await scope.selectOption("global");
  await expect(panel.getByRole("heading", { name: "Histórico global do RTK" })).toBeVisible();
  await scope.selectOption("project");
  await expect(panel.getByRole("heading", { name: "Histórico do RTK neste projeto" })).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__economyCalls.filter((call: any) => call.command === "get_token_economy_status"));
  expect(calls.some((call: any) => call.args.scope === "global")).toBe(true);
  expect(calls.some((call: any) => call.args.scope === "project" && call.args.workdir === "C:\\Project")).toBe(true);
});
