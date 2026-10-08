import { expect, test, type Page } from "@playwright/test";

/** Synthetic worktrees only: native list/remove/teardown never touch disk. */
async function setupRecovery(page: Page, dirtySession = false) {
  await page.addInitScript(({ dirtySession }) => {
    const w = window as any;
    let nextId = 0;
    w.__recoveryCalls = [];
    w.__recoveryListFailure = false;
    w.__recoveryRemoveFailure = false;
    w.__recoveryRows = [
      { path: "C:\\Worktrees\\clean-session", branch: "ci/clean", head: "1".repeat(40), reason: "clean", canRemove: true },
      { path: "C:\\Worktrees\\dirty-session", branch: "ci/dirty", head: "2".repeat(40), reason: "dirty", canRemove: false },
      { path: "C:\\Worktrees\\locked-session", branch: "ci/locked", head: "3".repeat(40), reason: "locked", canRemove: false },
      { path: "C:\\Worktrees\\active-session", branch: "ci/active", head: "4".repeat(40), reason: "in_use", canRemove: false },
      { path: "C:\\Worktrees\\unavailable-session", branch: "ci/unavailable", head: "5".repeat(40), reason: "unavailable", canRemove: false },
    ];
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "popup" }, currentWebview: { label: "popup" } },
      transformCallback: () => ++nextId, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        w.__recoveryCalls.push({ command, args });
        if (command === "list_recoverable_worktrees") {
          if (w.__recoveryListFailure) throw new Error("QA worktree list unavailable");
          return w.__recoveryRows.map((row: any) => ({ ...row }));
        }
        if (command === "remove_recoverable_worktree") {
          if (w.__recoveryRemoveFailure) throw new Error("QA worktree changed; local files were preserved");
          const row = w.__recoveryRows.find((row: any) => row.path === args.worktreePath);
          if (!row || !row.canRemove || row.head !== args.expectedHead) throw new Error("QA worktree state no longer permits cleanup");
          w.__recoveryRows = w.__recoveryRows.filter((row: any) => row.path !== args.worktreePath);
          return;
        }
        if (command === "teardown_session_worktree") throw new Error("QA local files preserved after removing the project");
        if (command === "pick_folder") return "C:\\Projects\\Recovery";
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
    if (!localStorage.getItem("agentdeck-settings")) {
      localStorage.setItem("agentdeck-settings", JSON.stringify({ state: { settings: { locale: "pt-BR", theme: "dark", splitPaneSidebarWidth: 380, splitWidgetPanelCollapsed: true, runner: { type: "codex" } } }, version: 0 }));
      localStorage.setItem("agentdeck-workspaces", JSON.stringify({ state: { workspaces: [{ id: "recovery-project", name: "Recovery project", path: "C:\\Projects\\Recovery", color: "green", createdAt: 1, order: 0 }], activeWorkspaceId: "recovery-project" }, version: 0 }));
      const sessionPath = dirtySession ? "C:\\Worktrees\\dirty-session" : "C:\\Worktrees\\active-session";
      localStorage.setItem("agentdeck-sessions", JSON.stringify({ state: { sessions: [{ id: "recovery-session", name: "Recovery session", workspaceId: "recovery-project", workdir: sessionPath, worktreePath: sessionPath, branchName: dirtySession ? "ci/dirty" : "ci/active", status: "idle", currentTask: "", createdAt: 1, diffFiles: [], output: [], runner: { type: "codex" } }], activeSessionId: "recovery-session" }, version: 0 }));
    }
  }, { dirtySession });
  await page.goto("/");
}

async function openRecovery(page: Page) {
  await page.getByRole("button", { name: /^Worktrees preservados(?: \(\d+\))?$/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "Worktrees preservados", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Repositório", exact: true })).toHaveValue("C:\\Projects\\Recovery");
  return dialog;
}

test("worktree cleanup requires explicit confirmation and cancellation does not delete anything", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentdeck-worktree-recovery", JSON.stringify({ state: {
    repositories: ["c:/projects/recovery/"], notices: [{ workdir: "c:/projects/recovery/", path: "C:/WORKTREES/clean-session/", message: "Preserved before restart" }],
  }, version: 0 })));
  await setupRecovery(page);
  const dialog = await openRecovery(page);
  await expect(dialog.locator("summary")).toContainText("C:/WORKTREES/clean-session/");
  await expect(dialog.getByRole("combobox", { name: "Repositório", exact: true }).locator("option")).toHaveCount(2);
  const clean = dialog.getByRole("article").filter({ hasText: "C:\\Worktrees\\clean-session" });
  await clean.getByRole("button", { name: "Limpar worktree", exact: true }).click();
  await expect(clean).toContainText("C:\\Worktrees\\clean-session");
  await expect(clean.getByRole("button", { name: "Confirmar limpeza", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__recoveryCalls.filter((call: any) => call.command === "remove_recoverable_worktree"))).toHaveLength(0);
  await clean.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(clean.getByRole("button", { name: "Confirmar limpeza", exact: true })).toHaveCount(0);
  await clean.getByRole("button", { name: "Limpar worktree", exact: true }).click();
  await clean.getByRole("button", { name: "Confirmar limpeza", exact: true }).click();
  await expect(clean).toHaveCount(0);
  await expect(dialog.locator("summary")).toHaveCount(0);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-worktree-recovery") ?? "{}").state);
  expect(saved.notices).toEqual([]);
  expect(saved.repositories).toHaveLength(1);
  const removals = await page.evaluate(() => (window as any).__recoveryCalls.filter((call: any) => call.command === "remove_recoverable_worktree"));
  expect(removals).toHaveLength(1);
  expect(removals[0].args).toMatchObject({ workdir: "C:\\Projects\\Recovery", worktreePath: "C:\\Worktrees\\clean-session", expectedHead: "1".repeat(40) });
  expect(await page.evaluate(() => (window as any).__recoveryCalls.some((call: any) => call.command === "git_worktree_remove" || call.command === "prune_orphan_worktrees"))).toBe(false);
});

test("dirty, locked, active and unavailable worktrees explain why cleanup is disabled", async ({ page }) => {
  await setupRecovery(page);
  const dialog = await openRecovery(page);
  const reasons = [
    ["dirty-session", /arquivos|alteraç/i],
    ["locked-session", /bloquead|travado/i],
    ["active-session", /em uso|ativa|ativo/i],
    ["unavailable-session", /indisponível|verificar/i],
  ] as const;
  for (const [name, explanation] of reasons) {
    const row = dialog.getByRole("article").filter({ hasText: `C:\\Worktrees\\${name}` });
    await expect(row.getByRole("button", { name: "Limpar worktree", exact: true })).toBeDisabled();
    await expect(row).toContainText(explanation);
    await expect(row.getByRole("button", { name: "Copiar caminho", exact: true })).toBeEnabled();
  }
  expect(await page.evaluate(() => (window as any).__recoveryCalls.filter((call: any) => call.command === "remove_recoverable_worktree"))).toHaveLength(0);
});

test("worktree list and cleanup failures preserve the entry and allow an explicit retry", async ({ page }) => {
  await setupRecovery(page);
  await page.evaluate(() => { (window as any).__recoveryListFailure = true; });
  const dialog = await openRecovery(page);
  await expect(dialog.getByRole("alert")).toContainText("QA worktree list unavailable");
  await page.evaluate(() => { (window as any).__recoveryListFailure = false; });
  await dialog.getByRole("button", { name: "Atualizar", exact: true }).click();
  const clean = dialog.getByRole("article").filter({ hasText: "C:\\Worktrees\\clean-session" });
  await expect(clean).toBeVisible();
  await page.evaluate(() => { (window as any).__recoveryRemoveFailure = true; });
  await clean.getByRole("button", { name: "Limpar worktree", exact: true }).click();
  await clean.getByRole("button", { name: "Confirmar limpeza", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("QA worktree changed; local files were preserved");
  await expect(clean).toBeVisible();
  await page.evaluate(() => { (window as any).__recoveryRemoveFailure = false; });
  await dialog.getByRole("button", { name: "Atualizar", exact: true }).click();
  await clean.getByRole("button", { name: "Limpar worktree", exact: true }).click();
  await clean.getByRole("button", { name: "Confirmar limpeza", exact: true }).click();
  await expect(clean).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__recoveryCalls.filter((call: any) => call.command === "remove_recoverable_worktree"))).toHaveLength(2);
});

test("preserved worktrees stay discoverable after the last project is removed and the app reloads", async ({ page }) => {
  await setupRecovery(page, true);
  await page.getByTitle("Remover projeto", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("agentdeck-worktree-recovery") ?? "{}");
    return saved.state?.notices?.some((notice: any) => notice.path === "C:\\Worktrees\\dirty-session") ?? false;
  })).toBe(true);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-workspaces") ?? "{}").state.workspaces)).toHaveLength(0);
  await expect(page.getByRole("status").filter({ hasText: "Há pastas de sessões preservadas" })).toBeVisible();
  await page.reload();
  const dialog = await openRecovery(page);
  const dirty = dialog.getByRole("article").filter({ hasText: "C:\\Worktrees\\dirty-session" });
  await expect(dirty).toBeVisible();
  await expect(dirty.getByRole("button", { name: "Limpar worktree", exact: true })).toBeDisabled();
  await dialog.locator("summary").filter({ hasText: "C:\\Worktrees\\dirty-session" }).click();
  await expect(dialog.getByText("QA local files preserved after removing the project", { exact: false })).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-worktree-recovery") ?? "{}").state);
  expect(saved.repositories).toContain("C:\\Projects\\Recovery");
  expect(saved.notices.some((notice: any) => notice.path === "C:\\Worktrees\\dirty-session")).toBe(true);
});
