import { expect, test, type Page } from "@playwright/test";

async function setupNavigation(page: Page, locale = "pt-BR") {
  await page.addInitScript(({ locale }) => {
    const w = window as any;
    let id = 0;
    w.__navigationCalls = [];
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "popup" }, currentWebview: { label: "popup" } },
      transformCallback: () => ++id, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        w.__navigationCalls.push({ command, args });
        if (command === "plugin:event|listen") return ++id;
        if (command === "plugin:window|is_maximized") return false;
        if (command === "plugin:window|scale_factor") return 1;
        if (command === "plugin:window|outer_size") return { width: 1360, height: 900 };
        if (command === "plugin:window|outer_position") return { x: 0, y: 0 };
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
    const workspaces = [
      { id: "alpha", name: "Alpha project", path: "C:\\Projects\\Alpha", color: "green", createdAt: 1, order: 0 },
      { id: "beta", name: "Beta project", path: "C:\\Projects\\Beta", color: "green", createdAt: 2, order: 1 },
      { id: "archive", name: "Empty archive", path: "C:\\Archive", color: "green", createdAt: 3, order: 2 },
    ];
    const session = (id: string, name: string, workspaceId: string, type: string, createdAt: number) => ({ id, name, workspaceId, workdir: workspaces.find(workspace => workspace.id === workspaceId)!.path, status: "idle", currentTask: "", createdAt, diffFiles: [], output: [], runner: { type } });
    localStorage.setItem("agentdeck-settings", JSON.stringify({ state: { settings: { locale, theme: "dark", splitWidgetPanelCollapsed: true, runner: { type: "codex" } } }, version: 0 }));
    localStorage.setItem("agentdeck-workspaces", JSON.stringify({ state: { workspaces, activeWorkspaceId: "alpha" }, version: 0 }));
    localStorage.setItem("agentdeck-sessions", JSON.stringify({ state: { sessions: [session("alpha-review", "Alpha review", "alpha", "codex", 1), session("beta-review", "Revisão de permissões", "beta", "claude-code", 2), session("beta-tests", "Browser tests", "beta", "gemini", 3)], activeSessionId: "alpha-review" }, version: 0 }));
  }, { locale });
  await page.goto("/");
  await expect(page.locator(".ad-quick-switch-trigger")).toBeVisible();
}

async function openQuickSwitch(page: Page) {
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Navegação rápida", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox")).toBeFocused();
  return dialog;
}

test("keyboard search navigates real sessions across projects without launching an agent", async ({ page }) => {
  await setupNavigation(page);
  let dialog = await openQuickSwitch(page);
  await dialog.getByRole("combobox").fill("revisao permissoes");
  const result = dialog.getByRole("option").filter({ hasText: "Revisão de permissões" });
  await expect(result).toHaveAttribute("aria-selected", "true");
  await expect(result).toContainText("Claude");
  await dialog.getByRole("combobox").fill("rvs prms");
  await expect(result).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: "test-results/quick-navigation.png", animations: "disabled" });
  await page.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".ad-project-name")).toHaveText("Beta project");
  await expect(page.locator(".ad-session-tabs:visible > span")).toContainText("Revisão de permissões");
  await expect(page.locator(".ad-chat-composer textarea:visible")).toBeVisible();
  dialog = await openQuickSwitch(page);
  await dialog.getByRole("combobox").fill("Browser tests");
  await page.keyboard.press("Enter");
  await expect(page.locator(".ad-session-tabs:visible > span")).toContainText("Browser tests");
  dialog = await openQuickSwitch(page);
  await dialog.getByRole("combobox").fill("C:\\Archive");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.locator(".ad-project-name")).toHaveText("Empty archive");
  const state = await page.evaluate(() => ({ sessions: JSON.parse(localStorage.getItem("agentdeck-sessions")!).state.sessions, calls: (window as any).__navigationCalls }));
  expect(state.sessions).toHaveLength(3);
  expect(state.calls.filter((call: any) => ["start_chat_turn", "start_pty_session", "reserve_session_id", "pick_folder", "create_worktree"].includes(call.command))).toEqual([]);
});

test("arrows, no results, clear and Escape preserve the existing draft and focus", async ({ page }) => {
  await setupNavigation(page);
  await page.getByText("Alpha review", { exact: true }).first().click();
  const draft = page.locator(".ad-chat-composer textarea:visible");
  await draft.fill("Keep this unsent draft.");
  const dialog = await openQuickSwitch(page);
  const search = dialog.getByRole("combobox");
  await search.fill("zzzzzzzz-not-a-real-project");
  await expect(dialog.getByText("Nenhum resultado encontrado", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("option")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Limpar busca", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(search).toBeFocused();
  await dialog.getByRole("button", { name: "Limpar busca", exact: true }).click();
  await expect(search).toBeFocused();
  const first = await search.getAttribute("aria-activedescendant");
  await page.keyboard.press("ArrowDown");
  await expect(search).not.toHaveAttribute("aria-activedescendant", first!);
  await page.keyboard.press("ArrowUp");
  await expect(search).toHaveAttribute("aria-activedescendant", first!);
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Fechar navegação" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(search).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Fechar navegação" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("Keep this unsent draft.");
});

test("existing actions navigate knowledge, settings and agents without nested palettes", async ({ page }) => {
  await setupNavigation(page);
  let dialog = await openQuickSwitch(page);
  await dialog.getByRole("combobox").fill("Conhecimento");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "Memória compartilhada", exact: true })).toBeVisible();
  dialog = await openQuickSwitch(page);
  await dialog.getByRole("combobox").fill("Configuracoes");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Aparência", exact: true })).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(dialog).not.toBeVisible();
  await page.keyboard.press("Escape");
  dialog = await openQuickSwitch(page);
  await dialog.getByRole("combobox").fill("Agentes");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Central de agentes", exact: true })).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(dialog).not.toBeVisible();
});

test("native terminal and other modal shortcuts remain untouched; reduced motion is respected", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setupNavigation(page);
  await page.evaluate(() => {
    const terminal = document.createElement("div"); terminal.className = "xterm"; terminal.id = "terminal-keyboard-fixture";
    const input = document.createElement("textarea"); terminal.append(input); document.body.append(terminal); input.focus();
    input.addEventListener("keydown", event => { if (event.key.toLowerCase() === "k") (window as any).__terminalKeyPrevented = event.defaultPrevented; });
  });
  await page.keyboard.press("Control+k");
  await expect(page.locator(".ad-quick-switch")).not.toBeVisible();
  expect(await page.evaluate(() => (window as any).__terminalKeyPrevented)).toBe(false);
  await page.evaluate(() => {
    document.getElementById("terminal-keyboard-fixture")!.remove();
    const modal = document.createElement("dialog"); modal.id = "other-modal-fixture";
    const input = document.createElement("input"); modal.append(input); document.body.append(modal); modal.showModal(); input.focus();
  });
  await page.keyboard.press("Control+k");
  await expect(page.locator(".ad-quick-switch")).not.toBeVisible();
  await expect(page.locator("#other-modal-fixture input")).toBeFocused();
  await page.evaluate(() => { const modal = document.getElementById("other-modal-fixture") as HTMLDialogElement; modal.close(); modal.remove(); });
  await page.locator(".ad-quick-switch-trigger").click();
  await expect(page.getByRole("dialog", { name: "Navegação rápida" })).toBeVisible();
  expect(await page.locator(".ad-quick-switch").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  await page.keyboard.press("Escape");
  await expect(page.locator(".ad-quick-switch-trigger")).toBeFocused();
});

for (const [locale, title, placeholder, empty] of [
  ["en-US", "Quick navigation", "Search conversations, projects or actions", "No matching results"],
  ["es-ES", "Navegación rápida", "Buscar conversaciones, proyectos o acciones", "No se encontraron resultados"],
]) {
  test(`quick navigation labels and empty state are available in ${locale}`, async ({ page }) => {
    await setupNavigation(page, locale);
    await page.locator(".ad-quick-switch-trigger").click();
    const dialog = page.getByRole("dialog", { name: title, exact: true });
    await dialog.getByRole("combobox", { name: placeholder, exact: true }).fill("zzzzzzzz-nonexistent");
    await expect(dialog.getByText(empty, { exact: true })).toBeVisible();
  });
}
