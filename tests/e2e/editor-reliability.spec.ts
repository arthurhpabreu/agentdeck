import { expect, test, type Page } from "@playwright/test";

/** Real editor and stores; all disk writes stop at the mocked native boundary. */
async function setupEditor(page: Page, preview = false) {
  await page.addInitScript(() => {
    const w = window as any;
    let nextId = 0;
    w.__editorCalls = [];
    w.__editorFile = "original content";
    w.__editorVersion = 1;
    w.__editorHoldWrite = false;
    w.__editorWriteFailure = false;
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "popup" }, currentWebview: { label: "popup" } },
      transformCallback: () => ++nextId,
      unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        w.__editorCalls.push({ command, args });
        if (command === "read_session_file") return { content: w.__editorFile, versionToken: `v${w.__editorVersion}`, isBinary: false, missing: false };
        if (command === "write_session_file") {
          if (w.__editorHoldWrite) await new Promise<void>(resolve => { w.__editorReleaseWrite = resolve; });
          if (w.__editorWriteFailure) throw new Error("QA write failed");
          if (args.expectedVersionToken !== `v${w.__editorVersion}`) throw new Error("QA stale file version");
          w.__editorFile = args.content;
          return { versionToken: `v${++w.__editorVersion}` };
        }
        if (command === "list_session_directory") return { path: args.relativePath, entries: [] };
        if (command === "get_git_status") return { staged: [], unstaged: [], untracked: [], conflicts: [], committed: [] };
        if (["recover_workspace_sessions", "backfill_workspace_session_bindings", "list_agent_models", "get_provider_usage", "observe_agent_sessions"].includes(command) || command.startsWith("get_git_diff")) return [];
        if (command === "load_ui_states" || command === "load_deleted_ui_state") return {};
        if (command === "plugin:window|outer_size") return { width: 1360, height: 900 };
        if (command === "plugin:window|outer_position") return { x: 0, y: 0 };
        if (command === "plugin:window|scale_factor") return 1;
        if (command === "plugin:window|is_maximized") return false;
        if (command === "plugin:event|listen") return ++nextId;
        if (command === "check_cli") return true;
        return null;
      },
    };
    localStorage.setItem("agentdeck-settings", JSON.stringify({ state: { settings: { locale: "pt-BR", theme: "dark", splitPaneSidebarWidth: 300, splitWidgetPanelCollapsed: true, runner: { type: "codex" } } }, version: 0 }));
    localStorage.setItem("agentdeck-workspaces", JSON.stringify({ state: { workspaces: [{ id: "editor-project", name: "Editor project", path: "C:\\Projects\\Editor", color: "green", createdAt: 1, order: 0 }], activeWorkspaceId: "editor-project" }, version: 0 }));
    localStorage.setItem("agentdeck-sessions", JSON.stringify({ state: { sessions: [{ id: "editor-session", name: "Editor session", workspaceId: "editor-project", workdir: "C:\\Projects\\Editor", status: "idle", currentTask: "", createdAt: 1, diffFiles: [], output: [], runner: { type: "codex" } }], activeSessionId: "editor-session" }, version: 0 }));
  });
  await page.goto("/");
  await page.evaluate(async (preview) => {
    const modulePath = "/src/services/editorCommands.ts";
    const { openFile } = await import(/* @vite-ignore */ modulePath);
    openFile("editor-session", "draft.ts", preview);
  }, preview);
  const editor = page.locator(".ad-code-editor .cm-content");
  await expect(editor).toBeVisible();
  await expect(editor).toHaveText("original content");
  return editor;
}

test("saving preserves typing that occurs while the native write is pending", async ({ page }) => {
  const editor = await setupEditor(page);
  const save = page.getByRole("button", { name: "Salvar", exact: true });
  await editor.fill("first edit");
  await page.evaluate(() => { (window as any).__editorHoldWrite = true; });
  await save.click();
  await expect.poll(() => page.evaluate(() => (window as any).__editorCalls.filter((call: any) => call.command === "write_session_file").length)).toBe(1);
  await editor.fill("first edit + newer edit");
  await page.evaluate(() => { const w = window as any; w.__editorHoldWrite = false; w.__editorReleaseWrite(); });
  await expect(editor).toHaveText("first edit + newer edit");
  await expect(save).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__editorFile)).toBe("first edit");
  await save.click();
  await expect(save).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__editorFile)).toBe("first edit + newer edit");
  const writes = await page.evaluate(() => (window as any).__editorCalls.filter((call: any) => call.command === "write_session_file"));
  expect(writes.map((call: any) => call.args.expectedVersionToken)).toEqual(["v1", "v2"]);
});

test("failed file writes keep the editor and current draft available for retry", async ({ page }) => {
  const editor = await setupEditor(page);
  const save = page.getByRole("button", { name: "Salvar", exact: true });
  await editor.fill("valuable unsaved content");
  await page.evaluate(() => { (window as any).__editorWriteFailure = true; });
  await save.click();
  await expect(page.getByText("QA write failed", { exact: true })).toBeVisible();
  await expect(editor).toBeVisible();
  await expect(editor).toHaveText("valuable unsaved content");
  await expect(save).toBeEnabled();
  await editor.fill("valuable unsaved content, revised before retry");
  await page.evaluate(() => { (window as any).__editorWriteFailure = false; });
  await save.click();
  await expect(save).toBeDisabled();
  await expect(page.getByText("QA write failed", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__editorFile)).toBe("valuable unsaved content, revised before retry");
});

test("closing a dirty editor requires a choice and cancellation preserves its draft", async ({ page }) => {
  const editor = await setupEditor(page);
  await editor.fill("draft that must survive cancellation");
  const prompts: string[] = [];
  let discard = false;
  page.on("dialog", async dialog => {
    prompts.push(dialog.message());
    expect(dialog.type()).toBe("confirm");
    if (discard) await dialog.accept(); else await dialog.dismiss();
  });
  const close = page.getByTitle("Fechar draft.ts", { exact: true }).last();
  await close.click();
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("draft.ts");
  await expect(editor).toHaveText("draft that must survive cancellation");
  discard = true;
  await close.click();
  expect(prompts).toHaveLength(2);
  await expect(editor).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__editorCalls.filter((call: any) => call.command === "write_session_file"))).toHaveLength(0);
  await page.evaluate(async () => {
    const modulePath = "/src/services/editorCommands.ts";
    const { openFile } = await import(/* @vite-ignore */ modulePath);
    openFile("editor-session", "draft.ts", false);
  });
  await expect(editor).toHaveText("original content");
});

test("typing into a preview keeps its dirty tab when another file opens", async ({ page }) => {
  const editor = await setupEditor(page, true);
  await editor.fill("unsaved changes in the preview");
  await page.evaluate(async () => {
    const modulePath = "/src/services/editorCommands.ts";
    const { openFile } = await import(/* @vite-ignore */ modulePath);
    openFile("editor-session", "other.ts", true);
  });
  await expect(editor).toHaveText("original content");
  await expect(page.getByTitle("Fechar draft.ts", { exact: true }).last()).toBeVisible();
  await expect(page.getByTitle("Fechar other.ts", { exact: true }).last()).toBeVisible();
  await page.getByRole("button", { name: /draft\.ts/ }).filter({ hasText: "draft.ts" }).last().click();
  await expect(editor).toHaveText("unsaved changes in the preview");
  await expect(page.getByRole("button", { name: "Salvar", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__editorCalls.filter((call: any) => call.command === "write_session_file"))).toHaveLength(0);
});
