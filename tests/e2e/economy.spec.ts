import { expect, test, type Page } from "@playwright/test";

async function setupEconomy(page: Page, available = true, openPanel = true) {
  await page.addInitScript(({ available }) => {
    const w = window as any;
    const callbacks = new Map<number, Function>();
    const listeners = new Map<string, Map<number, number>>();
    let nextId = 0;
    w.__economyCalls = [];
    w.__economyReject = false;
    w.__multiAgentEnabled = true;
    w.__multiAgentReject = false;
    w.__multiAgentAvailable = true;
    w.__economyEmit = (event: string, payload: unknown) => { for (const [id, callback] of listeners.get(event) ?? []) callbacks.get(callback)?.({ event, id, payload }); };
    w.__economyStatus = { enabled: true, available, version: available ? "rtk 0.39.0" : null, totalInputTokens: available ? 10000 : null, totalOutputTokens: available ? 2500 : null, savedTokens: available ? 7500 : null, savingsPercent: available ? 75 : null, commandCount: available ? 12 : null, scope: "agentdeck", source: "rtk gain --format json", estimationMethod: "bytes/4", claudeHookAvailable: available };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "popup" }, currentWebview: { label: "popup" } },
      transformCallback: (callback: Function) => { callbacks.set(++nextId, callback); return nextId; },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        w.__economyCalls.push({ command, args });
        if (command === "get_multi_agent_enabled") return w.__multiAgentEnabled;
        if (command === "get_multi_agent_status") {
          const model = args.model || "default";
          const labels: Record<string, string> = { default: "Padrão do chat", "gpt-alternative-fixture": "Alternativa escolhida", sonnet: "Sonnet", opus: "Opus" };
          const coordinator = { model, label: labels[model] || model, ...(args.effort ? { effort: args.effort } : {}) };
          return {
          enabled: w.__multiAgentEnabled, available: w.__multiAgentAvailable,
          reason: w.__multiAgentAvailable ? null : "models_unavailable",
          profile: !w.__multiAgentAvailable ? null : args.runnerType === "claude-code" ? {
            coordinator, explorer: { model: "claude-haiku-fixture", label: "Haiku" }, advisor: { model: "claude-opus-fixture", label: "Opus" }, advisorMode: model === "sonnet" ? "native" : "subagent",
          } : { coordinator, explorer: { model: "gpt-luna-fixture", label: "Luna", effort: "low" }, advisor: { model: "gpt-astra-fixture", label: "Astra", effort: "high" }, advisorMode: "subagent" },
          };
        }
        if (command === "list_agent_models") return args.runnerType === "claude-code" ? [
          { id: "sonnet", label: "Sonnet", resolvedModel: "claude-sonnet-fixture", reasoningEfforts: ["low", "medium", "high"], fastMode: true },
        ] : [
          { id: "default", label: "Padrão do chat", resolvedModel: "gpt-primary-fixture", reasoningEfforts: ["low", "medium", "high", "ultra"], fastMode: true },
          { id: "gpt-alternative-fixture", label: "Alternativa escolhida", resolvedModel: "gpt-alternative-fixture", reasoningEfforts: ["low", "medium", "high", "ultra"], fastMode: true },
        ];
        if (command === "set_multi_agent_enabled") {
          if (w.__multiAgentReject) throw new Error("Cannot save model distribution");
          w.__multiAgentEnabled = args.enabled;
          w.__economyEmit("multi-agent-economy-changed", { enabled: args.enabled });
          return args.enabled;
        }
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
        if (["recover_workspace_sessions", "backfill_workspace_session_bindings", "get_provider_usage"].includes(command) || command.startsWith("get_git_diff")) return [];
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
  if (openPanel) {
    await page.getByRole("button", { name: "Economia de tokens", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Economia de tokens" })).toBeVisible();
  }
}

test("the multi-model badge restores before opening Economy without querying the model catalogue", async ({ page }) => {
  await setupEconomy(page, false, false);
  const trigger = page.getByRole("button", { name: "Economia de tokens", exact: true });
  await expect(trigger.locator(".ad-multi-agent-badge")).toHaveText("Multimodelo");
  await expect(trigger).toHaveAttribute("aria-description", /modelo principal, esforço, Fast e Ultra são preservados/);
  await expect(page.getByRole("dialog", { name: "Economia de tokens" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__economyCalls.filter((call: any) => call.command === "get_multi_agent_status"))).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).__economyCalls.filter((call: any) => call.command === "get_multi_agent_enabled"))).toHaveLength(1);
  await page.evaluate(() => { const w = window as any; w.__multiAgentEnabled = false; w.__economyEmit("multi-agent-economy-changed", { enabled: false }); });
  await expect(trigger.locator(".ad-multi-agent-badge")).toHaveCount(0);
  await page.evaluate(() => { const w = window as any; w.__multiAgentEnabled = true; w.__economyEmit("multi-agent-economy-changed", { enabled: true }); });
  await expect(trigger.locator(".ad-multi-agent-badge")).toHaveText("Multimodelo");
  expect(await page.evaluate(() => (window as any).__economyCalls.filter((call: any) => call.command === "get_multi_agent_status"))).toHaveLength(0);
  await page.reload();
  await page.getByText("Economy session", { exact: true }).first().click();
  const open = page.getByTitle("Abrir conversa");
  if (await open.count()) await open.first().click();
  await expect(trigger.locator(".ad-multi-agent-badge")).toHaveText("Multimodelo");
  await expect(page.getByRole("dialog", { name: "Economia de tokens" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__economyCalls.filter((call: any) => call.command === "get_multi_agent_status"))).toHaveLength(0);
});

test("token economy separates measured RTK estimates from CLI usage and persists the shared toggle", async ({ page }) => {
  await setupEconomy(page);
  const panel = page.getByRole("dialog", { name: "Economia de tokens" });
  const integrations = panel.getByLabel("Integrações RTK");
  await expect(integrations.getByText("Claude Code", { exact: true })).toBeVisible();
  await expect(integrations.getByText("Codex", { exact: true })).toBeVisible();
  await expect(integrations).toContainText("/hooks");
  await expect(integrations).not.toContainText("Adaptador Codex disponível");
  await page.evaluate(() => { (window as any).__economyStatus.codexHookAvailable = true; });
  await panel.getByRole("button", { name: "Atualizar economia de tokens", exact: true }).click();
  await expect(integrations).toContainText("Adaptador Codex disponível");
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

test("model distribution works without RTK and saves its own global toggle without inventing savings", async ({ page }) => {
  await setupEconomy(page, false);
  const panel = page.getByRole("dialog", { name: "Economia de tokens" });
  const section = panel.getByRole("region", { name: "Distribuição de modelos" });
  const toggle = section.getByRole("switch", { name: "Distribuir tarefas entre modelos" });
  await expect(toggle).toBeEnabled(); await expect(toggle).toBeChecked();
  for (const label of ["Padrão do chat", "Luna", "Astra"]) await expect(section.getByText(label, { exact: true })).toBeVisible();
  await expect(section).toContainText("esforço baixo");
  await expect(section).toContainText("esforço alto");
  await expect(section).toContainText("ainda sem estimativa");
  await expect(section).toContainText("Fast e Ultra escolhidos no chat são preservados");
  await expect(section).not.toContainText("%");
  await page.screenshot({ path: ".local/validation/multi-agent-economy.png" });
  await toggle.click(); await expect(toggle).not.toBeChecked();
  await expect(panel.getByRole("switch", { name: "Economia em todas as conversas" })).toBeChecked();
  expect(await page.evaluate(() => (window as any).__economyCalls.filter((call: any) => call.command === "set_token_economy_enabled"))).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).__economyCalls.some((call: any) => call.command === "set_multi_agent_enabled" && call.args.enabled === false))).toBe(true);
  await page.evaluate(() => { (window as any).__multiAgentReject = true; });
  await toggle.click();
  await expect(section.getByRole("alert")).toContainText("A configuração anterior foi mantida");
  await expect(toggle).not.toBeChecked();
});

test("RTK and model distribution remain independent in all four combinations", async ({ page }) => {
  await setupEconomy(page);
  const panel = page.getByRole("dialog", { name: "Economia de tokens" });
  const rtk = panel.getByRole("switch", { name: "Economia em todas as conversas" });
  const multi = panel.getByRole("switch", { name: "Distribuir tarefas entre modelos" });
  const trigger = page.getByRole("button", { name: "Economia de tokens", exact: true });
  await expect(panel).toContainText("As duas opções são independentes e podem ficar ligadas juntas");
  await expect(rtk).toBeChecked();
  await expect(multi).toBeChecked();
  await rtk.click();
  await expect(rtk).not.toBeChecked();
  await expect(multi).toBeChecked();
  await expect(trigger.locator("small")).toHaveText("RTK Desligada");
  await expect(trigger).toHaveAttribute("data-enabled", "true");
  await multi.click();
  await expect(rtk).not.toBeChecked();
  await expect(multi).not.toBeChecked();
  await expect(trigger).toHaveAttribute("data-enabled", "false");
  await rtk.click();
  await expect(rtk).toBeChecked();
  await expect(multi).not.toBeChecked();
  await expect(trigger.locator("small")).toHaveText("RTK Ligada");
  await multi.click();
  await expect(rtk).toBeChecked();
  await expect(multi).toBeChecked();
  expect(await page.evaluate(() => (window as any).__economyCalls.filter((call: any) => ["set_token_economy_enabled", "set_multi_agent_enabled"].includes(call.command)).map((call: any) => [call.command, call.args.enabled]))).toEqual([
    ["set_token_economy_enabled", false], ["set_multi_agent_enabled", false],
    ["set_token_economy_enabled", true], ["set_multi_agent_enabled", true],
  ]);
});

test("an obsolete RTK query cannot revert a setting synchronized from another window", async ({ page }) => {
  await setupEconomy(page);
  const toggle = page.getByRole("switch", { name: "Economia em todas as conversas" });
  const enabled = await page.evaluate(async () => {
    const path = "/src/store/tokenEconomyStore.ts";
    const { useTokenEconomyStore } = await import(/* @vite-ignore */ path);
    const w = window as any, invoke = w.__TAURI_INTERNALS__.invoke;
    let release: (() => void) | undefined;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      const result = await invoke(command, args);
      if (command === "get_token_economy_status" && args.scope === "project") await new Promise<void>(resolve => { release = resolve; });
      return result;
    };
    const pending = useTokenEconomyStore.getState().refresh(true, "C:\\Delayed project", "project");
    await new Promise(resolve => setTimeout(resolve, 0));
    w.__economyEmit("token-economy-changed", { enabled: false });
    release!();
    await pending;
    return Object.values(useTokenEconomyStore.getState().entries).filter((entry: any) => entry.status).map((entry: any) => entry.status.enabled);
  });
  expect(enabled).toEqual([false]);
  await expect(toggle).not.toBeChecked();
});

test("economy preserves the selected main model, effort, Fast and Ultra in the actual chat request", async ({ page }) => {
  await setupEconomy(page);
  const section = page.getByRole("region", { name: "Distribuição de modelos" });
  await expect(section.getByRole("switch")).toBeChecked();
  await page.keyboard.press("Escape");
  const composer = page.locator(".ad-chat-composer");
  const model = composer.locator(".ad-model-field select");
  await expect(model).toBeEnabled();
  await model.selectOption("gpt-alternative-fixture");
  await composer.locator(".ad-effort-trigger").click();
  const effort = page.getByRole("dialog", { name: "Esforço e velocidade" });
  await expect(effort.getByRole("combobox", { name: "Esforço", exact: true })).toBeEnabled();
  await effort.getByRole("combobox", { name: "Esforço", exact: true }).selectOption("high");
  for (const name of ["Fast", "Ultra"]) {
    const toggle = effort.getByRole("switch", { name, exact: true });
    await expect(toggle).toBeEnabled();
    await toggle.click(); await expect(toggle).toBeChecked();
  }
  await effort.getByRole("button", { name: "Fechar opções de esforço" }).click();
  await page.getByRole("button", { name: "Economia de tokens", exact: true }).click();
  await expect(section.getByRole("switch")).toBeChecked();
  const main = section.locator("dl > div").first();
  await expect(main).toContainText("Principal (sua seleção)");
  await expect(main).toContainText("Alternativa escolhida");
  await expect(main).toContainText("esforço alto");
  await expect(section).toContainText("Fast e Ultra escolhidos no chat são preservados");
  const queries = await page.evaluate(async () => {
    // A different effort for the same CLI/model must have a separate profile
    // cache; it must not replace the profile currently displayed by the chat.
    const path = "/src/store/multiAgentEconomyStore.ts";
    await (await import(/* @vite-ignore */ path)).useMultiAgentEconomyStore.getState().refresh({ runnerType: "codex", workdir: "C:\\Project", model: "gpt-alternative-fixture", effort: "low" });
    return (window as any).__economyCalls.filter((call: any) => call.command === "get_multi_agent_status").map((call: any) => call.args);
  });
  expect(queries.some((args: any) => args.model === "gpt-alternative-fixture" && args.effort === "high")).toBe(true);
  expect(queries.some((args: any) => args.model === "gpt-alternative-fixture" && args.effort === "low")).toBe(true);
  await expect(main).toContainText("esforço alto");
  await page.screenshot({ path: ".local/validation/economy-main-selection.png" });
  await page.keyboard.press("Escape");
  await composer.locator("textarea").fill("Preserve my chosen main model and execution settings");
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__economyCalls.filter((call: any) => call.command === "start_chat_turn").length)).toBe(1);
  const request = await page.evaluate(() => (window as any).__economyCalls.find((call: any) => call.command === "start_chat_turn").args.request);
  expect(request).toMatchObject({ runnerType: "codex", model: "gpt-alternative-fixture", effort: "high", fastMode: true, ultraMode: true });
  expect(await page.evaluate(() => (window as any).__multiAgentEnabled)).toBe(true);
});

test("model distribution resolves the session CLI, keeps provider caches separate and synchronizes the global setting", async ({ page }) => {
  await setupEconomy(page);
  const section = page.getByRole("region", { name: "Distribuição de modelos" });
  await expect(section.getByText("Padrão do chat", { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/store/sessionStore.ts";
    (await import(/* @vite-ignore */ path)).useSessionStore.getState().updateSession("economy", { runner: { type: "claude-code", cliPath: "C:\\Tools\\custom-claude.exe", model: "sonnet", effort: "medium" } });
  });
  for (const label of ["Sonnet", "Haiku", "Opus"]) await expect(section.getByText(label, { exact: true })).toBeVisible();
  await expect(section).not.toContainText("Sol");
  await expect(section).toContainText("Assessoria nativa");
  await expect(section).toContainText("tokens adicionais");
  expect(await page.evaluate(() => (window as any).__economyCalls.some((call: any) => call.command === "get_multi_agent_status" && call.args.runnerType === "claude-code" && call.args.cliPath === "C:\\Tools\\custom-claude.exe" && call.args.workdir === "C:\\Project" && call.args.model === "sonnet" && call.args.effort === "medium"))).toBe(true);
  await section.getByRole("switch").click();
  await expect(section.getByRole("switch")).not.toBeChecked();
  expect(await page.evaluate(async () => { const path = "/src/store/multiAgentEconomyStore.ts"; return Object.values((await import(/* @vite-ignore */ path)).useMultiAgentEconomyStore.getState().entries).map((entry: any) => entry.status?.enabled); })).toEqual([false, false]);
  await page.evaluate(() => {
    const w = window as any; w.__multiAgentEnabled = true; w.__economyEmit("multi-agent-economy-changed", { enabled: true });
  });
  await expect(section.getByRole("switch")).toBeChecked();
  expect(await page.evaluate(async () => { const path = "/src/store/multiAgentEconomyStore.ts"; return Object.values((await import(/* @vite-ignore */ path)).useMultiAgentEconomyStore.getState().entries).map((entry: any) => entry.status?.enabled); })).toEqual([true, true]);
  await page.evaluate(() => { (window as any).__multiAgentAvailable = false; });
  await section.getByRole("button", { name: "Reconsultar modelos dos agentes" }).click();
  await expect(section).toContainText("Os modelos necessários não estão disponíveis neste CLI");
  await expect(section.getByText("Sonnet", { exact: true })).toHaveCount(0);
  await expect(section.getByRole("switch")).toBeEnabled();
});

test("an obsolete model query cannot restore the global switch after it is saved", async ({ page }) => {
  await setupEconomy(page);
  await expect(page.getByRole("region", { name: "Distribuição de modelos" }).getByText("Padrão do chat", { exact: true })).toBeVisible();
  const result = await page.evaluate(async () => {
    const path = "/src/store/multiAgentEconomyStore.ts";
    const { useMultiAgentEconomyStore } = await import(/* @vite-ignore */ path);
    const w = window as any, invoke = w.__TAURI_INTERNALS__.invoke;
    let release: (() => void) | undefined, releaseEnabled: (() => void) | undefined;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      const result = await invoke(command, args);
      if (command === "get_multi_agent_status" && args.workdir === "C:\\Delayed project") await new Promise<void>(resolve => { release = resolve; });
      if (command === "get_multi_agent_enabled") await new Promise<void>(resolve => { releaseEnabled = resolve; });
      return result;
    };
    useMultiAgentEconomyStore.setState({ enabledCheckedAt: null });
    const oldQuery = useMultiAgentEconomyStore.getState().refresh({ runnerType: "codex", cliPath: "C:\\Tools\\other-codex.exe", workdir: "C:\\Delayed project" }, true);
    const oldFlag = useMultiAgentEconomyStore.getState().loadEnabled();
    await new Promise(resolve => setTimeout(resolve, 0));
    await useMultiAgentEconomyStore.getState().setEnabled(false);
    release!(); releaseEnabled!(); await Promise.all([oldQuery, oldFlag]);
    const state = useMultiAgentEconomyStore.getState();
    return { enabled: state.enabled, cachedSettings: Object.values(state.entries).filter((entry: any) => entry.status).map((entry: any) => entry.status.enabled) };
  });
  expect(result).toEqual({ enabled: false, cachedSettings: [false] });
  await expect(page.getByRole("region", { name: "Distribuição de modelos" }).getByRole("switch")).not.toBeChecked();
});

test("conversation usage accumulates provider reports once and persists without inventing historical usage", async ({ page }) => {
  await setupEconomy(page);
  const measured = await page.evaluate(async () => {
    const modulePath = "/src/store/chatStore.ts";
    const { useChatStore, chatHistoryReady, persistChatHistory } = await import(/* @vite-ignore */ modulePath);
    await chatHistoryReady;
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
    await persistChatHistory();
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
