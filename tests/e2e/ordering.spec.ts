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

test("collection label text can move while its checkbox keeps native selection", async ({ page }) => {
  await setup(page);
  await page.evaluate(async () => {
    const fixture = "/tests/e2e/fixtures/SortableLabels.tsx";
    (await import(/* @vite-ignore */ fixture)).mountSortableLabels();
  });
  const list = page.getByTestId("sortable-labels-fixture");
  const source = (await list.getByText("Beta collection", { exact: true }).boundingBox())!;
  const target = (await list.getByText("Alpha collection", { exact: true }).boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2); await page.mouse.down();
  await page.waitForTimeout(220);
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 }); await page.mouse.up();
  await expect.poll(() => list.locator("[data-sortable-id]").evaluateAll(rows => rows.map(row => row.getAttribute("data-sortable-id")))).toEqual(["b", "a"]);
  await expect(list.getByRole("checkbox", { name: "Beta collection", exact: true })).not.toBeChecked();
  const checkbox = list.getByRole("checkbox", { name: "Alpha collection", exact: true });
  const bounds = (await checkbox.boundingBox())!;
  await page.waitForTimeout(100);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
  await page.waitForTimeout(220);
  await expect(list.locator('[data-sortable-id="a"]')).toHaveAttribute("data-dragging", "false");
  await page.mouse.up();
  await expect(checkbox).toBeChecked();
});

test("holding the project body reorders without grips, preserves a normal click and cancels with Escape", async ({ page }) => {
  await setup(page);
  const projects = page.locator('[data-surface="projects"]');
  await expect(page.locator(".ad-reorder-handle, .lucide-grip-vertical, .ad-flow-drag-handle")).toHaveCount(0);
  const source = projects.locator('[data-sortable-id="p3"] .ad-workspace-select');
  const target = projects.locator('[data-sortable-id="p2"] .ad-workspace-select');
  const from = (await source.boundingBox())!, to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down(); await page.waitForTimeout(220);
  await expect(projects.locator('[data-sortable-id="p3"]')).toHaveAttribute("data-dragging", "true");
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 }); await page.mouse.up();
  await expect.poll(() => rowIds(page, "projects")).toEqual(["p3", "p2"]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-workspaces")!).state.activeWorkspaceId)).toBe("p1");
  await page.waitForTimeout(100);
  await projects.locator('.ad-workspace-select').filter({ hasText: "Project two" }).click();
  expect(await rowIds(page, "projects")).toEqual(["p3", "p2"]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-workspaces")!).state.activeWorkspaceId)).toBe("p2");
  const first = (await source.boundingBox())!, last = (await projects.locator('[data-sortable-id="p2"] .ad-workspace-select').boundingBox())!;
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down(); await page.waitForTimeout(220);
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, { steps: 10 });
  await page.keyboard.press("Escape"); await page.mouse.up();
  expect(await rowIds(page, "projects")).toEqual(["p3", "p2"]);
});

test("action buttons cannot start a drag and movement before the hold threshold preserves the order", async ({ page }) => {
  await setup(page);
  const projects = page.locator('[data-surface="projects"]');
  const row = projects.locator('[data-sortable-id="p2"]');
  const remove = row.getByTitle("Delete workspace", { exact: true });
  const action = (await remove.boundingBox())!;
  await page.mouse.move(action.x + action.width / 2, action.y + action.height / 2);
  await page.mouse.down(); await page.waitForTimeout(220);
  await expect(row).toHaveAttribute("data-dragging", "false");
  await page.mouse.move(action.x - 90, action.y + 60, { steps: 6 }); await page.mouse.up();
  expect(await rowIds(page, "projects")).toEqual(["p2", "p3"]);
  const label = (await row.locator(".ad-workspace-select").boundingBox())!;
  await page.mouse.move(label.x + 20, label.y + label.height / 2); await page.mouse.down();
  await page.mouse.move(label.x + 90, label.y + 70, { steps: 6 }); await page.mouse.up();
  expect(await rowIds(page, "projects")).toEqual(["p2", "p3"]);
});

test("the conversation body can move without selecting or changing its provider binding", async ({ page }) => {
  await setup(page);
  const sessions = page.locator('[data-surface="sessions"]');
  const source = (await sessions.locator('[data-sortable-id="s3"] [data-drag-primary]').boundingBox())!;
  const target = (await sessions.locator(".ad-sortable-item").first().boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2); await page.mouse.down();
  await page.waitForTimeout(220);
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await rowIds(page, "sessions"))[0]).toBe("s3");
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-sessions")!).state);
  expect(state.activeSessionId).toBe("s1");
  expect(state.sessions.find((session: any) => session.id === "s1").providerSessionId).toBe("provider-main");
});

test("sidebar can reach half of a wide viewport, remembers its preference and stays within half after resizing", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await setup(page);
  const sidebar = page.getByTestId("workbench-sidebar");
  const resize = page.getByRole("separator", { name: "Drag to resize sidebar", exact: true });
  const handle = (await resize.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.evaluate(() => {
    for (const type of ["pointermove", "pointerup", "pointercancel"]) window.dispatchEvent(new PointerEvent(type, { pointerId: 99, clientX: 0, bubbles: true }));
  });
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(320);
  await page.mouse.move(1300, handle.y + handle.height / 2, { steps: 12 }); await page.mouse.up();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(800);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-settings")!).state.settings.splitPaneSidebarWidth)).toBe(800);
  await page.reload(); await expect(sidebar).toBeVisible();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(800);
  await page.setViewportSize({ width: 1000, height: 720 });
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(500);
  await page.setViewportSize({ width: 500, height: 720 });
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(250);
  await page.screenshot({ path: testInfo.outputPath("sidebar-half-width-narrow.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(800);
  await resize.focus(); await page.keyboard.press("Home");
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(280);
  await page.keyboard.press("End");
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(800);
  const after = (await resize.boundingBox())!;
  await page.mouse.move(after.x + after.width / 2, after.y + after.height / 2); await page.mouse.down();
  await page.mouse.move(400, after.y + after.height / 2, { steps: 8 });
  await page.keyboard.press("Escape"); await page.mouse.up();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(800);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-settings")!).state.settings.splitPaneSidebarWidth)).toBe(800);
  await page.screenshot({ path: testInfo.outputPath("sidebar-half-width-no-grips.png"), animations: "disabled" });
});

test("a single item hides unneeded ordering controls while an available undo remains accessible", async ({ page }) => {
  await setup(page);
  const projects = page.locator('[data-surface="projects"]');
  await page.evaluate(async () => {
    const path = "/src/store/workspaceStore.ts";
    const { useWorkspaceStore } = await import(/* @vite-ignore */ path);
    useWorkspaceStore.setState((state: any) => ({ workspaces: state.workspaces.slice(1, 2) }));
  });
  await expect(projects.locator(".ad-sortable-item")).toHaveCount(1);
  await expect(page.getByLabel("Display density")).toHaveCount(0);
  await expect(projects.getByRole("button", { name: "Automatic order", exact: true })).toHaveCount(0);
  await expect(projects.getByRole("button", { name: "Undo arrangement", exact: true })).toHaveCount(0);
  await page.evaluate(async () => {
    const path = "/src/store/presentationStore.ts";
    const { usePresentationStore } = await import(/* @vite-ignore */ path);
    usePresentationStore.getState().setOrder("projects", "navigation", ["p2"]);
  });
  await expect(projects.getByRole("button", { name: "Undo arrangement", exact: true })).toBeEnabled();
});

test("projects group themselves by attention, running work and recent activity", async ({ page }) => {
  await setup(page);
  const groups = page.locator(".ad-project-groups");
  await page.evaluate(async () => {
    const sessions = "/src/store/sessionStore.ts", workspaces = "/src/store/workspaceStore.ts", attention = "/src/store/attentionStore.ts";
    const { useSessionStore } = await import(/* @vite-ignore */ sessions);
    const { useWorkspaceStore } = await import(/* @vite-ignore */ workspaces);
    const { useAttentionStore } = await import(/* @vite-ignore */ attention);
    useSessionStore.setState((state: any) => ({ sessions: [...state.sessions, { ...state.sessions[2], id: "s4", name: "Session 4", workspaceId: "p2", workdir: "C:\\ProjectTwo", status: "idle", createdAt: 4 }] }));
    useAttentionStore.getState().record({ id: "qa-approval", sessionId: "s4", kind: "approval", text: "Approve", source: "provider", at: Date.now() });
    useWorkspaceStore.getState().touchWorkspace("p3");
  });
  await expect(groups.locator(".ad-project-group-header")).toHaveText([/Waiting for you\s*1/, /Running\s*1/, /Recent\s*1/]);
  await expect(groups.locator('[data-group="attention"]')).toContainText("Project two");
  await expect(groups.locator('[data-group="attention"]')).toContainText("Approval needed");
  await expect(groups.locator('[data-group="running"] .ad-workspace-card')).toHaveAttribute("data-state", "running");
  await expect(groups.locator('[data-group="running"]')).toContainText("Project one");
  await expect(groups.locator('[data-group="recent"]')).toContainText("Last activity");
  // Automatic groups follow activity; only stale projects keep a manual arrangement.
  await expect(page.locator('[data-surface="projects"]')).toHaveCount(0);
  const recent = groups.locator('[data-group="recent"] .ad-project-group-header');
  await recent.click();
  await expect(recent).toHaveAttribute("aria-expanded", "false");
  await expect(groups.locator('[data-group="recent"]')).not.toContainText("Project three");
  await page.reload();
  await expect(groups.locator('[data-group="recent"] .ad-project-group-header')).toHaveAttribute("aria-expanded", "false");
});

test("touch scrolling over project rows keeps their order and does not require a grip", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Touch input uses Chromium's native input boundary.");
  await setup(page);
  await page.evaluate(async () => {
    const path = "/src/store/workspaceStore.ts";
    const { useWorkspaceStore } = await import(/* @vite-ignore */ path);
    useWorkspaceStore.setState((state: any) => ({ workspaces: [...state.workspaces, ...Array.from({ length: 9 }, (_, index) => ({ ...state.workspaces[0], id: `more-${index}`, name: `Extra project ${index}`, order: index + 3 }))] }));
  });
  const projects = page.locator(".ad-project-groups");
  const before = await rowIds(page, "projects"), bounds = (await projects.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height - 20;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 7; step++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - step * 15 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => projects.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await rowIds(page, "projects")).toEqual(before);
  await cdp.detach();
});

test("a deliberate touch hold moves the project body while a short touch remains a click", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Touch input uses Chromium's native input boundary.");
  await setup(page);
  const projects = page.locator('[data-surface="projects"]');
  const source = (await projects.locator('[data-sortable-id="p3"] .ad-workspace-select').boundingBox())!;
  const target = (await projects.locator('[data-sortable-id="p2"] .ad-workspace-select').boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  const x = source.x + source.width / 2, y = source.y + source.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(320);
  await expect(projects.locator('[data-sortable-id="p3"]')).toHaveAttribute("data-dragging", "true");
  for (let step = 1; step <= 8; step++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (target.y + target.height / 2 - y) * step / 8 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => rowIds(page, "projects")).toEqual(["p3", "p2"]);
  const second = (await projects.locator('[data-sortable-id="p2"] .ad-workspace-select').boundingBox())!;
  await page.waitForTimeout(100);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: second.x + second.width / 2, y: second.y + second.height / 2 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-workspaces")!).state.activeWorkspaceId)).toBe("p2");
  expect(await rowIds(page, "projects")).toEqual(["p3", "p2"]);
  await cdp.detach();
});

test("selecting editor text after holding never drags its group", async ({ page }) => {
  await setup(page);
  await page.evaluate(async () => {
    const path = "/src/services/editorCommands.ts", editor = "/src/store/editorStore.ts";
    const { openFile } = await import(/* @vite-ignore */ path);
    openFile("s1", "a.ts", false); openFile("s1", "b.ts", false);
    const { useEditorStore } = await import(/* @vite-ignore */ editor);
    const group = Object.values(useEditorStore.getState().groupsById)[0] as any;
    useEditorStore.getState().splitGroupWithTab(group.id, "code:s1:b.ts", "right");
  });
  const line = page.locator(".cm-line").filter({ hasText: "fixture content" }).first();
  await expect(line).toBeVisible();
  const bounds = (await line.boundingBox())!;
  await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2); await page.mouse.down();
  await page.waitForTimeout(240);
  await page.mouse.move(bounds.x + 80, bounds.y + bounds.height / 2, { steps: 8 }); await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);
  await expect(page.locator('[data-editor-group-container][data-dragging="true"]')).toHaveCount(0);
});

test("the editor close action remains a button and cannot move its tab", async ({ page }) => {
  await setup(page);
  await page.evaluate(async () => {
    const path = "/src/services/editorCommands.ts";
    const { openFile } = await import(/* @vite-ignore */ path);
    openFile("s1", "a.ts", false); openFile("s1", "b.ts", false);
  });
  const row = page.locator('[data-editor-tab="code:s1:b.ts"]');
  await row.hover();
  const close = row.getByTitle("Close b.ts", { exact: true }), bounds = (await close.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
  await page.waitForTimeout(220);
  await expect(row).toHaveAttribute("data-dragging", "false");
  await page.mouse.move(bounds.x - 100, bounds.y + 40, { steps: 6 }); await page.mouse.up();
  await expect(page.locator('[data-editor-tab="code:s1:b.ts"]')).toBeVisible();
  await row.hover(); await close.click();
  await expect(page.locator('[data-editor-tab="code:s1:b.ts"]')).toHaveCount(0);
});

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
  await projects.getByRole("group", { name: "Reorder: Project three", exact: true }).focus();
  await page.keyboard.press("Alt+ArrowUp");
  expect(await rowIds(page, "projects")).toEqual(["p3", "p2"]);
  await page.evaluate(async () => { const p = "/src/store/workspaceStore.ts"; const { useWorkspaceStore } = await import(/* @vite-ignore */ p); useWorkspaceStore.getState().updateWorkspace("p3", { name: "Renamed third project" }); });
  expect(await rowIds(page, "projects")).toEqual(["p3", "p2"]);
  await page.reload();
  await expect(projects.getByRole("group", { name: "Reorder: Renamed third project", exact: true })).toBeVisible();
  // A restart ends the running session, so its project rejoins the arranged group in its saved slot.
  expect(await rowIds(page, "projects")).toEqual(["p1", "p3", "p2"]);
  await projects.getByRole("button", { name: "Automatic order", exact: true }).click();
  expect(await rowIds(page, "projects")).toEqual(["p1", ...before]);
});

test("manual sessions move across statuses and stay fixed during streaming; cancel and undo preserve ownership", async ({ page }) => {
  await setup(page);
  const surface = page.locator('[data-surface="sessions"]');
  const before = await rowIds(page, "sessions");
  const last = surface.getByRole("group", { name: "Reorder: Session 3", exact: true });
  await last.focus(); await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => rowIds(page, "sessions")).toEqual(["s2", "s3", "s1"]);
  const preceding = await rowIds(page, "sessions");
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => rowIds(page, "sessions")).toEqual(["s3", "s2", "s1"]);
  const arranged = await rowIds(page, "sessions");
  expect(arranged[0]).toBe("s3");
  await page.evaluate(async () => { const p = "/src/store/sessionStore.ts"; const { useSessionStore } = await import(/* @vite-ignore */ p); useSessionStore.getState().updateSession("s3", { status: "running", currentTask: "Streaming now" }); useSessionStore.getState().appendOutput("s1", "streaming fixture"); });
  expect(await rowIds(page, "sessions")).toEqual(arranged);
  await last.focus(); await page.keyboard.press("Space");
  await expect(last).toHaveAttribute("data-dragging", "true");
  await expect(surface).toHaveAttribute("data-arranging", "true");
  // KeyboardSensor publishes drag start before installing its key listener in
  // the next task. Complete that task before sending the movement/cancel keys.
  await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  await page.keyboard.press("ArrowDown");
  await expect(surface.locator('[data-sortable-id="s2"]')).toHaveAttribute("data-drop-target", "true");
  await page.keyboard.press("Escape");
  await expect(last).toHaveAttribute("data-dragging", "false");
  await expect(surface).toHaveAttribute("data-arranging", "false");
  expect(await rowIds(page, "sessions")).toEqual(arranged);
  await surface.getByRole("button", { name: "Undo arrangement", exact: true }).click();
  await expect.poll(() => rowIds(page, "sessions")).toEqual(preceding);
  await surface.getByRole("button", { name: "Automatic order", exact: true }).click();
  const identities = await page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-sessions")!).state.sessions.map((s: any) => [s.id, s.workspaceId, s.workdir, s.providerSessionId ?? null]));
  expect(identities).toEqual([["s1", "p1", "C:\\ProjectOne", "provider-main"], ["s2", "p1", "C:\\ProjectOne", null], ["s3", "p1", "C:\\ProjectOne", null]]);
  expect(before).toHaveLength(3);
});

test("map drags use world coordinates under zoom and do not change the native hierarchy", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Agent center", exact: true });
  const handle = dialog.getByRole("group", { name: "Reorder: Ada", exact: true });
  await dialog.getByRole("combobox", { name: "Go to agent", exact: true }).selectOption("s1:a");
  await dialog.getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect(handle).toBeVisible();
  const card = handle;
  const before = await card.evaluate(element => ({ x: parseFloat((element as HTMLElement).style.left), y: parseFloat((element as HTMLElement).style.top), scale: Number(element.closest('.ad-graph-world')?.getAttribute('data-scale')) }));
  const bounds = (await handle.locator(".ad-flow-agent-card").boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down(); await page.waitForTimeout(220); await page.mouse.move(bounds.x + bounds.width / 2 + 60, bounds.y + bounds.height / 2 + 40, { steps: 8 }); await page.mouse.up();
  const moved = await card.evaluate(element => ({ x: parseFloat((element as HTMLElement).style.left), y: parseFloat((element as HTMLElement).style.top) }));
  expect(moved.x).toBeCloseTo(before.x + 60 / before.scale, 1); expect(moved.y).toBeCloseTo(before.y + 40 / before.scale, 1);
  await dialog.getByRole("button", { name: "List", exact: true }).click();
  const children = dialog.locator('[data-surface="agent-children"]').first();
  await children.getByRole("group", { name: "Reorder: Babbage", exact: true }).focus(); await page.keyboard.press("Alt+ArrowUp");
  await expect(dialog.locator(".ad-monitor-branch .ad-monitor-branch").getByText("Child", { exact: true })).toBeVisible();
  const parents = await page.evaluate(async () => { const p = "/src/store/agentObservabilityStore.ts"; const { useAgentObservabilityStore } = await import(/* @vite-ignore */ p); return useAgentObservabilityStore.getState().observations.s1.agents.map((a: any) => [a.id, a.parentId]); });
  expect(parents).toEqual([["provider-main", null], ["a", "provider-main"], ["b", "provider-main"], ["c", "a"]]);
});

test("editor tab order is visual, keyboard accessible and restored without writing files", async ({ page }) => {
  await setup(page);
  await page.evaluate(async () => { const p = "/src/services/editorCommands.ts"; const { openFile } = await import(/* @vite-ignore */ p); openFile("s1", "a.ts", false); openFile("s1", "b.ts", false); });
  const handle = page.locator('[data-editor-group]').getByRole("group", { name: "Reorder: b.ts", exact: true });
  await expect(handle).toBeVisible(); await handle.focus(); await page.keyboard.press("Alt+ArrowLeft");
  const state = await page.evaluate(async () => { const p = "/src/store/editorStore.ts"; const { useEditorStore } = await import(/* @vite-ignore */ p); return useEditorStore.getState(); });
  const group = Object.values(state.groupsById)[0] as any;
  expect(group.tabIds).toEqual(["code:s1:a.ts", "code:s1:b.ts"]);
  const presentation = await page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-presentation")!).state.layouts);
  expect(presentation[JSON.stringify(["editor-tabs", group.id])].order).toEqual(["code:s1:b.ts", "code:s1:a.ts"]);
  await page.reload();
  await page.evaluate(async () => { const p = "/src/services/editorCommands.ts"; const { openFile } = await import(/* @vite-ignore */ p); openFile("s1", "a.ts", false); });
  await expect(page.locator('[data-editor-group]').getByRole("group", { name: "Reorder: b.ts", exact: true })).toBeVisible();
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
  const source = page.locator('[data-editor-group]').getByRole("group", { name: "Reorder: c.ts", exact: true });
  const target = page.locator('[data-editor-group]').getByRole("group", { name: "Reorder: b.ts", exact: true });
  await expect(page.locator('[data-editor-group-container]')).toHaveCount(2);
  await expect(source).toBeVisible(); await expect(target).toBeVisible();
  const from = (await source.boundingBox())!, to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down(); await page.waitForTimeout(220);
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
