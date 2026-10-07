import { expect, test, type Page } from "@playwright/test";

async function setupMemory(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    const callbacks = new Map<number, Function>();
    const listeners = new Map<string, Map<number, number>>();
    let nextId = 0;
    const alpha = "C:\\Projects\\Alpha", beta = "C:\\Projects\\Beta";
    const record = (id: string, title: string, content: string, kind = "decision", source = "manual") => ({ id, title, content, kind, pinned: false, source, verification: source === "manual" ? "user-confirmed" : "unverified", sourceSessionId: source === "capture" ? "session-alpha" : null, provider: source === "capture" ? "codex" : null, updatedAt: 1760000000000, revision: 1 });
    w.__memoryRecords = {
      __global__: [record("preference", "Shared language preference", "Use Portuguese for explanations.", "fact")],
      [alpha]: [record("routing", "Routing decision", "Full decision payload: all API failures use typed result objects."), record("handoff", "Next task", "Inspect the authorization boundary next.", "handoff", "capture")],
      [beta]: [record("beta", "Beta deployment", "Beta project uses an independent deployment pipeline.", "fact")],
    };
    w.__memorySettings = { [alpha]: { enabled: true, captureEnabled: true, budgetTokens: 800 }, [beta]: { enabled: true, captureEnabled: true, budgetTokens: 800 } };
    w.__memorySettings.__global__ = { enabled: true, captureEnabled: false, budgetTokens: 800 };
    w.__memoryCalls = [];
    w.__curation = { [alpha]: { enabled: true, selected: 1, archived: 3, method: "local-rules" }, [beta]: { enabled: true, selected: 0, archived: 0, method: "local-rules" }, __global__: { enabled: true, selected: 1, archived: 0, method: "local-rules" } };
    w.__profile = [{ id: "candidate", topic: "package-manager", statement: "Por padrão prefiro pnpm", category: "tools", appliesTo: ["javascript"], general: true, status: "candidate", recordId: null, projectCount: 1, eligible: true, evidence: [{ projectKey: "stable-alpha", eventId: "prompt-1", quote: "Por padrão prefiro pnpm", observedAt: 1760000000000 }] }];
    w.__catalog = [{ id: "stable-alpha", name: "Alpha project", description: "Typed results", stack: ["javascript"], paths: [alpha], repositoryIdentity: "github.com/example/alpha", updatedAt: 1760000000000, recordCount: 2, settings: { contribute: true, consume: true, discovery: false, visible: true } }];
    w.__metadata = { category: "", appliesTo: [], state: "active", supersededBy: null, relations: {}, accessCount: 2, lastAccessedAt: 1760000000000, feedback: "" };
    w.__exportConflict = false;
    w.__memoryFail = false;
    w.__memoryMutationFail = null;
    w.__memoryHoldLoads = false;
    w.__memoryLoadWaiters = [];
    w.__memoryEmit = (event: string, payload: any) => { for (const [eventId, callbackId] of listeners.get(event) ?? []) callbacks.get(callbackId)?.({ event, id: eventId, payload }); };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    const status = (path: string) => ({ ...w.__memorySettings[path], recordCount: w.__memoryRecords[path].length, projectKey: path === "__global__" ? "agentdeck:global" : path, scope: path === "__global__" ? "global" : "project", storagePath: "C:\\Users\\Tester\\AppData\\Roaming\\com.tuxao.agentdeck\\shared-memory\\memory.sqlite3", storage: "local", retrieval: "fts5", estimatedTokenMethod: "bytes/4" });
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "popup" }, currentWebview: { label: "popup" } },
      transformCallback: (callback: Function) => { callbacks.set(++nextId, callback); return nextId; },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        w.__memoryCalls.push({ command, args });
        if (args.scope === "global") args = { ...args, projectPath: "__global__" };
        if (command === w.__memoryMutationFail) throw new Error("Memory write unavailable");
        if (command === "memory_profile") return w.__profile;
        if (command === "memory_curation_status") return { ...w.__curation[args.projectPath] };
        if (command === "memory_set_curation_enabled") { w.__curation[args.projectPath].enabled = args.enabled; return { ...w.__curation[args.projectPath] }; }
        if (command === "memory_catalog") return w.__catalog;
        if (command === "memory_review_profile") { w.__profile[0].status = args.accept ? "accepted" : "rejected"; if (args.accept) w.__memoryRecords.__global__.push(record("approved", "Por padrão prefiro pnpm", "Approved preference", "fact")); return null; }
        if (command === "memory_update_project") { w.__catalog[0] = { ...w.__catalog[0], ...args }; return; }
        if (command === "memory_metadata") return w.__metadata;
        if (command === "memory_set_metadata") { w.__metadata = args.metadata; return; }
        if (command === "memory_versions") return [{ record: record(args.id, "Routing decision", "Earlier decision"), recordedAt: 1760000000000 }];
        if (command === "memory_restore_version") { w.__memoryRecords[alpha][0].content = "Earlier decision"; w.__memoryRecords[alpha][0].revision++; return w.__memoryRecords[alpha][0]; }
        if (command === "memory_inactive" || command === "memory_maintain") return [];
        if (command === "memory_retrieval_preview") return [{ id: "doc:guide", source: "document", scope: "global", title: "Authentication guide", excerpt: "OAuth rotation", score: .015, reason: "linked document, one hop", path: "guide.md", revision: 1 }];
        if (command === "pick_folder") return "C:\\Export";
        if (command === "memory_export_incremental") return { directory: "C:\\Export\\Agentdeck-project", recordCount: 2, changes: [{ path: "memory-routing.md", action: w.__exportConflict ? "conflict" : "update" }], conflicts: w.__exportConflict ? ["memory-routing.md"] : [], applied: args.apply && !w.__exportConflict };
        if (command === "memory_status" || command === "memory_list") {
          if (w.__memoryHoldLoads) await new Promise(resolve => w.__memoryLoadWaiters.push(resolve));
          if (w.__memoryFail) throw new Error("Memory database unavailable");
          if (command === "memory_status") return status(args.projectPath);
          const query = (args.query ?? "").toLowerCase();
          return w.__memoryRecords[args.projectPath].filter((item: any) => `${item.title} ${item.content}`.toLowerCase().includes(query));
        }
        if (command === "memory_save") {
          const previous = w.__memoryRecords[args.projectPath].find((item: any) => item.id === args.record.id);
          const saved = { ...record(args.record.id || `note-${++nextId}`, args.record.title, args.record.content, args.record.kind), ...args.record, id: args.record.id || `note-${nextId}`, updatedAt: Date.now(), revision: (previous?.revision ?? 0) + 1 };
          w.__memoryRecords[args.projectPath] = [...w.__memoryRecords[args.projectPath].filter((item: any) => item.id !== saved.id), saved];
          return saved;
        }
        if (command === "memory_set_pinned") {
          const current = w.__memoryRecords[args.projectPath].find((item: any) => item.id === args.id);
          if (!current) throw new Error("Memory note does not exist in this project");
          const saved = { ...current, pinned: args.pinned, updatedAt: Date.now(), revision: current.revision + 1 };
          w.__memoryRecords[args.projectPath] = w.__memoryRecords[args.projectPath].map((item: any) => item.id === args.id ? saved : item);
          return saved;
        }
        if (command === "memory_delete") { w.__memoryRecords[args.projectPath] = w.__memoryRecords[args.projectPath].filter((item: any) => item.id !== args.id); return; }
        if (command === "memory_configure") { w.__memorySettings[args.projectPath] = { enabled: args.enabled, captureEnabled: args.captureEnabled, budgetTokens: args.budgetTokens }; return status(args.projectPath); }
        if (command === "memory_reset_session") return;
        if (command === "get_knowledge_config") return { sourcePath: "C:\\Notes", mode: "markdown" };
        if (command === "search_knowledge") return [{ path: "guide.md", title: "Project guide", excerpt: "Existing document search remains available.", score: 1 }];
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
    localStorage.setItem("agentdeck-settings", JSON.stringify({ state: { settings: { locale: "pt-BR", theme: "dark", splitWidgetPanelCollapsed: true, splitPaneSidebarWidth: 380, runner: { type: "codex" } } }, version: 0 }));
    localStorage.setItem("agentdeck-workspaces", JSON.stringify({ state: { workspaces: [{ id: "alpha", name: "Alpha project", path: alpha, color: "green", createdAt: 1, order: 0 }, { id: "beta", name: "Beta project", path: beta, color: "blue", createdAt: 2, order: 1 }], activeWorkspaceId: "alpha" }, version: 0 }));
    localStorage.setItem("agentdeck-sessions", JSON.stringify({ state: { sessions: [{ id: "session-alpha", name: "Memory session", workspaceId: "alpha", workdir: alpha, status: "idle", currentTask: "", createdAt: 1, diffFiles: [], output: [], runner: { type: "codex" } }], activeSessionId: "session-alpha" }, version: 0 }));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Conhecimento local", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Memória compartilhada", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Memória compartilhada", exact: true }).getByText("Routing decision", { exact: true })).toBeVisible();
}

test("automatic memory selection is enabled and its opt-out is isolated by scope", async ({ page }) => {
  await setupMemory(page);
  const memory = page.getByRole("region", { name: "Memória compartilhada", exact: true });
  const toggle = memory.getByRole("switch", { name: "Seleção automática da memória", exact: true });
  await expect(toggle).toBeChecked();
  await expect(memory.getByText("Selecionadas automaticamente: 1 · Capturas arquivadas: 3", { exact: true })).toBeVisible();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await memory.getByRole("combobox", { name: "Projeto da memória" }).selectOption("beta");
  await expect(toggle).toBeChecked();
  await memory.getByRole("combobox", { name: "Projeto da memória" }).selectOption("alpha");
  await expect(toggle).not.toBeChecked();
  expect(await page.evaluate(() => (window as any).__memoryCalls.filter((c: any) => c.command === "memory_review_profile"))).toHaveLength(0);
});

test("project memory supports inspection, editing, pinning, deletion and isolated project search", async ({ page }) => {
  await setupMemory(page);
  const memory = page.getByRole("region", { name: "Memória compartilhada", exact: true });
  await expect(memory.getByText("Full decision payload: all API failures use typed result objects.", { exact: true })).toHaveCount(0);
  await memory.getByRole("button").filter({ hasText: "Routing decision" }).click();
  await expect(memory.getByRole("heading", { name: "Routing decision", exact: true })).toBeFocused();
  await expect(memory.getByText("Full decision payload: all API failures use typed result objects.", { exact: true })).toBeVisible();
  await expect(memory.getByText("Confirmada por você", { exact: true })).toBeVisible();
  await memory.getByRole("button", { name: "Editar nota", exact: true }).click();
  await memory.getByRole("textbox", { name: "Título da nota", exact: true }).fill("Typed result convention");
  await memory.getByRole("textbox", { name: "Conteúdo da nota", exact: true }).fill("All services return typed result objects.");
  await memory.getByRole("button", { name: "Salvar nota", exact: true }).click();
  await expect(memory.getByRole("heading", { name: "Typed result convention", exact: true })).toBeVisible();
  await memory.getByRole("button", { name: "Afixar nota", exact: true }).click();
  await expect(memory.getByRole("button", { name: "Desafixar nota", exact: true })).toBeVisible();
  await memory.getByRole("button", { name: "Desafixar nota", exact: true }).click();
  await expect(memory.getByRole("button", { name: "Afixar nota", exact: true })).toBeVisible();
  await memory.getByRole("button", { name: "Excluir nota", exact: true }).click();
  await memory.getByRole("alert").getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(memory.getByRole("alert")).toHaveCount(0);
  await expect(memory.getByRole("heading", { name: "Typed result convention", exact: true })).toBeVisible();
  await memory.getByRole("button", { name: "Excluir nota", exact: true }).click();
  await memory.getByRole("alert").getByRole("button", { name: "Excluir nota", exact: true }).click();
  await expect(memory.getByText("Nota excluída.", { exact: true })).toBeVisible();
  await expect(memory.getByText("Typed result convention", { exact: true })).toHaveCount(0);
  await memory.getByRole("button", { name: "Nova nota", exact: true }).click();
  await memory.getByRole("textbox", { name: "Título da nota", exact: true }).fill("Alpha fact");
  await memory.getByRole("textbox", { name: "Conteúdo da nota", exact: true }).fill("Alpha keeps result objects in the shared library.");
  await memory.getByRole("button", { name: "Salvar nota", exact: true }).click();
  await memory.getByRole("button", { name: "Voltar às notas", exact: true }).click();
  await memory.getByRole("searchbox").fill("result");
  await expect(memory.getByRole("button").filter({ hasText: "Alpha fact" })).toBeVisible();
  await expect(memory.getByText("Next task", { exact: true })).toHaveCount(0);
  await memory.getByRole("combobox", { name: "Projeto da memória" }).selectOption("beta");
  await expect(memory.getByText("Beta deployment", { exact: true })).toBeVisible();
  await expect(memory.getByText("Alpha fact", { exact: true })).toHaveCount(0);
  await expect(memory.getByRole("searchbox")).toHaveValue("");
  const saves = await page.evaluate(() => (window as any).__memoryCalls.filter((call: any) => call.command === "memory_save"));
  expect(saves.length).toBeGreaterThanOrEqual(2);
  expect(saves.every((call: any) => call.args.projectPath === "C:\\Projects\\Alpha")).toBe(true);
  expect(await page.evaluate(() => (window as any).__memoryCalls.filter((call: any) => call.command === "memory_set_pinned").length)).toBe(2);
});

test("optional profile review hides processed entries and catalog discovery defaults to disabled", async ({ page }) => {
  await setupMemory(page);
  const memory = page.getByRole("region", { name: "Memória compartilhada", exact: true });
  await memory.locator("summary").filter({ hasText: "Conhecimento dos projetos" }).click();
  await expect(memory.getByRole("button", { name: "Aprovar preferência", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__memoryCalls.filter((c: any) => c.command === "memory_review_profile").length)).toBe(0);
  await memory.getByRole("button", { name: "Aprovar preferência", exact: true }).click();
  await expect(memory.getByRole("button", { name: "Aprovar preferência", exact: true })).toHaveCount(0);
  await memory.getByRole("checkbox", { name: "Mostrar preferências já processadas", exact: true }).check();
  await expect(memory.getByText("Aprovada", { exact: false }).first()).toBeVisible();
  await memory.getByRole("button", { name: "Catálogo", exact: true }).click();
  const discovery = memory.getByRole("checkbox", { name: "Permitir consultas explícitas a outros projetos" });
  await expect(discovery).not.toBeChecked(); await discovery.check();
  await memory.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(discovery).toBeChecked();
  expect(await page.evaluate(() => (window as any).__catalog[0].settings.discovery)).toBe(true);
});

test("unified search explains sources and incremental export blocks local conflicts", async ({ page }) => {
  await setupMemory(page);
  const memory = page.getByRole("region", { name: "Memória compartilhada", exact: true });
  await memory.locator("summary").filter({ hasText: "Conhecimento dos projetos" }).click();
  await memory.getByRole("button", { name: "Busca integrada", exact: true }).click();
  const intelligence = memory.locator(".ad-memory-intelligence").first();
  await intelligence.getByRole("searchbox").fill("OAuth"); await intelligence.getByRole("searchbox").press("Enter");
  await expect(intelligence.getByText("Authentication guide", { exact: true })).toBeVisible();
  await expect(intelligence.getByText("linked document, one hop", { exact: true })).toBeVisible();
  await intelligence.getByRole("button", { name: "Exportação incremental", exact: true }).click();
  await page.evaluate(() => { (window as any).__exportConflict = true; });
  await intelligence.getByRole("button", { name: "Escolher pasta e visualizar", exact: true }).click();
  await expect(intelligence.getByRole("button", { name: "Aplicar exportação", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__memoryCalls.some((call: any) => call.command === "memory_export_incremental" && call.args.apply))).toBe(false);
  await page.evaluate(() => { (window as any).__exportConflict = false; });
  await intelligence.getByRole("button", { name: "Escolher pasta e visualizar", exact: true }).click();
  await intelligence.getByRole("button", { name: "Aplicar exportação", exact: true }).click();
  await expect(intelligence.getByText("Exportação concluída", { exact: true })).toBeVisible();
});

test("note history restores content and saves applicability and feedback", async ({ page }) => {
  await setupMemory(page);
  const memory = page.getByRole("region", { name: "Memória compartilhada", exact: true });
  await memory.getByRole("button").filter({ hasText: "Routing decision" }).click();
  await memory.locator("summary").filter({ hasText: "Histórico e aplicabilidade" }).click();
  await memory.getByRole("textbox", { name: "Aplicável às stacks (separadas por vírgula)" }).fill("javascript, typescript");
  await memory.getByRole("combobox", { name: "Utilidade", exact: true }).selectOption("wrong");
  await memory.getByRole("button", { name: "Salvar", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__metadata.appliesTo)).toEqual(["javascript", "typescript"]);
  expect(await page.evaluate(() => (window as any).__metadata.feedback)).toBe("wrong");
  await memory.getByRole("button", { name: "Restaurar", exact: true }).click();
  await expect(memory.locator(".ad-memory-note-content")).toHaveText("Earlier decision");
});

test("global notes have an explicit scope, project isolation and discoverable local storage", async ({ page }) => {
  await setupMemory(page);
  const memory = page.getByRole("region", { name: "Memória compartilhada", exact: true });
  const scopes = memory.getByRole("group", { name: "Escopo da memória" });
  await scopes.getByRole("button", { name: "Global", exact: true }).click();
  await expect(memory.getByText("Shared language preference", { exact: true })).toBeVisible();
  await expect(memory.getByText("Routing decision", { exact: true })).toHaveCount(0);
  await expect(memory.locator("code").filter({ hasText: "memory.sqlite3" })).toBeVisible();
  await memory.getByRole("button", { name: "Nova nota", exact: true }).click();
  await memory.getByRole("textbox", { name: "Título da nota", exact: true }).fill("Review preference");
  await memory.getByRole("textbox", { name: "Conteúdo da nota", exact: true }).fill("Explain verification results concisely.");
  await memory.getByRole("button", { name: "Salvar nota", exact: true }).click();
  await memory.getByRole("button", { name: "Voltar às notas", exact: true }).click();
  await scopes.getByRole("button", { name: "Este projeto", exact: true }).click();
  await expect(memory.getByText("Routing decision", { exact: true })).toBeVisible();
  await expect(memory.getByText("Review preference", { exact: true })).toHaveCount(0);
  await memory.getByRole("combobox", { name: "Projeto da memória" }).selectOption("beta");
  await expect(memory.getByText("Beta deployment", { exact: true })).toBeVisible();
  await scopes.getByRole("button", { name: "Global", exact: true }).click();
  await expect(memory.getByText("Review preference", { exact: true })).toBeVisible();
  await memory.locator("summary").filter({ hasText: "Preferências de memória" }).click();
  await expect(memory.getByRole("switch", { name: "Captura automática", exact: true })).toHaveCount(0);
  const saved = await page.evaluate(() => (window as any).__memoryCalls.find((call: any) => call.command === "memory_save"));
  expect(saved.args).toMatchObject({ scope: "global", projectPath: "" });
  await page.screenshot({ path: "test-results/global-memory.png", animations: "disabled" });
});

test("memory preferences validate budgets, preserve provenance and keep document search available", async ({ page }) => {
  await setupMemory(page);
  const memory = page.getByRole("region", { name: "Memória compartilhada", exact: true });
  await memory.locator("summary").filter({ hasText: "Preferências de memória" }).click();
  await expect(memory.getByRole("switch", { name: "Captura automática", exact: true })).toBeChecked();
  await memory.getByRole("switch", { name: "Captura automática", exact: true }).click();
  await expect(memory.getByRole("switch", { name: "Captura automática", exact: true })).not.toBeChecked();
  await memory.getByRole("spinbutton", { name: "Orçamento de contexto", exact: true }).fill("2048");
  await memory.getByRole("button", { name: "Aplicar orçamento", exact: true }).click();
  await expect(memory.getByText("Use um valor entre 256 e 2.000 tokens.", { exact: true })).toBeVisible();
  await memory.getByRole("spinbutton", { name: "Orçamento de contexto", exact: true }).fill("1200");
  await memory.getByRole("button", { name: "Aplicar orçamento", exact: true }).click();
  await expect(memory.getByRole("spinbutton", { name: "Orçamento de contexto", exact: true })).toHaveValue("1200");
  expect(await page.evaluate(() => (window as any).__memoryCalls.some((call: any) => call.command === "memory_configure" && call.args.budgetTokens === 1200 && call.args.captureEnabled === false))).toBe(true);
  expect(await page.evaluate(() => (window as any).__memoryCalls.some((call: any) => call.command === "memory_configure" && call.args.budgetTokens === 2048))).toBe(false);
  await memory.getByRole("button", { name: "Relembrar nesta conversa", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__memoryCalls.some((call: any) => call.command === "memory_reset_session" && call.args.sessionId === "session-alpha" && call.args.provider === "codex"))).toBe(true);
  await memory.getByRole("button").filter({ hasText: "Next task" }).click();
  await expect(memory.getByText("Não verificada", { exact: true })).toBeVisible();
  await expect(memory.getByText("Captura automática", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/shared-memory.png" });
  await memory.getByRole("button", { name: "Voltar às notas", exact: true }).click();
  await page.evaluate(() => { (window as any).__memoryFail = true; });
  await memory.getByRole("button", { name: "Atualizar memória", exact: true }).click();
  await expect(memory.getByRole("alert")).toContainText("Memory database unavailable");
  await page.evaluate(() => { (window as any).__memoryFail = false; });
  await memory.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(memory.getByRole("alert")).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    w.__memoryRecords["C:\\Projects\\Alpha"].push({ id: "captured-new", title: "New handoff captured", content: "Continue reviewing the API", kind: "handoff", source: "capture", verification: "unverified", provider: "codex", pinned: false, updatedAt: Date.now(), revision: 1 });
    w.__memoryEmit("shared-memory-changed", { projectKey: "C:\\Projects\\Alpha" });
  });
  await expect(memory.getByText("New handoff captured", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Documentos", exact: true }).click();
  await expect(page.getByRole("button", { name: "Escolher pasta Markdown ou vault", exact: true })).toBeVisible();
  await page.getByRole("tabpanel").getByRole("textbox").fill("architecture");
  await page.getByRole("tabpanel").getByRole("textbox").press("Enter");
  await expect(page.getByText("Project guide", { exact: true })).toBeVisible();
});

test("session memory indicators use real events and surface retrieval failures", async ({ page }) => {
  await setupMemory(page);
  await page.getByRole("button", { name: "Sessões", exact: true }).click();
  await page.getByText("Memory session", { exact: true }).first().click();
  const open = page.getByTitle("Abrir conversa");
  if (await open.count()) await open.first().click();
  const control = page.getByRole("button", { name: "Abrir memória do projeto", exact: true });
  await expect(control).toBeVisible();
  await expect(control).not.toContainText("≈");
  await page.evaluate(() => (window as any).__memoryEmit("shared-memory-context", { sessionId: "session-alpha", projectKey: "C:\\Projects\\Alpha", recordCount: 2, estimatedTokens: 320, duplicateCount: 1 }));
  await expect(control).toContainText("≈320");
  await expect(control).toHaveAttribute("title", /Notas recuperadas: 2.*Notas não repetidas: 1/);
  await page.evaluate(() => (window as any).__memoryEmit("shared-memory-error", { sessionId: "session-alpha", error: "Retrieval database failed" }));
  await expect(control.getByRole("status")).toContainText("Memória indisponível");
  await expect(control).toHaveAttribute("title", /Retrieval database failed/);
  await control.click();
  await expect(page.getByRole("tab", { name: "Memória compartilhada", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("saving a response retains its project and provider provenance without sending a model request", async ({ page }) => {
  await setupMemory(page);
  await page.addInitScript(() => localStorage.setItem("agentdeck-chat-v1", JSON.stringify({ "session-alpha": { messages: [{ id: "response", turnId: "finished", role: "assistant", at: Date.now(), text: "# Durable architecture decision\nUse typed boundaries between the Rust engine and React interface." }], draft: "", busy: false } })));
  await page.reload();
  await page.getByRole("button", { name: "Sessões", exact: true }).click();
  await page.getByText("Memory session", { exact: true }).first().click();
  const open = page.getByTitle("Abrir conversa");
  if (await open.count()) await open.first().click();
  await page.getByRole("button", { name: "Guardar resposta na memória", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resposta guardada na memória do projeto.", exact: true })).toBeDisabled();
  const calls = await page.evaluate(() => (window as any).__memoryCalls);
  const save = calls.find((call: any) => call.command === "memory_save").args;
  expect(save.projectPath).toBe("C:\\Projects\\Alpha");
  expect(save.record).toMatchObject({ title: "Durable architecture decision", kind: "handoff", sourceSessionId: "session-alpha", provider: "codex", pinned: false });
  expect(calls.some((call: any) => call.command === "start_chat_turn")).toBe(false);
  await page.getByRole("button", { name: "Abrir memória do projeto", exact: true }).click();
  await expect(page.getByRole("region", { name: "Memória compartilhada", exact: true }).getByText("Durable architecture decision", { exact: true })).toBeVisible();
});

test("context budget allows empty drafts and survives provider refreshes until applied or cancelled", async ({ page }) => {
  await setupMemory(page);
  const memory = page.getByRole("region", { name: "Memória compartilhada", exact: true });
  const preferences = memory.locator("summary").filter({ hasText: "Preferências de memória" });
  await preferences.click();
  const budget = memory.getByRole("spinbutton", { name: "Orçamento de contexto", exact: true });
  const apply = memory.getByRole("button", { name: "Aplicar orçamento", exact: true });
  await expect(budget).toHaveValue("800");
  await expect(apply).toBeDisabled();
  await budget.fill("");
  await expect(budget).toHaveValue("");
  await expect(apply).toBeEnabled();
  await budget.press("Enter");
  await expect(budget).toHaveValue("");
  await expect(budget).toHaveAttribute("aria-invalid", "true");
  await expect(memory.getByText("Use um valor entre 256 e 2.000 tokens.", { exact: true })).toBeVisible();
  for (const invalid of ["255", "256.5", "2001"]) {
    await budget.fill(invalid);
    await apply.click();
    await expect(budget).toHaveAttribute("aria-invalid", "true");
  }
  expect(await page.evaluate(() => (window as any).__memoryCalls.filter((call: any) => call.command === "memory_configure").length)).toBe(0);

  await budget.fill("1100");
  const reads = await page.evaluate(() => (window as any).__memoryCalls.filter((call: any) => call.command === "memory_status").length);
  await page.evaluate(() => {
    const w = window as any;
    w.__memorySettings["C:\\Projects\\Alpha"].budgetTokens = 1000;
    w.__memoryEmit("shared-memory-changed", { projectKey: "C:\\Projects\\Alpha" });
  });
  await expect.poll(() => page.evaluate(() => (window as any).__memoryCalls.filter((call: any) => call.command === "memory_status").length)).toBeGreaterThan(reads);
  await expect(memory.getByRole("button", { name: "Atualizar memória", exact: true })).toBeEnabled();
  await expect(budget).toHaveValue("1100");
  await memory.getByRole("switch", { name: "Captura automática", exact: true }).click();
  await expect(memory.getByRole("switch", { name: "Captura automática", exact: true })).not.toBeChecked();
  await expect(budget).toHaveValue("1100");

  await page.evaluate(() => { const w = window as any; w.__memoryHoldLoads = true; w.__memoryEmit("shared-memory-changed", { projectKey: "C:\\Projects\\Alpha" }); });
  await expect(memory.getByRole("button", { name: "Atualizar memória", exact: true })).toBeDisabled();
  await expect(budget).toBeEnabled();
  await budget.fill("1200");
  await page.evaluate(() => { const w = window as any; w.__memoryHoldLoads = false; w.__memoryLoadWaiters.splice(0).forEach((resolve: Function) => resolve()); });
  await expect(memory.getByRole("button", { name: "Atualizar memória", exact: true })).toBeEnabled();
  await expect(budget).toHaveValue("1200");
  await budget.press("Escape");
  await expect(budget).toHaveValue("1000");
  await expect(budget).toHaveAttribute("aria-invalid", "false");
  await expect(apply).toBeDisabled();
  await budget.fill("");
  await memory.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(budget).toHaveValue("1000");

  await budget.fill("1200");
  await budget.press("Enter");
  await expect(budget).toHaveValue("1200");
  await expect(apply).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__memorySettings["C:\\Projects\\Alpha"].budgetTokens)).toBe(1200);
  await budget.fill("1800");
  await memory.getByRole("combobox", { name: "Projeto da memória" }).selectOption("beta");
  await preferences.click();
  await expect(budget).toHaveValue("800");
  await memory.getByRole("combobox", { name: "Projeto da memória" }).selectOption("alpha");
  await preferences.click();
  await expect(budget).toHaveValue("1200");
  await expect(apply).toBeDisabled();
});

test("memory controls keep keyboard focus and support cancelling, filtering and disabling retrieval", async ({ page }) => {
  await setupMemory(page);
  const memory = page.getByRole("region", { name: "Memória compartilhada", exact: true });
  const newNote = memory.getByRole("button", { name: "Nova nota", exact: true });
  await newNote.click();
  await expect(memory.getByRole("textbox", { name: "Título da nota", exact: true })).toBeFocused();
  await expect(memory.getByRole("button", { name: "Salvar nota", exact: true })).toBeDisabled();
  await memory.getByRole("textbox", { name: "Título da nota", exact: true }).fill("Discard this draft");
  await memory.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(newNote).toBeFocused();
  await expect(memory.getByText("Discard this draft", { exact: true })).toHaveCount(0);
  const routing = memory.getByRole("button").filter({ hasText: "Routing decision" });
  await routing.click();
  await memory.getByRole("button", { name: "Editar nota", exact: true }).click();
  await memory.getByRole("textbox", { name: "Título da nota", exact: true }).fill("Discard this edit");
  await memory.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(memory.getByRole("heading", { name: "Routing decision", exact: true })).toBeFocused();
  await memory.getByRole("button", { name: "Voltar às notas", exact: true }).click();
  await expect(routing).toBeFocused();
  await memory.getByRole("combobox", { name: "Tipo de nota", exact: true }).selectOption("handoff");
  await expect(routing).toHaveCount(0);
  await expect(memory.getByRole("button").filter({ hasText: "Next task" })).toBeVisible();
  await memory.getByRole("searchbox").fill("no matching record");
  await expect(memory.locator(".ad-memory-notes > button")).toHaveCount(0);
  await memory.locator(".ad-memory-empty").getByRole("button").click();
  await expect(memory.getByRole("searchbox")).toHaveValue("");
  await expect(memory.getByRole("combobox", { name: "Tipo de nota", exact: true })).toHaveValue("all");
  await expect(routing).toBeVisible();
  await memory.locator("summary").filter({ hasText: "Preferências de memória" }).click();
  const enabled = memory.getByRole("switch", { name: "Memória do projeto", exact: true });
  await enabled.click();
  await expect(enabled).not.toBeChecked();
  await expect(memory.getByRole("button", { name: "Relembrar nesta conversa", exact: true })).toBeDisabled();
  await enabled.click();
  await expect(enabled).toBeChecked();
  await expect(memory.getByRole("button", { name: "Relembrar nesta conversa", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__memoryCalls.some((call: any) => call.command === "memory_save"))).toBe(false);
});

test("failed writes retain drafts and deletion confirmation until an explicit retry or cancel", async ({ page }) => {
  await setupMemory(page);
  const memory = page.getByRole("region", { name: "Memória compartilhada", exact: true });
  await memory.getByRole("button").filter({ hasText: "Routing decision" }).click();
  await memory.getByRole("button", { name: "Editar nota", exact: true }).click();
  await memory.getByRole("textbox", { name: "Título da nota", exact: true }).fill("Retry this decision");
  await page.evaluate(() => { (window as any).__memoryMutationFail = "memory_save"; });
  await memory.getByRole("button", { name: "Salvar nota", exact: true }).click();
  await expect(memory.getByRole("alert")).toContainText("Memory write unavailable");
  await expect(memory.getByRole("textbox", { name: "Título da nota", exact: true })).toHaveValue("Retry this decision");
  const before = await page.evaluate(() => (window as any).__memoryCalls.filter((call: any) => call.command === "memory_status").length);
  await page.evaluate(() => (window as any).__memoryEmit("shared-memory-changed", { projectKey: "C:\\Projects\\Alpha" }));
  await expect.poll(() => page.evaluate(() => (window as any).__memoryCalls.filter((call: any) => call.command === "memory_status").length)).toBeGreaterThan(before);
  await expect(memory.locator(".ad-memory-error")).toContainText("Memory write unavailable");
  await memory.getByRole("textbox", { name: "Título da nota", exact: true }).fill("Retry latest decision");
  await page.evaluate(() => { (window as any).__memoryMutationFail = null; });
  await memory.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(memory.getByRole("heading", { name: "Retry latest decision", exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__memoryMutationFail = "memory_delete"; });
  await memory.getByRole("button", { name: "Excluir nota", exact: true }).click();
  await memory.locator(".ad-memory-delete-confirm").getByRole("button", { name: "Excluir nota", exact: true }).click();
  await expect(memory.locator(".ad-memory-error")).toContainText("Memory write unavailable");
  await expect(memory.locator(".ad-memory-delete-confirm")).toBeVisible();
  await expect(memory.getByRole("heading", { name: "Retry latest decision", exact: true })).toBeVisible();
  await memory.locator(".ad-memory-delete-confirm").getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(memory.locator(".ad-memory-delete-confirm")).toHaveCount(0);
  await expect(memory.locator(".ad-memory-error")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__memoryRecords["C:\\Projects\\Alpha"].some((record: any) => record.id === "routing"))).toBe(true);
  await memory.getByRole("button", { name: "Excluir nota", exact: true }).click();
  await memory.locator(".ad-memory-delete-confirm").getByRole("button", { name: "Excluir nota", exact: true }).click();
  await expect(memory.locator(".ad-memory-error")).toBeVisible();
  await page.evaluate(() => { (window as any).__memoryMutationFail = null; });
  await memory.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(memory.getByText("Nota excluída.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__memoryRecords["C:\\Projects\\Alpha"].some((record: any) => record.id === "routing"))).toBe(false);
});

test("atomic pin and its retry preserve concurrent updates and captured provenance", async ({ page }) => {
  await setupMemory(page);
  const memory = page.getByRole("region", { name: "Memória compartilhada", exact: true });
  await memory.getByRole("button").filter({ hasText: "Next task" }).click();
  await page.evaluate(() => {
    const w = window as any;
    const record = w.__memoryRecords["C:\\Projects\\Alpha"].find((item: any) => item.id === "handoff");
    record.content = "Updated by the agent while this note was open."; record.revision = 2;
    w.__memoryEmit("shared-memory-changed", { projectKey: "C:\\Projects\\Alpha" });
  });
  await expect(memory.getByText("Updated by the agent while this note was open.", { exact: true })).toBeVisible();
  // Another write can occur after the refresh and before the click. Pin must not resend the viewed text.
  await page.evaluate(() => {
    const record = (window as any).__memoryRecords["C:\\Projects\\Alpha"].find((item: any) => item.id === "handoff");
    record.content = "Latest content saved immediately before pinning."; record.revision = 3;
  });
  await memory.getByRole("button", { name: "Afixar nota", exact: true }).click();
  await expect(memory.getByText("Latest content saved immediately before pinning.", { exact: true })).toBeVisible();
  await expect(memory.getByText("Não verificada", { exact: true })).toBeVisible();
  let stored = await page.evaluate(() => (window as any).__memoryRecords["C:\\Projects\\Alpha"].find((item: any) => item.id === "handoff"));
  expect(stored).toMatchObject({ pinned: true, source: "capture", verification: "unverified", provider: "codex", sourceSessionId: "session-alpha", content: "Latest content saved immediately before pinning." });
  await page.evaluate(() => { (window as any).__memoryMutationFail = "memory_set_pinned"; });
  await memory.getByRole("button", { name: "Desafixar nota", exact: true }).click();
  await expect(memory.locator(".ad-memory-error")).toContainText("Memory write unavailable");
  await page.evaluate(() => {
    const w = window as any;
    const record = w.__memoryRecords["C:\\Projects\\Alpha"].find((item: any) => item.id === "handoff");
    record.content = "Content changed before retry."; record.revision += 1;
    w.__memoryMutationFail = null;
  });
  await memory.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(memory.getByRole("button", { name: "Afixar nota", exact: true })).toBeVisible();
  await expect(memory.getByText("Content changed before retry.", { exact: true })).toBeVisible();
  stored = await page.evaluate(() => (window as any).__memoryRecords["C:\\Projects\\Alpha"].find((item: any) => item.id === "handoff"));
  expect(stored).toMatchObject({ pinned: false, source: "capture", verification: "unverified", content: "Content changed before retry." });
  const calls = await page.evaluate(() => (window as any).__memoryCalls);
  expect(calls.filter((call: any) => call.command === "memory_save")).toHaveLength(0);
  expect(calls.filter((call: any) => call.command === "memory_set_pinned").map((call: any) => call.args)).toEqual([
    { projectPath: "C:\\Projects\\Alpha", scope: "project", id: "handoff", pinned: true },
    { projectPath: "C:\\Projects\\Alpha", scope: "project", id: "handoff", pinned: false },
    { projectPath: "C:\\Projects\\Alpha", scope: "project", id: "handoff", pinned: false },
  ]);
});

test("configuration and recall retries preserve current drafts and repeat the intended operation", async ({ page }) => {
  await setupMemory(page);
  const memory = page.getByRole("region", { name: "Memória compartilhada", exact: true });
  await memory.locator("summary").filter({ hasText: "Preferências de memória" }).click();
  const budget = memory.getByRole("spinbutton", { name: "Orçamento de contexto", exact: true });
  await budget.fill("1200");
  await page.evaluate(() => { (window as any).__memoryMutationFail = "memory_configure"; });
  await memory.getByRole("button", { name: "Aplicar orçamento", exact: true }).click();
  await expect(memory.locator(".ad-memory-error")).toContainText("Memory write unavailable");
  await budget.fill("1400");
  const reads = await page.evaluate(() => (window as any).__memoryCalls.filter((call: any) => call.command === "memory_status").length);
  await page.evaluate(() => {
    const w = window as any;
    w.__memorySettings["C:\\Projects\\Alpha"].captureEnabled = false;
    w.__memoryEmit("shared-memory-changed", { projectKey: "C:\\Projects\\Alpha" });
  });
  await expect.poll(() => page.evaluate(() => (window as any).__memoryCalls.filter((call: any) => call.command === "memory_status").length)).toBeGreaterThan(reads);
  await expect(memory.getByRole("switch", { name: "Captura automática", exact: true })).not.toBeChecked();
  await expect(memory.locator(".ad-memory-error")).toBeVisible();
  await expect(budget).toHaveValue("1400");
  await page.evaluate(() => { (window as any).__memoryMutationFail = null; });
  await memory.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(memory.locator(".ad-memory-error")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__memorySettings["C:\\Projects\\Alpha"])).toEqual({ enabled: true, captureEnabled: false, budgetTokens: 1400 });

  await page.evaluate(() => { (window as any).__memoryMutationFail = "memory_configure"; });
  await memory.getByRole("switch", { name: "Captura automática", exact: true }).click();
  await expect(memory.locator(".ad-memory-error")).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.__memorySettings["C:\\Projects\\Alpha"].enabled = false;
    w.__memoryEmit("shared-memory-changed", { projectKey: "C:\\Projects\\Alpha" });
  });
  await expect(memory.getByRole("switch", { name: "Memória do projeto", exact: true })).not.toBeChecked();
  await page.evaluate(() => { (window as any).__memoryMutationFail = null; });
  await memory.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(memory.getByRole("switch", { name: "Captura automática", exact: true })).toBeChecked();
  expect(await page.evaluate(() => (window as any).__memorySettings["C:\\Projects\\Alpha"])).toEqual({ enabled: false, captureEnabled: true, budgetTokens: 1400 });
  await memory.getByRole("switch", { name: "Memória do projeto", exact: true }).click();
  await expect(memory.getByRole("switch", { name: "Memória do projeto", exact: true })).toBeChecked();

  await page.evaluate(() => { (window as any).__memoryMutationFail = "memory_reset_session"; });
  await memory.getByRole("button", { name: "Relembrar nesta conversa", exact: true }).click();
  await expect(memory.locator(".ad-memory-error")).toContainText("Memory write unavailable");
  await page.evaluate(() => { (window as any).__memoryMutationFail = null; });
  await memory.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(memory.getByText("A próxima mensagem poderá recuperar novamente o contexto relevante.", { exact: true })).toBeVisible();
  const attempts = await page.evaluate(() => (window as any).__memoryCalls.filter((call: any) => call.command === "memory_reset_session"));
  expect(attempts).toHaveLength(2);
  expect(attempts.every((call: any) => call.args.sessionId === "session-alpha" && call.args.provider === "codex")).toBe(true);
});

test("memory explains context retrieval and opens the recorded source conversation", async ({ page }) => {
  await setupMemory(page);
  const memory = page.getByRole("region", { name: "Memória compartilhada", exact: true });
  await memory.locator("summary").filter({ hasText: "Como o contexto é usado" }).click();
  await expect(memory.getByText("Contexto relevante recuperado sob demanda. Notas completas ficam disponíveis por MCP; não são anexadas integralmente a cada mensagem.", { exact: true })).toBeVisible();
  await expect(memory.getByText("A seleção organiza o contexto automaticamente. Notas do agente são evidências históricas; confirme arquivos e resultados ao reutilizá-las.", { exact: true })).toBeVisible();
  await memory.getByRole("button").filter({ hasText: "Next task" }).click();
  await memory.getByRole("button", { name: "Abrir sessão de origem", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Conversa", exact: true })).toBeVisible();
  await expect(page.getByText("Memory session", { exact: true }).last()).toBeVisible();
});
