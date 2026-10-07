import { expect, test, type Page } from "@playwright/test";

type FixtureMode = "unknown" | "ready" | "stale";

async function setupUsage(page: Page, mode: FixtureMode = "unknown", theme = "dark") {
  await page.addInitScript(({ mode, theme }) => {
    const w = window as any;
    const callbacks = new Map<number, Function>();
    const listeners = new Map<string, Map<number, number>>();
    let callbackId = 0;
    w.__usageReads = 0;
    w.__usageFail = false;
    const now = Math.floor(Date.now() / 1000);
    const observation = new Date((mode === "stale" ? now - 3600 : now) * 1000).toISOString();
    w.__usage = [
      { provider: "codex", status: mode === "unknown" ? "unavailable" : "ready", reason: mode === "unknown" ? "unavailable" : null, source: "codex-rollout", observed_at: mode === "unknown" ? null : observation,
        windows: mode === "unknown" ? [] : [
          { key: "session", used_percent: 22, window_minutes: 300, resets_at: now + 3600 },
          { key: "weekly", used_percent: 42.5, window_minutes: 10080, resets_at: mode === "stale" ? now - 10 : now + 86400 },
        ] },
      { provider: "claude-code", status: mode === "unknown" ? "unavailable" : "ready", reason: mode === "unknown" ? "unavailable" : null, source: "claude-oauth", observed_at: mode === "unknown" ? null : observation,
        windows: mode === "unknown" ? [] : [
          { key: "session", used_percent: 100, window_minutes: 300, resets_at: now + 3600 },
          { key: "weekly", used_percent: 85, window_minutes: 10080, resets_at: now + 86400 },
        ] },
    ];
    w.__emitUsage = () => { for (const [id, callback] of listeners.get("provider-usage-updated") ?? []) callbacks.get(callback)?.({ event: "provider-usage-updated", id, payload: null }); };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "popup" }, currentWebview: { label: "popup" } },
      transformCallback: (callback: Function) => { callbacks.set(++callbackId, callback); return callbackId; },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command === "get_provider_usage") { w.__usageReads += 1; if (w.__usageFail) throw new Error("test-read-error"); return JSON.parse(JSON.stringify(w.__usage)); }
        if (command === "plugin:event|listen") { if (!listeners.has(args.event)) listeners.set(args.event, new Map()); listeners.get(args.event)!.set(++callbackId, args.handler); return callbackId; }
        if (command === "plugin:event|unlisten") { listeners.get(args.event)?.delete(args.eventId); return; }
        if (command === "plugin:window|is_maximized") return false;
        if (command === "plugin:window|scale_factor") return 1;
        if (command === "plugin:window|outer_size") return { width: 1360, height: 900 };
        if (command === "plugin:window|outer_position") return { x: 0, y: 0 };
        if (command === "load_ui_states" || command === "load_deleted_ui_state") return {};
        if (command === "recover_workspace_sessions" || command === "backfill_workspace_session_bindings" || command.startsWith("get_git_diff") || command === "list_agent_models") return [];
        if (command === "get_git_status") return { staged: [], unstaged: [], untracked: [], conflicts: [], committed: [] };
        if (command === "check_cli") return true;
        return null;
      },
    };
    localStorage.setItem("agentdeck-settings", JSON.stringify({ state: { settings: { locale: "pt-BR", theme, splitPaneSidebarWidth: 300, splitWidgetPanelCollapsed: true, runner: { type: "claude-code" } } }, version: 0 }));
    localStorage.setItem("agentdeck-workspaces", JSON.stringify({ state: { workspaces: [], activeWorkspaceId: null }, version: 0 }));
    localStorage.setItem("agentdeck-sessions", JSON.stringify({ state: { sessions: [], activeSessionId: null }, version: 0 }));
  }, { mode, theme });
  await page.goto("/");
  await expect(page.getByTestId("provider-usage-bar")).toBeVisible();
}

test("both providers remain visible with an honest empty state and no fabricated windows", async ({ page }) => {
  await setupUsage(page);
  const footer = page.getByTestId("provider-usage-bar");
  for (const provider of ["codex", "claude-code"]) {
    const summary = footer.locator(`[data-provider="${provider}"]`);
    await expect(summary.getByText("Sem leitura", { exact: true })).toBeVisible();
    await expect(summary.getByText("Semanal", { exact: true })).toHaveCount(0);
    await expect(summary.getByText("Mensal", { exact: true })).toHaveCount(0);
    await expect(summary.locator("b")).toHaveCount(0);
    await expect(summary.locator("svg")).toHaveCount(1);
  }
  const box = await footer.boundingBox();
  expect(box!.y + box!.height).toBeGreaterThan(870);
  expect(box!.y + box!.height).toBeLessThanOrEqual(900);
  await footer.locator('[data-provider="claude-code"]').click();
  const dialog = page.getByRole("dialog", { name: "Claude · Uso da assinatura" });
  await expect(dialog.getByText("Nenhuma medição de limites foi recebida ainda.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("progressbar")).toHaveCount(0);
  await expect(dialog.getByText(/Limites ausentes não representam saldo zero/)).toBeVisible();
});

test("reported windows show utilization, reset dates and refresh via the native event", async ({ page }) => {
  await setupUsage(page, "ready");
  const footer = page.getByTestId("provider-usage-bar");
  await expect(footer.locator('[data-provider="codex"]')).toContainText("42,5%");
  await expect(footer.locator('[data-provider="claude-code"]')).toContainText("85%");
  await footer.locator('[data-provider="codex"]').click();
  const dialog = page.getByRole("dialog", { name: "Codex · Uso da assinatura" });
  await expect(dialog.getByRole("progressbar", { name: "Codex Semanal" })).toHaveAttribute("aria-valuenow", "42.5");
  await expect(dialog.getByText(/Renova em/).first()).toBeVisible();
  await expect(dialog.getByText("57,5% disponível")).toBeVisible();
  await page.evaluate(() => { const w = window as any; w.__usage[0].windows[1].used_percent = 57; w.__emitUsage(); });
  await expect(dialog.getByRole("progressbar", { name: "Codex Semanal" })).toHaveAttribute("aria-valuenow", "57");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(footer.locator('[data-provider="codex"]')).toBeFocused();
  const readsBefore = await page.evaluate(() => (window as any).__usageReads);
  await footer.getByRole("button", { name: "Atualizar limites", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__usageReads)).toBeGreaterThan(readsBefore);
});

test("old and expired readings stay identified, and a refresh error preserves the last real value", async ({ page }) => {
  await setupUsage(page, "stale");
  const footer = page.getByTestId("provider-usage-bar");
  await footer.locator('[data-provider="codex"]').click();
  const dialog = page.getByRole("dialog", { name: "Codex · Uso da assinatura" });
  await expect(dialog.locator(".usage-state")).toHaveText("Última leitura");
  await expect(dialog.getByText("Aguardando nova leitura", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("progressbar", { name: "Codex Semanal" })).toHaveAttribute("aria-valuetext", /Última leitura/);
  await page.evaluate(() => { (window as any).__usageFail = true; });
  await dialog.getByRole("button", { name: "Atualizar limites", exact: true }).click();
  await expect(dialog.locator(".usage-state")).toHaveText("Falha na leitura");
  await expect(dialog.getByRole("progressbar", { name: "Codex Semanal" })).toHaveAttribute("aria-valuenow", "42.5");
  await expect(dialog.getByText("Não foi possível ler os limites. Tente atualizar novamente.")).toBeVisible();
});

test("footer and details fit a smaller light window", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 720 });
  await setupUsage(page, "ready", "light");
  const footer = page.getByTestId("provider-usage-bar");
  await expect(footer.locator('[data-provider="claude-code"]')).toBeVisible();
  await footer.locator('[data-provider="claude-code"]').click();
  const dialog = page.getByRole("dialog", { name: "Claude · Uso da assinatura" });
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1000);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  await expect(dialog.getByRole("progressbar", { name: "Claude 5 horas" })).toHaveAttribute("aria-valuenow", "100");
  await expect(dialog.getByRole("progressbar", { name: "Claude Semanal" })).toHaveAttribute("aria-valuenow", "85");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Claude account fixture shows five-hour and weekly readings without a monthly placeholder", async ({ page }) => {
  await setupUsage(page, "ready");
  const footer = page.getByTestId("provider-usage-bar");
  const summary = footer.locator('[data-provider="claude-code"]');
  await expect(summary.locator("b")).toHaveText(["100%", "85%"]);
  await expect(summary.getByText("5 horas", { exact: true })).toBeVisible();
  await expect(summary.getByText("Semanal", { exact: true })).toBeVisible();
  await expect(summary.getByText("Mensal", { exact: true })).toHaveCount(0);
  await summary.click();
  const dialog = page.getByRole("dialog", { name: "Claude · Uso da assinatura" });
  await expect(dialog.locator(".usage-state")).toHaveText("Sincronizado");
  await expect(dialog.getByRole("progressbar")).toHaveCount(2);
  await expect(dialog.getByText("Conta Claude", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Última consulta", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Uma janela mensal só aparece quando o provedor a informa.")).toBeVisible();
  // Representative fixture screenshot; live service validation is a separate native test.
  await expect(dialog).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "test-results/claude-usage-fixed.png", animations: "disabled" });
});

test("monthly subscription, extra usage and spend appear only when actually reported", async ({ page }) => {
  await setupUsage(page, "ready");
  const footer = page.getByTestId("provider-usage-bar");
  await page.evaluate(() => {
    const w = window as any;
    w.__usage[0].windows.push({ key: "monthly", used_percent: 30, window_minutes: null, resets_at: null });
    w.__usage[1].windows.push({ key: "monthly-extra", used_percent: 65, window_minutes: null, resets_at: null }, { key: "monthly-spend", used_percent: 12, window_minutes: null, resets_at: null });
    w.__emitUsage();
  });
  await expect(footer.locator('[data-provider="codex"]').getByText("Mensal", { exact: true })).toBeVisible();
  await expect(footer.locator('[data-provider="claude-code"]').getByText("Extra mensal", { exact: true })).toBeVisible();
  await expect(footer.locator('[data-provider="claude-code"]').getByText("Gasto mensal", { exact: true })).toBeVisible();
  await footer.locator('[data-provider="claude-code"]').click();
  const dialog = page.getByRole("dialog", { name: "Claude · Uso da assinatura" });
  await expect(dialog.getByRole("progressbar", { name: "Claude Extra mensal" })).toHaveAttribute("aria-valuenow", "65");
  await expect(dialog.getByRole("progressbar", { name: "Claude Gasto mensal" })).toHaveAttribute("aria-valuenow", "12");
});

test("sign-in failures explain the cause and empty responses clear the previous account reading", async ({ page }) => {
  await setupUsage(page, "ready");
  const summary = page.getByTestId("provider-usage-bar").locator('[data-provider="claude-code"]');
  await expect(summary.locator("b")).toHaveText(["100%", "85%"]);
  await page.evaluate(() => {
    const w = window as any;
    w.__usage[1] = { provider: "claude-code", status: "unavailable", reason: "missing-login", source: "claude-oauth", observed_at: null, windows: [] };
    w.__emitUsage();
  });
  await expect(summary.getByText("Login necessário", { exact: true })).toBeVisible();
  await expect(summary.locator("b")).toHaveCount(0);
  await summary.click();
  const dialog = page.getByRole("dialog", { name: "Claude · Uso da assinatura" });
  await expect(dialog.getByRole("progressbar")).toHaveCount(0);
  await expect(dialog.getByText("Entre no cliente oficial neste computador e atualize os limites novamente.")).toBeVisible();
  await page.evaluate(() => { const w = window as any; w.__usage[1].reason = "expired-login"; w.__emitUsage(); });
  await expect(dialog.getByText("O login do cliente oficial expirou. Entre novamente no cliente e atualize os limites.")).toBeVisible();
  await page.evaluate(() => { const w = window as any; w.__usage[1].reason = "authentication"; w.__usage[1].status = "error"; w.__emitUsage(); });
  await expect(dialog.getByText("O provedor não aceitou o login disponível. Confirme sua conta no cliente oficial e tente novamente.")).toBeVisible();
  await expect(summary.locator("b")).toHaveCount(0);
});

test("provider errors retain only backend-provided readings and make the failed update visible", async ({ page }) => {
  await setupUsage(page, "ready");
  const summary = page.getByTestId("provider-usage-bar").locator('[data-provider="claude-code"]');
  await page.evaluate(() => { const w = window as any; w.__usage[1].status = "error"; w.__usage[1].reason = "network"; w.__emitUsage(); });
  await expect(summary.getByText("Falha na leitura", { exact: true })).toBeVisible();
  await expect(summary.locator("b")).toHaveText(["100%", "85%"]);
  await summary.click();
  const dialog = page.getByRole("dialog", { name: "Claude · Uso da assinatura" });
  await expect(dialog.getByText("Não foi possível conectar ao provedor. Verifique a conexão e tente atualizar novamente.")).toBeVisible();
  await expect(dialog.getByText("Exibindo a última medição recebida; a atualização não foi concluída.")).toBeVisible();
  await expect(dialog.getByRole("progressbar", { name: "Claude Semanal" })).toHaveAttribute("aria-valuetext", /Última leitura/);
  // A valid empty response may represent a different account; never restore old windows.
  await page.evaluate(() => { const w = window as any; w.__usage[1].windows = []; w.__usage[1].observed_at = null; w.__emitUsage(); });
  await expect(summary.locator("b")).toHaveCount(0);
  await expect(dialog.getByRole("progressbar")).toHaveCount(0);
});

test("provider cooldown shows retry time and blocks its detail refresh until the deadline", async ({ page }) => {
  await setupUsage(page, "ready");
  const footer = page.getByTestId("provider-usage-bar");
  await page.evaluate(() => {
    const w = window as any;
    w.__usage[1].status = "error";
    w.__usage[1].reason = "rate-limited";
    w.__usage[1].retry_at = Math.floor(Date.now() / 1000) + 90;
    w.__emitUsage();
  });
  const summary = footer.locator('[data-provider="claude-code"]');
  await expect(summary.getByText("Aguardando provedor", { exact: true })).toBeVisible();
  await summary.click();
  const dialog = page.getByRole("dialog", { name: "Claude · Uso da assinatura" });
  await expect(dialog.getByTestId("usage-retry")).toContainText("Nova consulta após");
  await expect(dialog.getByTestId("usage-retry")).toContainText(/Aguarde 1:/);
  await expect(dialog.getByRole("button", { name: "Atualizar limites", exact: true })).toBeDisabled();
  await expect(footer.locator(":scope > .usage-refresh")).toBeEnabled();
  await page.evaluate(() => { const w = window as any; w.__usage[1].retry_at = Math.floor(Date.now() / 1000) - 1; w.__emitUsage(); });
  await expect(dialog.getByText("Uma nova tentativa já pode ser feita.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Atualizar limites", exact: true })).toBeEnabled();
});

test("malformed provider timestamps cannot crash the persistent footer", async ({ page }) => {
  await setupUsage(page, "ready");
  await page.evaluate(() => {
    const w = window as any;
    w.__usage[1].windows[0].resets_at = 18446744073709551615;
    w.__usage[1].windows[1].resets_at = -1;
    w.__usage[1].observed_at = "18446744073709551615";
    w.__usage[1].retry_at = 18446744073709551615;
    w.__emitUsage();
  });
  const summary = page.getByTestId("provider-usage-bar").locator('[data-provider="claude-code"]');
  await expect(summary.locator("b")).toHaveText(["100%", "85%"]);
  await summary.click();
  const dialog = page.getByRole("dialog", { name: "Claude · Uso da assinatura" });
  await expect(dialog.getByRole("progressbar")).toHaveCount(2);
  await expect(dialog.getByTestId("usage-retry")).toHaveCount(0);
  await expect(dialog.getByText(/Renova em/)).toHaveCount(0);
  await expect(dialog.locator(".usage-state")).toHaveText("Última leitura");
});
