import { test, expect, type Page } from "@playwright/test";

export function appUpdateCases(setup: (page: Page, locale?: string) => Promise<void>) {
  async function prepare(page: Page, overrides: Record<string, unknown> = {}) {
    await page.addInitScript(overrides => {
      const w = window as any;
      w.__appUpdateResult = { installed: "0.6.1", latest: "0.6.2", updateAvailable: true, supported: true, installerKind: "exe", ...overrides };
    }, overrides);
    await setup(page);
  }
  const panel = (page: Page) => page.getByRole("region", { name: "Atualizações do Agent Deck", exact: true });
  const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__calls.filter((c: any) => c.command === command), command);
  async function openSettings(page: Page) {
    await page.getByRole("button", { name: "Configurações", exact: true }).click();
    await page.getByRole("button", { name: "Sistema", exact: true }).click();
  }
  test("app update checks once at startup and a badge downloads without launching the installer", async ({ page }) => {
    await prepare(page);
    const badge = page.getByRole("button", { name: "Nova versão do Agent Deck 0.6.2", exact: true });
    await expect(badge).toBeVisible();
    expect(await calls(page, "check_app_update")).toHaveLength(1);
    expect(await calls(page, "download_app_update")).toHaveLength(0);
    await badge.click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole("status")).toContainText("Download verificado");
    expect(await calls(page, "download_app_update")).toHaveLength(1);
    expect(await calls(page, "install_app_update")).toHaveLength(0);
    await page.evaluate(async () => {
      const path = "/src/store/chatStore.ts";
      const store = (await import(/* @vite-ignore */ path)).useChatStore;
      store.getState().patch("session", { busy: true });
    });
    await expect(panel(page).getByRole("button", { name: "Instalar atualização", exact: true })).toBeDisabled();
    await page.evaluate(async () => {
      const path = "/src/store/chatStore.ts";
      (await import(/* @vite-ignore */ path)).useChatStore.getState().patch("session", { busy: false });
    });
    await panel(page).getByRole("button", { name: "Instalar atualização", exact: true }).click();
    await expect(panel(page).getByRole("status")).toContainText("Instalador aberto");
    expect(await calls(page, "install_app_update")).toHaveLength(1);
    expect((await calls(page, "install_app_update"))[0].args).toEqual({});
    await expect(panel(page).getByRole("button", { name: "Instalar atualização", exact: true })).toBeDisabled();
  });
  test("up-to-date and offline startup do not advertise an update and manual retry recovers", async ({ page }) => {
    await prepare(page, { latest: "0.6.1", updateAvailable: false });
    await expect.poll(async () => (await calls(page, "check_app_update")).length).toBe(1);
    await expect(page.locator(".ad-app-update-indicator")).toHaveCount(0);
    await openSettings(page);
    await expect(panel(page).getByRole("status")).toContainText("Agent Deck atualizado");
    await page.evaluate(() => { (window as any).__appUpdateCheckFail = true; });
    await panel(page).getByRole("button", { name: "Verificar nova versão", exact: true }).click();
    await expect(panel(page).getByRole("alert")).toContainText("Verifique sua conexão");
    await page.evaluate(() => { (window as any).__appUpdateCheckFail = false; });
    await panel(page).getByRole("button", { name: "Verificar nova versão", exact: true }).click();
    await expect(panel(page).getByRole("alert")).toHaveCount(0);
    expect(await calls(page, "download_app_update")).toHaveLength(0);
  });
  test("failed integrity verification never enables installation and a new download can be retried", async ({ page }) => {
    await prepare(page, { installerKind: "msi" });
    await page.evaluate(() => { (window as any).__appUpdateDownloadFail = true; });
    await page.getByRole("button", { name: "Nova versão do Agent Deck 0.6.2", exact: true }).click();
    await expect(panel(page).getByRole("alert")).toContainText("não passou na verificação");
    await expect(panel(page).getByRole("button", { name: "Instalar atualização", exact: true })).toHaveCount(0);
    await page.evaluate(() => { (window as any).__appUpdateDownloadFail = false; });
    await panel(page).getByRole("button", { name: "Baixar atualização", exact: true }).click();
    await expect(panel(page).getByRole("status")).toContainText("Download verificado");
    await page.evaluate(() => { (window as any).__appUpdateInstallFail = true; });
    await panel(page).getByRole("button", { name: "Instalar atualização", exact: true }).click();
    await expect(panel(page).getByRole("alert")).toContainText("não passou na verificação");
    await expect(panel(page).getByRole("button", { name: "Baixar atualização", exact: true })).toBeEnabled();
  });
  test("unsupported platforms keep download disabled and the official release link remains available", async ({ page }) => {
    await prepare(page, { supported: false });
    await openSettings(page);
    await expect(page.locator(".ad-app-update-indicator")).toHaveCount(0);
    await expect(panel(page).getByRole("status")).toContainText("Windows x64");
    await expect(panel(page).getByRole("button", { name: "Baixar atualização", exact: true })).toBeDisabled();
    await expect(panel(page).getByRole("button", { name: "Abrir releases oficiais", exact: true })).toBeEnabled();
    expect(await calls(page, "download_app_update")).toHaveLength(0);
  });
}
