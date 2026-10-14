import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as any; let next = 0;
    w.__orderingCalls = [];
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "popup" }, currentWebview: { label: "popup" } }, transformCallback: () => ++next, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        w.__orderingCalls.push({ command, args });
        if (command === "plugin:event|listen") return ++next;
        if (command === "plugin:window|outer_size") return { width: 1360, height: 900 };
        if (command === "plugin:window|outer_position") return { x: 0, y: 0 };
        if (command === "plugin:window|scale_factor") return 1;
        if (command === "plugin:window|is_maximized") return false;
        if (command === "check_cli") return true;
        if (command === "get_git_status") return { staged: [], unstaged: [], untracked: [], conflicts: [], committed: [] };
        if (["recover_workspace_sessions", "backfill_workspace_session_bindings", "list_agent_models", "get_provider_usage"].includes(command) || command.startsWith("get_git_diff")) return [];
        if (command === "load_ui_states" || command === "load_deleted_ui_state") return {};
        if (command === "read_session_file") return { content: "fixture content", versionToken: "v1", isBinary: false, missing: false };
        if (command === "list_session_directory") return { path: args.relativePath, entries: args.relativePath ? [{ name: "child.ts", path: "src/child.ts", kind: "file" }] : [{ name: "src", path: "src", kind: "dir" }, { name: "a.ts", path: "a.ts", kind: "file" }, { name: "b.ts", path: "b.ts", kind: "file" }] };
        if (command === "observe_agent_sessions") return args.sessions.map((session: any) => ({ sessionId: session.sessionId, available: session.sessionId === "s1", agents: session.sessionId !== "s1" ? [] : [
          { id: "provider-main", name: "Main", parentId: null, status: "running", events: [], task: "Main task", provider: "codex", updatedAt: 1 },
          { id: "a", name: "Ada", parentId: "provider-main", status: "running", events: [], task: "Review", provider: "codex", updatedAt: 1 },
          { id: "b", name: "Babbage", parentId: "provider-main", status: "done", events: [], task: "Tests", provider: "codex", updatedAt: 1 },
          { id: "c", name: "Child", parentId: "a", status: "waiting", events: [], task: "Nested", provider: "codex", updatedAt: 1 },
        ] }));
        return null;
      },
    };
    const workspaces = [{ id: "p1", name: "Project one", path: "C:\\ProjectOne", color: "green", createdAt: 1, order: 0 }, { id: "p2", name: "Project two", path: "C:\\ProjectTwo", color: "blue", createdAt: 2, order: 1 }, { id: "p3", name: "Project three", path: "C:\\ProjectThree", color: "blue", createdAt: 3, order: 2 }];
    const sessions = ["running", "waiting", "done"].map((status, index) => ({ id: `s${index + 1}`, name: `Session ${index + 1}`, workspaceId: "p1", workdir: "C:\\ProjectOne", providerSessionId: index === 0 ? "provider-main" : undefined, status, currentTask: "", createdAt: index + 1, diffFiles: [], output: [], runner: { type: "codex" } }));
    if (!localStorage.getItem("agentdeck-settings")) localStorage.setItem("agentdeck-settings", JSON.stringify({ state: { settings: { locale: "en", theme: "dark", splitWidgetPanelCollapsed: true, runner: { type: "codex" } } }, version: 0 }));
    if (!localStorage.getItem("agentdeck-workspaces")) localStorage.setItem("agentdeck-workspaces", JSON.stringify({ state: { workspaces, activeWorkspaceId: "p1" }, version: 0 }));
    if (!localStorage.getItem("agentdeck-sessions")) localStorage.setItem("agentdeck-sessions", JSON.stringify({ state: { sessions, activeSessionId: "s1" }, version: 0 }));
  });
  await page.goto("/");
  await expect(page.locator('[data-surface="projects"]')).toBeVisible().catch(error => { throw new Error(`${String(error)}\nPage errors: ${errors.join(" | ")}`); });
}

const rowIds = (page: Page, surface: string) => page.locator(`[data-surface="${surface}"] > .ad-sortable-content > .ad-sortable-item`).evaluateAll(elements => elements.map(element => element.getAttribute("data-sortable-id")));

test("persisting a running session never changes its live status", async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const p = "/src/store/sessionStore.ts"; const { useSessionStore } = await import(/* @vite-ignore */ p);
    useSessionStore.setState((state: any) => ({ sessions: state.sessions.map((session: any) => session.id === "s1" ? { ...session, status: "running" } : session) }));
    const immediate = useSessionStore.getState().sessions.find((s: any) => s.id === "s1").status;
    await new Promise(resolve => setTimeout(resolve, 100));
    return { immediate, after: useSessionStore.getState().sessions.find((s: any) => s.id === "s1").status };
  });
  expect(result).toEqual({ immediate: "running", after: "running" });
});

test("filtered and virtual-window moves retain hidden slots, new IDs append, undo is context-local", async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const path = "/src/store/presentationStore.ts";
    const { usePresentationStore: store, applyPresentationOrder, moveVisiblePresentation, presentationKey } = await import(/* @vite-ignore */ path);
    const ids = ["a", "hidden", "b", "virtual-offscreen", "c"];
    const filtered = moveVisiblePresentation(ids, ["a", "b", "c"], "c", "a");
    store.getState().moveItem("test", "context", ids, ["a", "b", "c"], "c", "a");
    const saved = store.getState().layouts[presentationKey("test", "context")].order;
    store.getState().moveItem("test", "context", ["a", "b"], ["a", "b"], "b", "a");
    const backendFiltered = store.getState().layouts[presentationKey("test", "context")].order;
    store.getState().setOrder("test", "other", ["y", "x"]);
    store.getState().undo("test", "context");
    store.getState().undo("test", "context");
    return { filtered, saved, backendFiltered, appended: applyPresentationOrder([...ids, "new"], saved), undone: store.getState().layouts[presentationKey("test", "context")], other: store.getState().layouts[presentationKey("test", "other")].order };
  });
  expect(result.filtered).toEqual(["c", "hidden", "a", "virtual-offscreen", "b"]);
  expect(result.saved).toEqual(result.filtered);
  expect(result.backendFiltered).toEqual(["c", "hidden", "b", "virtual-offscreen", "a"]);
  expect(result.appended).toEqual([...result.filtered, "new"]);
  expect(result.undone).toEqual({});
  expect(result.other).toEqual(["y", "x"]);
});

test("project selection preserves order; keyboard rearrangement survives rename and restart @macos", async ({ page }) => {
  await setup(page);
  const projects = page.locator('[data-surface="projects"]');
  const before = await rowIds(page, "projects");
  await projects.locator('.ad-workspace-select').filter({ hasText: "Project two" }).click();
  expect(await rowIds(page, "projects")).toEqual(before);
  await projects.getByRole("button", { name: "Reorder: Project three", exact: true }).focus();
  await page.keyboard.press("Alt+ArrowUp");
  expect(await rowIds(page, "projects")).toEqual(["p1", "p3", "p2"]);
  await page.evaluate(async () => { const p = "/src/store/workspaceStore.ts"; const { useWorkspaceStore } = await import(/* @vite-ignore */ p); useWorkspaceStore.getState().updateWorkspace("p3", { name: "Renamed third project" }); });
  expect(await rowIds(page, "projects")).toEqual(["p1", "p3", "p2"]);
  await page.reload();
  await expect(projects.getByRole("button", { name: "Reorder: Renamed third project", exact: true })).toBeVisible();
  expect(await rowIds(page, "projects")).toEqual(["p1", "p3", "p2"]);
  await projects.getByRole("button", { name: "Automatic order", exact: true }).click();
  expect(await rowIds(page, "projects")).toEqual(before);
});

test("manual sessions move across statuses and stay fixed during streaming; cancel and undo preserve ownership", async ({ page }) => {
  await setup(page);
  const surface = page.locator('[data-surface="sessions"]');
  const before = await rowIds(page, "sessions");
  const last = surface.getByRole("button", { name: "Reorder: Session 3", exact: true });
  await last.focus(); await page.keyboard.press("Alt+ArrowUp"); await page.keyboard.press("Alt+ArrowUp");
  const arranged = await rowIds(page, "sessions");
  expect(arranged[0]).toBe("s3");
  await page.evaluate(async () => { const p = "/src/store/sessionStore.ts"; const { useSessionStore } = await import(/* @vite-ignore */ p); useSessionStore.getState().updateSession("s3", { status: "running", currentTask: "Streaming now" }); useSessionStore.getState().appendOutput("s1", "streaming fixture"); });
  expect(await rowIds(page, "sessions")).toEqual(arranged);
  await last.focus(); await page.keyboard.press("Space"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Escape");
  expect(await rowIds(page, "sessions")).toEqual(arranged);
  await surface.getByRole("button", { name: "Undo arrangement", exact: true }).click();
  expect(await rowIds(page, "sessions")).not.toEqual(arranged);
  await surface.getByRole("button", { name: "Automatic order", exact: true }).click();
  const identities = await page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-sessions")!).state.sessions.map((s: any) => [s.id, s.workspaceId, s.workdir, s.providerSessionId ?? null]));
  expect(identities).toEqual([["s1", "p1", "C:\\ProjectOne", "provider-main"], ["s2", "p1", "C:\\ProjectOne", null], ["s3", "p1", "C:\\ProjectOne", null]]);
  expect(before).toHaveLength(3);
});

test("map drags use world coordinates under zoom and do not change the native hierarchy", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Agent center", exact: true });
  const handle = dialog.getByRole("button", { name: "Reorder: Ada", exact: true });
  await expect(handle).toBeVisible();
  const card = dialog.locator(".ad-flow-node").filter({ has: page.getByRole("button", { name: "Reorder: Ada", exact: true }) });
  const before = await card.evaluate(element => ({ x: parseFloat((element as HTMLElement).style.left), y: parseFloat((element as HTMLElement).style.top), scale: Number(element.closest('.ad-graph-world')?.getAttribute('data-scale')) }));
  const bounds = (await handle.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 60, bounds.y + bounds.height / 2 + 40, { steps: 8 }); await page.mouse.up();
  const moved = await card.evaluate(element => ({ x: parseFloat((element as HTMLElement).style.left), y: parseFloat((element as HTMLElement).style.top) }));
  expect(moved.x).toBeCloseTo(before.x + 60 / before.scale, 1); expect(moved.y).toBeCloseTo(before.y + 40 / before.scale, 1);
  await dialog.getByRole("button", { name: "List", exact: true }).click();
  const children = dialog.locator('[data-surface="agent-children"]').first();
  await children.getByRole("button", { name: "Reorder: Babbage", exact: true }).focus(); await page.keyboard.press("Alt+ArrowUp");
  await expect(dialog.locator(".ad-monitor-branch .ad-monitor-branch").getByText("Child", { exact: true })).toBeVisible();
  const parents = await page.evaluate(async () => { const p = "/src/store/agentObservabilityStore.ts"; const { useAgentObservabilityStore } = await import(/* @vite-ignore */ p); return useAgentObservabilityStore.getState().observations.s1.agents.map((a: any) => [a.id, a.parentId]); });
  expect(parents).toEqual([["provider-main", null], ["a", "provider-main"], ["b", "provider-main"], ["c", "a"]]);
});

test("editor tab order is visual, keyboard accessible and restored without writing files", async ({ page }) => {
  await setup(page);
  await page.evaluate(async () => { const p = "/src/services/editorCommands.ts"; const { openFile } = await import(/* @vite-ignore */ p); openFile("s1", "a.ts", false); openFile("s1", "b.ts", false); });
  const handle = page.locator('[data-editor-group]').getByRole("button", { name: "Reorder: b.ts", exact: true });
  await expect(handle).toBeVisible(); await handle.focus(); await page.keyboard.press("Alt+ArrowLeft");
  const state = await page.evaluate(async () => { const p = "/src/store/editorStore.ts"; const { useEditorStore } = await import(/* @vite-ignore */ p); return useEditorStore.getState(); });
  const group = Object.values(state.groupsById)[0] as any;
  expect(group.tabIds).toEqual(["code:s1:a.ts", "code:s1:b.ts"]);
  const presentation = await page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-presentation")!).state.layouts);
  expect(presentation[JSON.stringify(["editor-tabs", group.id])].order).toEqual(["code:s1:b.ts", "code:s1:a.ts"]);
  await page.reload();
  await page.evaluate(async () => { const p = "/src/services/editorCommands.ts"; const { openFile } = await import(/* @vite-ignore */ p); openFile("s1", "a.ts", false); });
  await expect(page.locator('[data-editor-group]').getByRole("button", { name: "Reorder: b.ts", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__orderingCalls.filter((c: any) => c.command === "write_session_file"))).toEqual([]);
});

test("cross-group drop uses visual order; undo retains new tabs and dirty buffers without reviving closed tabs", async ({ page }) => {
  await setup(page);
  await page.evaluate(async () => {
    const p = "/src/services/editorCommands.ts"; const { openFile } = await import(/* @vite-ignore */ p);
    openFile("s1", "a.ts", false); openFile("s1", "b.ts", false); openFile("s1", "c.ts", false);
  });
  await expect(page.locator('[data-editor-tab="code:s1:c.ts"]')).toBeVisible();
  await page.evaluate(async () => {
    const e = "/src/store/editorStore.ts", p = "/src/store/presentationStore.ts", b = "/src/store/editorBufferStore.ts";
    const { useEditorStore } = await import(/* @vite-ignore */ e), { usePresentationStore } = await import(/* @vite-ignore */ p), { useEditorBufferStore } = await import(/* @vite-ignore */ b);
    const group = Object.values(useEditorStore.getState().groupsById).find((group: any) => group.tabIds.includes("code:s1:c.ts")) as any;
    useEditorBufferStore.getState().updateDraft("code:s1:c.ts", "valuable unsaved content");
    useEditorStore.getState().splitGroupWithTab(group.id, "code:s1:c.ts", "right");
    usePresentationStore.getState().setOrder("editor-tabs", group.id, ["code:s1:b.ts", "code:s1:a.ts"]);
  });
  const source = page.locator('[data-editor-group]').getByRole("button", { name: "Reorder: c.ts", exact: true });
  const target = page.locator('[data-editor-group]').getByRole("button", { name: "Reorder: b.ts", exact: true });
  await expect(page.locator('[data-editor-group-container]')).toHaveCount(2);
  await expect(source).toBeVisible(); await expect(target).toBeVisible();
  const from = (await source.boundingBox())!, to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 }); await page.mouse.up();
  await expect(page.locator('[data-editor-group-container]')).toHaveCount(1);
  expect(await page.locator('[data-editor-group] [data-editor-tab]').evaluateAll(elements => elements.map(element => element.getAttribute("data-editor-tab")))).toEqual(["code:s1:c.ts", "code:s1:b.ts", "code:s1:a.ts"]);
  await page.evaluate(async () => {
    const e = "/src/store/editorStore.ts"; const { useEditorStore } = await import(/* @vite-ignore */ e);
    useEditorStore.getState().openFile("s1", "new.ts", false);
    useEditorStore.getState().closeTab("code:s1:a.ts");
  });
  await page.getByRole("button", { name: "Undo tab move", exact: true }).click();
  const result = await page.evaluate(async () => {
    const e = "/src/store/editorStore.ts", b = "/src/store/editorBufferStore.ts";
    const { useEditorStore } = await import(/* @vite-ignore */ e), { useEditorBufferStore } = await import(/* @vite-ignore */ b);
    return { tabs: Object.keys(useEditorStore.getState().tabsById).sort(), groups: Object.values(useEditorStore.getState().groupsById).map((group: any) => group.tabIds), draft: useEditorBufferStore.getState().buffersByTabId["code:s1:c.ts"] };
  });
  expect(result.tabs).toEqual(["code:s1:b.ts", "code:s1:c.ts", "code:s1:new.ts"]);
  expect(result.groups).toContainEqual(["code:s1:b.ts", "code:s1:new.ts"]);
  expect(result.groups).toContainEqual(["code:s1:c.ts"]);
  expect(result.draft).toMatchObject({ content: "valuable unsaved content", dirty: true });
  expect(await page.evaluate(() => (window as any).__orderingCalls.filter((call: any) => call.command === "write_session_file"))).toEqual([]);
});
