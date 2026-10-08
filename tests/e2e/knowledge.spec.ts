import { expect, test, type Page } from "@playwright/test";

test("expanded graph explores a large vault, filters any indexed note and restores focus", async ({ page }) => {
  const docs = await setupDocuments(page);
  await page.evaluate(() => {
    const nodes = Array.from({ length: 1600 }, (_, i) => ({ path: `folder-${i % 8}/note-${i}.md`, title: `Note ${i}`, links: 2 }));
    const edges = nodes.map((node, i) => ({ source: node.path, target: nodes[(i + 1) % nodes.length].path }));
    (window as any).__graph = { nodes, edges, noteCount: nodes.length, linkCount: edges.length, truncated: false, indexLimited: false };
  });
  await docs.getByRole("button", { name: "Escolher pasta Markdown ou vault", exact: true }).click();
  const expand = docs.getByRole("button", { name: "Expandir grafo", exact: true });
  await expand.click();
  const dialog = page.getByRole("dialog", { name: "Grafo de notas", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".ad-knowledge-folder")).toHaveCount(8);
  await dialog.getByRole("button", { name: "folder-7 · 200 notas", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "Filtrar por pasta" })).toHaveValue("folder-7");
  await expect(dialog.locator(".ad-note-graph-node")).toHaveCount(200);
  await dialog.getByRole("combobox", { name: "Filtrar por pasta" }).selectOption("*");
  await expect(dialog.locator(".ad-note-graph-node")).toHaveCount(350);
  await dialog.getByRole("searchbox", { name: "Buscar nota no grafo" }).fill("Note 1599");
  const isolated = dialog.getByRole("button", { name: "Note 1599 · 2 ligações", exact: true });
  await expect(isolated).toBeVisible(); await isolated.focus(); await page.keyboard.press("Enter");
  await expect(dialog.getByLabel("Trecho da nota")).toContainText("note-1599.md");
  await dialog.locator(".ad-knowledge-inspector").getByRole("button", { name: "Conexões", exact: true }).click();
  await expect(dialog.locator(".ad-note-graph-node")).toHaveCount(3);
  await dialog.getByRole("combobox", { name: "Profundidade das conexões" }).selectOption("2");
  await expect(dialog.locator(".ad-note-graph-node")).toHaveCount(5);
  const zoom = dialog.locator("output"); const before = await zoom.textContent();
  await dialog.getByRole("button", { name: "Ampliar", exact: true }).click(); await expect(zoom).not.toHaveText(before!);
  await dialog.getByRole("button", { name: "Ajustar à tela", exact: true }).click();
  const fitted = await zoom.textContent();
  await dialog.locator(".ad-graph-viewport").evaluate(element => {
    const box = element.getBoundingClientRect();
    const event = new WheelEvent("wheel", { ctrlKey: true, deltaY: -100, clientX: box.left + 150, clientY: box.top + 150, cancelable: true });
    element.dispatchEvent(event);
    if (!event.defaultPrevented) throw new Error("Graph zoom must prevent browser zoom.");
  });
  await expect(zoom).not.toHaveText(fitted!);
  await dialog.getByRole("button", { name: "Pastas", exact: true }).click();
  await dialog.screenshot({ path: "test-results/knowledge-expanded.png", animations: "disabled" });
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(expand).toBeFocused();
  const calls = await page.evaluate(() => (window as any).__documentCalls);
  expect(calls.some((call: any) => call.command === "start_chat_turn")).toBe(false);
});

async function setupDocuments(page: Page) {
  await page.addInitScript(() => {
    const w = window as any; let nextId = 0;
    w.__documentCalls = []; w.__source = ""; w.__cancelPick = false; w.__searchFailure = false; w.__sourceFailure = false; w.__holdSearch = false;
    w.__sources = {};
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "popup" }, currentWebview: { label: "popup" } }, transformCallback: () => ++nextId, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        w.__documentCalls.push({ command, args });
        const sourceKey = args.projectPath ?? "global";
        const configuration = () => ({ sourcePath: w.__sources[sourceKey] ?? "", mode: w.__sources[sourceKey] ? "markdown" : "none", scope: args.projectPath ? "project" : "global", projectPath: args.projectPath, storagePath: "C:\\AppData\\Agentdeck\\knowledge.json" });
        if (command === "get_knowledge_config") return configuration();
        if (command === "get_knowledge_health") {
          if (w.__healthFailure) throw new Error("QA health check unavailable");
          const sourcePath = w.__sources[sourceKey] ?? "";
          return { sourcePath, status: sourcePath ? (w.__healthStatus ?? "ready") : "none", noteCount: sourcePath ? (w.__healthNoteCount ?? 2) : 0, checkedAt: Date.now(), maxNotes: 3000, maxIndexBytes: 16 * 1024 * 1024, maxNoteBytes: 256 * 1024, message: w.__healthMessage ?? "" };
        }
        if (command === "pick_folder") return w.__cancelPick ? null : "C:\\Notes";
        if (command === "set_knowledge_source") { if (w.__sourceFailure) throw new Error("Source unavailable"); w.__sources[sourceKey] = args.sourcePath; return configuration(); }
        if (command === "get_knowledge_graph") return w.__graph ?? { nodes: [{ path: "decisions.md", title: "Project decisions", links: 1 }, { path: "architecture.md", title: "Architecture", links: 1 }], edges: [{ source: "decisions.md", target: "architecture.md" }], noteCount: 2, linkCount: 1, truncated: false, indexLimited: false };
        if (command === "read_knowledge_note") return { path: args.path, title: args.path === "decisions.md" ? "Project decisions" : "Architecture", excerpt: `Preview from ${sourceKey}: ${args.path}`, score: 0 };
        if (command === "search_knowledge") {
          if (w.__holdSearch) await new Promise<void>(resolve => { w.__releaseSearch = resolve; });
          if (w.__searchFailure) throw new Error("Search temporarily unavailable");
          return args.query === "none" ? [] : [{ path: "decisions.md", title: "Project decisions", excerpt: "Decisions use typed results and project scope.", score: 1 }];
        }
        if (command === "memory_status") return { enabled: true, captureEnabled: true, budgetTokens: 800, recordCount: 0, projectKey: args.projectPath, storage: "local", retrieval: "fts5", estimatedTokenMethod: "bytes/4" };
        if (command === "get_git_status") return { staged: [], unstaged: [], untracked: [], conflicts: [], committed: [] };
        if (command === "plugin:window|outer_size") return { width: 1360, height: 900 };
        if (command === "plugin:window|outer_position") return { x: 0, y: 0 };
        if (command === "plugin:window|scale_factor") return 1;
        if (command === "check_cli") return true;
        if (command === "plugin:event|listen") return ++nextId;
        if (["get_provider_usage", "memory_list", "recover_workspace_sessions", "backfill_workspace_session_bindings", "list_agent_models"].includes(command) || command.startsWith("get_git_diff")) return [];
        if (command === "load_ui_states" || command === "load_deleted_ui_state") return {};
        return null;
      },
    };
    localStorage.setItem("agentdeck-settings", JSON.stringify({ state: { settings: { locale: "pt-BR", theme: "dark", splitWidgetPanelCollapsed: true, splitPaneSidebarWidth: 380, runner: { type: "codex" } } }, version: 0 }));
    localStorage.setItem("agentdeck-workspaces", JSON.stringify({ state: { workspaces: [{ id: "alpha", name: "Alpha", path: "C:\\Projects\\Alpha", color: "green", createdAt: 1, order: 0 }], activeWorkspaceId: "alpha" }, version: 0 }));
    localStorage.setItem("agentdeck-sessions", JSON.stringify({ state: { sessions: [{ id: "doc-session", name: "Documents", workspaceId: "alpha", workdir: "C:\\Projects\\Alpha", status: "idle", currentTask: "", createdAt: 1, diffFiles: [], output: [], runner: { type: "codex" } }], activeSessionId: "doc-session" }, version: 0 }));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Conhecimento local", exact: true }).click();
  await page.getByRole("tab", { name: "Documentos", exact: true }).click();
  return page.locator(".ad-documents");
}

test("document controls support choosing, cancelling, searching, reading and clearing a source", async ({ page }) => {
  const docs = await setupDocuments(page);
  const input = docs.getByRole("textbox"); const search = docs.getByRole("button", { name: "Buscar", exact: true });
  await expect(input).toBeDisabled(); await expect(search).toBeDisabled();
  await page.evaluate(() => { (window as any).__cancelPick = true; });
  await docs.getByRole("button", { name: "Escolher pasta Markdown ou vault", exact: true }).click();
  await expect(docs.getByText("Nenhuma fonte local selecionada")).toBeVisible();
  await page.evaluate(() => { (window as any).__cancelPick = false; });
  await docs.getByRole("button", { name: "Escolher pasta Markdown ou vault", exact: true }).click();
  await expect(input).toBeEnabled(); await expect(search).toBeDisabled();
  await input.fill("typed results"); await input.press("Enter");
  await docs.locator("summary").filter({ hasText: "Project decisions" }).click();
  await expect(docs.getByText("Decisions use typed results and project scope.")).toBeVisible();
  await input.fill("none"); await search.click();
  await expect(docs.getByText("Nenhuma nota encontrada para esta busca.")).toBeVisible();
  await docs.getByRole("button", { name: "Remover fonte", exact: true }).click();
  await expect(input).toHaveValue(""); await expect(input).toBeDisabled();
  await expect(docs.getByText("Fonte removida. Os arquivos foram preservados.")).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__documentCalls);
  expect(calls.filter((call: any) => call.command === "set_knowledge_source").map((call: any) => call.args.sourcePath)).toEqual(["C:\\Notes", ""]);
});

test("document retries repeat the failed action and old searches do not replace edited queries", async ({ page }) => {
  const docs = await setupDocuments(page);
  await page.evaluate(() => { (window as any).__sourceFailure = true; });
  await docs.getByRole("button", { name: "Escolher pasta Markdown ou vault", exact: true }).click();
  await expect(docs.getByRole("alert")).toContainText("Source unavailable");
  await page.evaluate(() => { (window as any).__sourceFailure = false; });
  await docs.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  const input = docs.getByRole("textbox"); await expect(input).toBeEnabled();
  await input.fill("first"); await page.evaluate(() => { (window as any).__holdSearch = true; }); await input.press("Enter");
  await expect(docs.getByRole("button", { name: "Buscar", exact: true })).toBeDisabled();
  await input.fill("second");
  await page.evaluate(() => { (window as any).__holdSearch = false; (window as any).__releaseSearch(); });
  await expect(docs.getByRole("button", { name: "Buscar", exact: true })).toBeEnabled();
  await expect(docs.locator(".ad-documents-results summary")).toHaveCount(0);
  await page.evaluate(() => { (window as any).__searchFailure = true; }); await input.press("Enter");
  await expect(docs.getByRole("alert")).toContainText("Search temporarily unavailable");
  await page.evaluate(() => { (window as any).__searchFailure = false; });
  await docs.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(docs.locator(".ad-documents-results summary")).toContainText("Project decisions");
  await expect(docs.getByRole("alert")).toHaveCount(0);
});

test("documents keep sources scoped and graph navigation reads connected notes without an AI request", async ({ page }) => {
  const docs = await setupDocuments(page);
  await docs.getByRole("button", { name: "Escolher pasta Markdown ou vault", exact: true }).click();
  const graph = docs.getByRole("region", { name: "Grafo de notas", exact: true });
  await expect(graph.getByText("2 notas · 1 ligações", { exact: true })).toBeVisible();
  await graph.getByRole("combobox", { name: "Selecionar nota", exact: true }).selectOption("decisions.md");
  await expect(graph.getByLabel("Trecho da nota")).toHaveText("Preview from C:\\Projects\\Alpha: decisions.md");
  await graph.getByRole("button", { name: "Architecture", exact: true }).click();
  await expect(graph.getByRole("combobox")).toHaveValue("architecture.md");
  await expect(graph.getByLabel("Trecho da nota")).toContainText("architecture.md");
  const scope = page.getByRole("group", { name: "Escopo dos documentos" });
  await scope.getByRole("button", { name: "Global", exact: true }).click();
  await expect(docs.getByRole("textbox")).toBeDisabled();
  await docs.getByRole("button", { name: "Escolher pasta Markdown ou vault", exact: true }).click();
  await expect(docs.getByRole("textbox")).toBeEnabled();
  await docs.getByRole("button", { name: "Remover fonte", exact: true }).click();
  await scope.getByRole("button", { name: "Projeto", exact: true }).click();
  await expect(docs.getByRole("textbox")).toBeEnabled();
  await expect(graph).toBeVisible();
  await graph.getByRole("button", { name: "Atualizar índice", exact: true }).click();
  const calls = await page.evaluate(() => (window as any).__documentCalls);
  expect(calls.filter((call: any) => call.command === "set_knowledge_source").map((call: any) => call.args.projectPath)).toEqual(["C:\\Projects\\Alpha", null, null]);
  expect(calls.some((call: any) => call.command === "get_knowledge_graph" && call.args.refresh === true)).toBe(true);
  expect(calls.some((call: any) => call.command === "start_chat_turn")).toBe(false);
  const scrollPanel = page.locator(".ad-documents-panel");
  expect(await scrollPanel.evaluate(element => ({ scrollable: element.scrollHeight > element.clientHeight, overflow: getComputedStyle(element).overflowY }))).toEqual({ scrollable: true, overflow: "auto" });
  await graph.locator(".ad-note-graph-canvas").scrollIntoViewIfNeeded();
  await expect(graph.locator(".ad-note-graph-canvas")).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: "test-results/knowledge-graph.png", animations: "disabled" });
});

test("vault health explains an unavailable source and rechecks it without changing the selected folder", async ({ page }) => {
  const docs = await setupDocuments(page);
  await page.evaluate(() => { const w = window as any; w.__healthStatus = "unavailable"; w.__healthNoteCount = 0; w.__healthMessage = "QA vault folder is temporarily unavailable"; });
  await docs.getByRole("button", { name: "Escolher pasta Markdown ou vault", exact: true }).click();
  const health = docs.getByRole("region", { name: "Saúde da fonte", exact: true });
  await expect(health).toBeVisible();
  await expect(health.getByRole("alert")).toContainText("Pasta indisponível");
  const selectedBefore = await page.evaluate(() => (window as any).__documentCalls.filter((call: any) => call.command === "set_knowledge_source").length);
  await page.evaluate(() => { const w = window as any; w.__healthStatus = "ready"; w.__healthNoteCount = 2; w.__healthMessage = ""; });
  await health.getByRole("button", { name: "Verificar fonte", exact: true }).click();
  await expect(health.getByRole("alert")).toHaveCount(0);
  await expect(health).toContainText(/2\s+notas/i);
  const calls = await page.evaluate(() => (window as any).__documentCalls);
  expect(calls.filter((call: any) => call.command === "set_knowledge_source")).toHaveLength(selectedBefore);
  expect(calls.filter((call: any) => call.command === "get_knowledge_health").at(-1).args).toMatchObject({ projectPath: "C:\\Projects\\Alpha", refresh: true });
});

test("vault health reports index limits and offers retry after a health command failure", async ({ page }) => {
  const docs = await setupDocuments(page);
  await page.evaluate(() => { const w = window as any; w.__healthStatus = "limited"; w.__healthNoteCount = 3000; w.__healthMessage = "QA vault exceeds the configured index capacity"; });
  await docs.getByRole("button", { name: "Escolher pasta Markdown ou vault", exact: true }).click();
  const health = docs.getByRole("region", { name: "Saúde da fonte", exact: true });
  await expect(health).toContainText(/3[.,]?000/);
  await expect(health).toContainText("16 MiB");
  await expect(health).toContainText("256 KiB");
  await expect(health.getByRole("alert")).toContainText("Índice parcial");
  await page.evaluate(() => { (window as any).__healthFailure = true; });
  await health.getByRole("button", { name: "Verificar fonte", exact: true }).click();
  await expect(health.getByRole("alert").filter({ hasText: "QA health check unavailable" })).toBeVisible();
  await page.evaluate(() => { const w = window as any; w.__healthFailure = false; w.__healthStatus = "ready"; w.__healthMessage = ""; w.__healthNoteCount = 2; });
  await health.getByRole("button", { name: "Verificar fonte", exact: true }).click();
  await expect(health.getByRole("alert")).toHaveCount(0);
  await expect(health).toContainText(/2\s+notas/i);
  await docs.getByRole("button", { name: "Remover fonte", exact: true }).click();
  await expect(docs.getByText("Nenhuma fonte local selecionada")).toBeVisible();
  await expect(docs.getByRole("alert")).toHaveCount(0);
});
