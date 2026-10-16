import { expect, test, type Page } from "@playwright/test";

const projectPath = "C:\\Projects\\Space saver";
const isolatedPath = "C:\\Worktrees\\session-101";

/** Synthetic native boundary: this suite never creates folders or runs a provider. */
async function setup(page: Page, locale = "pt-BR") {
  await page.addInitScript(({ locale, projectPath, isolatedPath }) => {
    const w = window as any;
    let callback = 0;
    w.__directoryCalls = [];
    w.__isolationFailure = false;
    w.__isolationUnavailable = false;
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "popup" }, currentWebview: { label: "popup" } },
      transformCallback: () => ++callback, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        w.__directoryCalls.push({ command, args });
        if (command === "reserve_session_id") return "101";
        if (command === "setup_session_worktree") {
          if (w.__isolationFailure) throw new Error("QA isolation failed");
          if (w.__isolationUnavailable) return null;
          const result = { worktree_path: isolatedPath, branch: "ci/qa/session-101", base_branch: "main" };
          if (w.__delayIsolation) return new Promise(resolve => { w.__finishPreparation = () => resolve(result); });
          return result;
        }
        if (command === "remember_session_workdir" && w.__delayRemember) return new Promise<void>(resolve => { w.__finishPreparation = () => resolve(); });
        if (command === "plugin:event|listen") return ++callback;
        if (command === "plugin:window|is_maximized") return false;
        if (command === "plugin:window|scale_factor") return 1;
        if (command === "plugin:window|outer_size") return { width: 1360, height: 900 };
        if (command === "plugin:window|outer_position") return { x: 0, y: 0 };
        if (command === "check_cli") return true;
        if (command === "get_git_status") return { staged: [], unstaged: [], untracked: [], conflicts: [], committed: [] };
        if (["recover_workspace_sessions", "backfill_workspace_session_bindings", "list_agent_models", "get_provider_usage", "observe_agent_sessions"].includes(command) || command.startsWith("get_git_diff")) return [];
        if (command === "load_ui_states" || command === "load_deleted_ui_state") return {};
        return null;
      },
    };
    if (!localStorage.getItem("agentdeck-settings")) {
      localStorage.setItem("agentdeck-settings", JSON.stringify({ state: { settings: { locale, theme: "dark", splitPaneSidebarWidth: 380, splitWidgetPanelCollapsed: true, runner: { type: "codex" } } }, version: 0 }));
      localStorage.setItem("agentdeck-workspaces", JSON.stringify({ state: { workspaces: [{ id: "space-project", name: "Space saver", path: projectPath, color: "green", createdAt: 1, order: 0 }], activeWorkspaceId: "space-project" }, version: 0 }));
      localStorage.setItem("agentdeck-sessions", JSON.stringify({ state: { sessions: [], activeSessionId: null }, version: 0 }));
    }
  }, { locale, projectPath, isolatedPath });
  await page.goto("/");
  await expect(page.getByTestId("new-session-sidebar")).toBeVisible();
  await expect(page.getByTestId("new-session-welcome")).toBeVisible();
}

async function sessions(page: Page) {
  return page.evaluate(async () => {
    const modulePath = "/src/store/sessionStore.ts";
    return (await import(/* @vite-ignore */ modulePath)).useSessionStore.getState().sessions;
  });
}

for (const surface of ["sidebar", "welcome"]) {
  test(`${surface}: new conversations use the project by default without creating a worktree`, async ({ page }) => {
    await setup(page);
    const control = page.getByTestId(`new-session-${surface}`);
    await expect(control.getByLabel("Pasta da nova conversa")).toHaveValue("project");
    await expect(control.getByLabel("Pasta da nova conversa")).toHaveAccessibleDescription(/As conversas compartilham os arquivos/);
    await control.getByRole("button", { name: surface === "sidebar" ? "+ Nova sessão" : "Novo", exact: true }).click();
    await expect.poll(async () => (await sessions(page)).length).toBe(1);
    expect((await sessions(page))[0]).toMatchObject({ id: "101", workdir: projectPath });
    expect((await sessions(page))[0].worktreePath).toBeUndefined();
    const calls = await page.evaluate(() => (window as any).__directoryCalls);
    expect(calls.filter((call: any) => call.command === "setup_session_worktree")).toEqual([]);
    expect(calls.find((call: any) => call.command === "remember_session_workdir").args.workdir).toBe(projectPath);
  });

  test(`${surface}: explicit isolation prepares and uses a separate folder`, async ({ page }) => {
    await setup(page);
    const control = page.getByTestId(`new-session-${surface}`);
    await control.getByLabel("Pasta da nova conversa").selectOption("worktree");
    await expect(control.getByLabel("Pasta da nova conversa")).toHaveAccessibleDescription(/Dependências e builds podem ocupar espaço extra/);
    await control.getByRole("button", { name: surface === "sidebar" ? "+ Nova sessão" : "Novo", exact: true }).click();
    await expect.poll(async () => (await sessions(page)).length).toBe(1);
    expect((await sessions(page))[0]).toMatchObject({ workdir: isolatedPath, worktreePath: isolatedPath, branchName: "ci/qa/session-101", baseBranch: "main" });
    const calls = await page.evaluate(() => (window as any).__directoryCalls);
    expect(calls.filter((call: any) => call.command === "setup_session_worktree")).toEqual([{ command: "setup_session_worktree", args: { workdir: projectPath, sessionId: "101" } }]);
    expect(calls.find((call: any) => call.command === "remember_session_workdir").args.workdir).toBe(isolatedPath);
  });

  test(`${surface}: isolation failure shows an error and never creates a shared conversation`, async ({ page }) => {
    await setup(page);
    const control = page.getByTestId(`new-session-${surface}`);
    await control.getByLabel("Pasta da nova conversa").selectOption("worktree");
    await page.evaluate(() => { (window as any).__isolationFailure = true; });
    await control.getByRole("button", { name: surface === "sidebar" ? "+ Nova sessão" : "Novo", exact: true }).click();
    await expect(control.getByRole("alert")).toContainText("QA isolation failed");
    expect(await sessions(page)).toEqual([]);
    expect(await page.evaluate(() => (window as any).__directoryCalls.some((call: any) => ["remember_session_workdir", "start_chat_turn", "start_pty_session"].includes(call.command)))).toBe(false);
  });
}

test("the selected folder preference is shared by both entry points, survives reload and leaves existing sessions intact", async ({ page }) => {
  await setup(page);
  const sidebar = page.getByTestId("new-session-sidebar");
  await sidebar.getByLabel("Pasta da nova conversa").selectOption("worktree");
  await expect(page.getByTestId("new-session-welcome").getByLabel("Pasta da nova conversa")).toHaveValue("worktree");
  await page.reload();
  await expect(sidebar.getByLabel("Pasta da nova conversa")).toHaveValue("worktree");
  await page.evaluate(async ({ isolatedPath }) => {
    const modulePath = "/src/store/sessionStore.ts";
    const store = (await import(/* @vite-ignore */ modulePath)).useSessionStore;
    store.getState().addSession("old", "space-project", isolatedPath, "Existing isolated conversation", { type: "codex" });
    store.getState().updateSession("old", { worktreePath: isolatedPath, branchName: "ci/existing", baseBranch: "main" });
  }, { isolatedPath });
  await sidebar.getByLabel("Pasta da nova conversa").selectOption("project");
  expect((await sessions(page)).find((session: any) => session.id === "old")).toMatchObject({ workdir: isolatedPath, worktreePath: isolatedPath, branchName: "ci/existing" });
});

test("a non-Git folder cannot silently substitute the project for requested isolation", async ({ page }) => {
  await setup(page);
  const sidebar = page.getByTestId("new-session-sidebar");
  await sidebar.getByLabel("Pasta da nova conversa").selectOption("worktree");
  await page.evaluate(() => { (window as any).__isolationUnavailable = true; });
  await sidebar.getByRole("button", { name: "+ Nova sessão", exact: true }).click();
  await expect(sidebar.getByRole("alert")).toContainText("repositório Git com uma branch ativa");
  expect(await sessions(page)).toEqual([]);
});

for (const step of ["isolation", "remember"]) {
  test(`removing the project during ${step} preparation preserves its worktree without publishing an orphan session`, async ({ page }) => {
    await setup(page);
    const sidebar = page.getByTestId("new-session-sidebar");
    await sidebar.getByLabel("Pasta da nova conversa").selectOption("worktree");
    await page.evaluate(step => {
      const w = window as any;
      if (step === "isolation") w.__delayIsolation = true;
      else w.__delayRemember = true;
    }, step);
    await sidebar.getByRole("button", { name: "+ Nova sessão", exact: true }).click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__finishPreparation)).toBe("function");
    await page.getByTitle("Remover projeto", { exact: true }).click();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-workspaces")!).state.workspaces.length)).toBe(0);
    await page.evaluate(() => (window as any).__finishPreparation());
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-worktree-recovery") ?? "{}").state?.notices?.length ?? 0)).toBe(1);
    expect(await sessions(page)).toEqual([]);
    const notice = await page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-worktree-recovery")!).state.notices[0]);
    expect(notice).toMatchObject({ workdir: projectPath, path: isolatedPath });
    expect(notice.message).toContain("preservado para revisão");
    const calls = await page.evaluate(() => (window as any).__directoryCalls);
    expect(calls.some((call: any) => ["teardown_session_worktree", "start_chat_turn", "start_pty_session"].includes(call.command))).toBe(false);
    if (step === "remember") await expect.poll(() => page.evaluate(() => (window as any).__directoryCalls.filter((call: any) => call.command === "remove_session_workdir").length)).toBe(1);
  });
}

for (const [locale, label, project, isolated] of [
  ["en-US", "New conversation folder", "Use project folder", "Create isolated worktree"],
  ["es-ES", "Carpeta de la nueva conversación", "Usar carpeta del proyecto", "Crear worktree aislado"],
]) {
  test(`folder choices are readable in ${locale}`, async ({ page }) => {
    await setup(page, locale);
    const field = page.getByTestId("new-session-sidebar").getByLabel(label);
    await expect(field).toHaveValue("project");
    await expect(field.getByRole("option", { name: project, exact: true })).toHaveCount(1);
    await expect(field.getByRole("option", { name: isolated, exact: true })).toHaveCount(1);
  });
}
