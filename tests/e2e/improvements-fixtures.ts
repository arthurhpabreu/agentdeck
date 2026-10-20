import { expect, type Page } from "@playwright/test";
export async function setupImprovements(page: Page) {
  await page.addInitScript(() => {
    const w = window as any; let next = 0; const callbacks = new Map<number, Function>(); const listeners = new Map<string, number[]>();
    w.__improvementCalls = []; w.__emitImprovement = (name: string, payload: any) => (listeners.get(name) ?? []).forEach(id => callbacks.get(id)?.({ event: name, id, payload }));
    const selection = { sourceIds: [], personalPreferences: false, memoryCollectionIds: [] };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "popup" }, currentWebview: { label: "popup" } }, transformCallback: (callback: Function) => { callbacks.set(++next, callback); return next; }, unregisterCallback: () => {}, invoke: async (command: string, args: any = {}) => {
      w.__improvementCalls.push({ command, args });
      if (command === "plugin:event|listen") { listeners.set(args.event, [...listeners.get(args.event) ?? [], args.handler]); return ++next; }
      if (command === "plugin:window|is_maximized") return false;
      if (command === "plugin:window|scale_factor") return 1;
      if (command === "plugin:window|outer_size") return { width: 1360, height: 900 };
      if (command === "plugin:window|outer_position") return { x: 0, y: 0 };
      if (command === "check_cli") return true;
      if (command === "get_git_status") return { staged: [], unstaged: [], untracked: [], conflicts: [], committed: [] };
      if (["recover_workspace_sessions", "backfill_workspace_session_bindings", "list_agent_models", "get_provider_usage", "observe_agent_sessions", "memory_list", "search_knowledge"].includes(command) || command.startsWith("get_git_diff")) return [];
      if (["load_ui_states", "load_deleted_ui_state"].includes(command)) return {};
      if (command === "get_knowledge_config") return { sourcePath: "", mode: "markdown" };
      if (command === "get_source_policy") return { schemaVersion: 2, revision: 1, projectKey: args.projectPath, sessionId: args.sessionId, inheritProject: true, selection, vaults: [], selectedSources: [], memoryCollections: [], missingSourceIds: [], migrationBackup: null };
      if (command === "search_session_files") return { paths: ["src/example.ts", "docs/readme.md"].filter(path => path.includes(args.query)), truncated: false };
      if (command === "read_session_file") return { content: "const first = 1;\nconst second = 2;\nconst third = 3;\n", versionToken: "fixture-v1", isBinary: false, missing: false };
      if (command === "list_session_directory") return { path: args.relativePath, entries: [] };
      if (command === "memory_status") return { enabled: true, captureEnabled: false, budgetTokens: 800, recordCount: 0, projectKey: args.projectPath, storage: "local", retrieval: "fts5", estimatedTokenMethod: "bytes/4" };
      if (command === "get_token_economy_status") return { enabled: false, available: false, scope: "agentdeck", reason: "not-installed", estimationMethod: "bytes/4" };
      if (command === "save_chat_attachment") return { name: args.name, path: `C:\\fixtures\\${args.sessionId}\\${args.name}`, mimeType: args.mimeType, size: atob(args.dataBase64).length };
      return null;
    } };
    const workspaces = [{ id: "one", name: "Projeto de teste", path: "C:\\fixtures\\one", color: "green", createdAt: 1, order: 0 }];
    const sessions = Array.from({ length: 6 }, (_, index) => ({ id: `session-${index}`, name: `Conversa ${index}`, workspaceId: "one", workdir: "C:\\fixtures\\one", status: "idle", currentTask: "", createdAt: index + 1, diffFiles: [], output: [], runner: { type: "codex" } }));
    localStorage.setItem("agentdeck-settings", JSON.stringify({ state: { settings: { locale: "pt-BR", theme: "dark", splitWidgetPanelCollapsed: true, runner: { type: "codex" } } }, version: 0 }));
    localStorage.setItem("agentdeck-workspaces", JSON.stringify({ state: { workspaces, activeWorkspaceId: "one" }, version: 0 }));
    localStorage.setItem("agentdeck-sessions", JSON.stringify({ state: { sessions, activeSessionId: "session-0" }, version: 0 }));
  });
  await page.goto("/"); await expect(page.locator(".ad-quick-switch-trigger")).toBeVisible();
  // Sidebar names are drag surfaces; a slow CI click can activate a hold.
  // Enter through the real dashboard action when navigation is just setup.
  await page.getByText("Abrir sessão atual", { exact: true }).click();
  await expect(page.locator(".ad-chat-composer textarea:visible")).toBeVisible();
}
