import { expect, test, type Page } from "@playwright/test";

test("many agents and malformed parent cycles stay searchable in a small light window", async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 740 });
  await setupMonitor(page);
  await page.evaluate(async () => {
    const w = window as any;
    const root = { id: "native-main", sessionId: "main", parentId: null, name: "Main", provider: "codex", task: "Coordinate work", status: "running", lastMessage: "", events: [], truncated: false };
    w.__agents = [root, ...Array.from({ length: 36 }, (_, index) => ({ ...root, id: `agent-${index}`, name: `Agent ${index}`, parentId: index === 0 ? "agent-1" : index === 1 ? "agent-0" : "native-main", task: `Workstream ${index}`, status: "done" }))];
    const modulePath = "/src/store/settingsStore.ts";
    const { useSettingsStore } = await import(/* @vite-ignore */ modulePath);
    useSettingsStore.getState().patchSettings({ theme: "light" });
  });
  const monitor = page.getByRole("dialog", { name: "Central de agentes" });
  await monitor.getByRole("button", { name: "Atualizar atividades", exact: true }).click();
  await expect(monitor.locator(".ad-flow-node")).toHaveCount(38);
  await monitor.getByRole("searchbox").fill("Workstream 35");
  await expect(monitor.locator(".ad-flow-node")).toHaveCount(2);
  await monitor.getByRole("button", { name: "Agent 35 · Concluído", exact: true }).click();
  await expect(monitor.getByRole("heading", { name: "Agent 35", exact: true })).toBeVisible();
  await monitor.getByRole("searchbox").fill("Workstream 0");
  await expect(monitor.locator(".ad-flow-node")).toHaveCount(2);
  await monitor.getByRole("button", { name: "Agent 0 · Concluído", exact: true }).click();
  await expect(monitor.getByRole("heading", { name: "Agent 0", exact: true })).toBeVisible();
  await expect(monitor.locator(".ad-monitor-detail")).toHaveCSS("transform", "none");
  expect(await monitor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "test-results/agent-flow-light.png", animations: "disabled" });
});

test("flow map and task board share selection, session filters and accessible zoom", async ({ page }) => {
  await setupMonitor(page);
  const monitor = page.getByRole("dialog", { name: "Central de agentes" });
  const map = monitor.getByRole("region", { name: "Mapa de fluxos", exact: true });
  await expect(map.locator(".ad-flow-node")).toHaveCount(4);
  await map.getByRole("button", { name: "Ada · Concluído", exact: true }).click();
  await expect(monitor.getByRole("heading", { name: "Ada", exact: true })).toBeVisible();
  await map.getByRole("button", { name: "Pausar animações", exact: true }).click();
  await expect(map).toHaveAttribute("data-paused", "true");
  await map.getByRole("button", { name: "Retomar animações", exact: true }).click();
  await map.getByRole("combobox", { name: "Sessões", exact: true }).selectOption("main");
  await expect(map.locator(".ad-flow-node")).toHaveCount(3);
  const before = await map.locator("output").textContent();
  await map.getByRole("button", { name: "Ampliar", exact: true }).click(); await expect(map.locator("output")).not.toHaveText(before!);
  await map.getByRole("button", { name: "Ajustar à tela", exact: true }).click();
  await map.getByRole("button", { name: "Centralizar agente selecionado", exact: true }).click();
  await expect(map.locator("output")).toHaveText("100%");
  await map.getByRole("button", { name: "Ajustar à tela", exact: true }).click();
  await monitor.getByRole("button", { name: "Quadro de tarefas", exact: true }).click();
  await expect(monitor.locator('.ad-task-column[data-column="completed"] .ad-board-task')).toHaveCount(2);
  await monitor.locator(".ad-board-task").filter({ hasText: "Linus" }).click();
  await expect(monitor.getByRole("heading", { name: "Linus", exact: true })).toBeVisible();
  await monitor.getByRole("button", { name: "Mapa de fluxos", exact: true }).click();
  await monitor.screenshot({ path: "test-results/agent-flow-map.png", animations: "disabled" });
});

test("active delegation animates only during a running session and honors reduced motion", async ({ page }) => {
  await setupMonitor(page);
  await page.evaluate(async () => {
    (window as any).__running = true;
    const modulePath = "/src/store/sessionStore.ts";
    const { useSessionStore } = await import(/* @vite-ignore */ modulePath);
    useSessionStore.setState((state: any) => ({ sessions: state.sessions.map((session: any) => session.id === "main" ? { ...session, status: "running" } : session) }));
  });
  const monitor = page.getByRole("dialog", { name: "Central de agentes" });
  await monitor.getByRole("button", { name: "Atualizar atividades", exact: true }).click();
  const signal = monitor.locator('.ad-flow-connectors g[data-active="true"] .ad-flow-signal[d*=" C "]').first();
  await expect(signal).toHaveCSS("display", "block");
  await expect(signal).toHaveCSS("animation-name", "ad-flow-travel");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(signal).toHaveCSS("animation-name", "none");
});

async function setupMonitor(page: Page, unavailable = false) {
  await page.addInitScript(({ unavailable }) => {
    const w = window as any;
    const callbacks = new Map<number, Function>();
    const listeners = new Map<string, Map<number, number>>();
    let nextId = 0;
    w.__agentCalls = [];
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    const agent = (id: string, name: string, parentId: string | null, status: string, task: string) => ({
      id, sessionId: "main", parentId, name, role: parentId ? "reviewer" : null,
      provider: "codex", task, lastMessage: "Review complete. No regressions found.", status: w.__running && id !== "child-b" ? "running" : status,
      updatedAt: Date.now(), model: "codex-local", truncated: false,
      events: [{ id: `${id}-tool`, kind: "tool", title: "exec_command", detail: "cargo test --lib", status: "completed", timestamp: new Date().toISOString() }],
    });
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "popup" }, currentWebview: { label: "popup" } },
      transformCallback: (callback: Function) => { callbacks.set(++nextId, callback); return nextId; },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        w.__agentCalls.push({ command, args });
        if (command === "plugin:event|listen") { if (!listeners.has(args.event)) listeners.set(args.event, new Map()); listeners.get(args.event)!.set(++nextId, args.handler); return nextId; }
        if (command === "plugin:event|unlisten") { listeners.get(args.event)?.delete(args.eventId); return; }
        if (command === "observe_agent_sessions") return args.sessions.map((session: any) => ({ sessionId: session.sessionId, available: !unavailable && session.sessionId === "main", reason: unavailable ? "not_found" : null, agents: unavailable || session.sessionId !== "main" ? [] : w.__agents ?? [agent("native-main", "Main agent", null, "done", "Improve the workspace"), agent("child-a", "Ada", "native-main", "done", "Review authentication boundaries"), agent("child-b", "Linus", "child-a", "done", "Run regression tests")] }));
        if (command === "plugin:window|is_maximized") return false;
        if (command === "plugin:window|scale_factor") return 1;
        if (command === "plugin:window|outer_size") return { width: 1360, height: 900 };
        if (command === "plugin:window|outer_position") return { x: 0, y: 0 };
        if (command === "get_git_status") return { staged: [], unstaged: [], untracked: [], conflicts: [], committed: [] };
        if (command === "check_cli") return true;
        if (["recover_workspace_sessions", "backfill_workspace_session_bindings", "list_agent_models"].includes(command) || command.startsWith("get_git_diff")) return [];
        if (command === "load_ui_states" || command === "load_deleted_ui_state") return {};
        return null;
      },
    };
    localStorage.setItem("agentdeck-settings", JSON.stringify({ state: { settings: { locale: "pt-BR", theme: "dark", splitWidgetPanelCollapsed: true, runner: { type: "codex" } } }, version: 0 }));
    localStorage.setItem("agentdeck-workspaces", JSON.stringify({ state: { workspaces: [{ id: "workspace", name: "Agentdeck", path: "C:\\Project", color: "green", createdAt: 1, order: 0 }], activeWorkspaceId: "workspace" }, version: 0 }));
    localStorage.setItem("agentdeck-sessions", JSON.stringify({ state: { sessions: [{ id: "main", providerSessionId: "native-main", name: "Workspace review", workspaceId: "workspace", workdir: "C:\\Project", status: "idle", currentTask: "Improve the workspace", createdAt: 1, diffFiles: [], output: [], runner: { type: "codex" } }, { id: "claude", name: "Claude session", workspaceId: "workspace", workdir: "C:\\Project", status: "idle", currentTask: "", createdAt: 2, diffFiles: [], output: [], runner: { type: "claude-code" } }], activeSessionId: "main" }, version: 0 }));
  }, { unavailable });
  await page.goto("/");
  await page.getByRole("button", { name: "Agentes", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Central de agentes" })).toBeVisible();
}

test("agent monitor shows native hierarchy, tool evidence, filters and session navigation", async ({ page }) => {
  await setupMonitor(page);
  const monitor = page.getByRole("dialog", { name: "Central de agentes" });
  await monitor.getByRole("button", { name: "Lista", exact: true }).click();
  const tree = monitor.getByRole("navigation", { name: "Central de agentes" });
  await expect(tree.getByText("Ada", { exact: true })).toBeVisible();
  await expect(tree.locator(".ad-monitor-branch .ad-monitor-branch").getByText("Linus", { exact: true })).toBeVisible();
  await tree.getByRole("button").filter({ hasText: "Ada" }).first().click();
  await expect(monitor.getByRole("heading", { name: "Ada", exact: true })).toBeVisible();
  await expect(monitor.getByText("Review authentication boundaries", { exact: true }).last()).toBeVisible();
  await expect(monitor.getByText("Último estado registrado no histórico nativo.")).toBeVisible();
  await monitor.locator("summary").filter({ hasText: "cargo test" }).click();
  await expect(monitor.locator("pre")).toHaveText("cargo test --lib");
  await monitor.getByRole("searchbox").fill("regression");
  await expect(tree.getByText("Linus", { exact: true })).toBeVisible();
  await expect(tree.getByText("Ada", { exact: true })).toBeVisible();
  await expect(tree.getByText("Claude session", { exact: true })).toHaveCount(0);
  await monitor.getByRole("searchbox").fill("");
  await monitor.getByRole("combobox", { name: "Todas as IAs" }).selectOption("claude-code");
  await expect(tree.getByText("Claude session", { exact: true })).toBeVisible();
  await expect(tree.getByText("Ada", { exact: true })).toHaveCount(0);
  await expect(monitor.getByText("Aguardando o ID da sessão nativa para descobrir subagentes.")).toBeVisible();
  await monitor.getByRole("combobox", { name: "Todas as IAs" }).selectOption("all");
  await tree.getByRole("button").filter({ hasText: "Linus" }).click();
  await page.screenshot({ path: "test-results/agent-observatory.png" });
  await monitor.getByRole("button", { name: "Abrir conversa", exact: true }).click();
  await expect(monitor).toHaveCount(0);
  const observed = await page.evaluate(() => (window as any).__agentCalls.find((call: any) => call.command === "observe_agent_sessions"));
  expect(observed.args.sessions[0]).toMatchObject({ sessionId: "main", providerSessionId: "native-main", provider: "codex" });
});

test("missing provider telemetry stays explicit and the monitor closes with keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 740 });
  await setupMonitor(page, true);
  const monitor = page.getByRole("dialog", { name: "Central de agentes" });
  await expect(monitor.getByText("O provedor ainda não disponibilizou um histórico local desta sessão.")).toBeVisible();
  await monitor.getByRole("button", { name: "Lista", exact: true }).click();
  await expect(monitor.getByRole("navigation").locator(".ad-monitor-branch")).toHaveCount(0);
  await monitor.getByRole("searchbox").fill("does not exist");
  await expect(monitor.getByRole("heading", { name: "Nenhum agente corresponde aos filtros." })).toBeVisible();
  await monitor.getByRole("button", { name: "Limpar filtros", exact: true }).click();
  await expect(monitor.getByRole("heading", { name: "Workspace review", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(monitor).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Agentes", exact: true })).toBeFocused();
});
