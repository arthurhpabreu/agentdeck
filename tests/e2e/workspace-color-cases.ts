import { test, expect, type Page } from "@playwright/test";

export function workspaceColorCases(setup: (page: Page, locale?: string) => Promise<void>) {
  test("project colors support presets, validated custom colors and saved edits", async ({ page }) => {
    await setup(page);
    await page.getByRole("button", { name: "+ Adicionar", exact: true }).click();
    const form = page.getByRole("form", { name: "Abrir projeto", exact: true });
    await expect(form.getByRole("group", { name: "Cores sugeridas" }).getByRole("button")).toHaveCount(18);
    await form.getByLabel("Nome (opcional)", { exact: true }).fill("Color project");
    await form.getByRole("textbox", { name: "Pasta", exact: true }).fill("C:\\Projects\\Colors");
    const hex = form.getByRole("textbox", { name: "Código HEX da cor", exact: true });
    await hex.fill("#oops");
    await expect(hex).toHaveAttribute("aria-invalid", "true");
    await expect(form.getByRole("button", { name: "Criar", exact: true })).toBeDisabled();
    await hex.fill("#1A9B8C");
    await form.getByRole("button", { name: "Criar", exact: true }).click();
    const readColor = () => page.evaluate(() => JSON.parse(localStorage.getItem("agentdeck-workspaces")!).state.workspaces.find((item: any) => item.name === "Color project")?.color);
    await expect.poll(readColor).toBe("#1a9b8c");
    const trigger = page.getByRole("button", { name: "Cor de Color project", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Cor de Color project", exact: true });
    await dialog.getByRole("button", { name: "Ciano", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
    expect(await readColor()).toBe("#1a9b8c");
    await trigger.press("Enter");
    await dialog.getByRole("textbox", { name: "Código HEX da cor", exact: true }).fill("#bad");
    await expect(dialog.getByRole("button", { name: "Salvar", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "Ciano", exact: true }).click();
    await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect.poll(readColor).toBe("cyan");
    await page.reload(); await trigger.click();
    await expect(dialog.getByRole("textbox", { name: "Código HEX da cor", exact: true })).toHaveValue("#06b6d4");
    await expect(dialog.getByRole("button", { name: "Ciano", exact: true })).toHaveAttribute("aria-pressed", "true");
    await dialog.screenshot({ path: "test-results/project-colors-dark.png" });
    await page.evaluate(async () => { const path = "/src/store/settingsStore.ts"; (await import(/* @vite-ignore */ path)).useSettingsStore.getState().patchSettings({ theme: "light" }); });
    await dialog.screenshot({ path: "test-results/project-colors-light.png" });
  });

  test("settings switches are keyboard operable and expose their state", async ({ page }) => {
    await setup(page);
    await page.getByRole("button", { name: "Configurações", exact: true }).click();
    await page.getByRole("button", { name: "Componentes", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "Abrir painel do terminal", exact: true });
    await expect(toggle).not.toBeChecked();
    await toggle.focus(); await page.keyboard.press("Space");
    await expect(toggle).toBeChecked();
    await page.keyboard.press("Enter"); await expect(toggle).not.toBeChecked();
  });
}
