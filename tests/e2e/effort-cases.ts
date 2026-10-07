import { test, expect, type Page } from "@playwright/test";

/** Reuses the workspace fixture to test the actual UI and both native boundaries. */
export function effortCases(setup: (page: Page) => Promise<void>, openSession: (page: Page) => Promise<void>) {
  const panel = (page: Page) => page.getByRole("dialog", { name: "Esforço e velocidade" });
  const openEffort = async (page: Page) => { await page.getByRole("button", { name: /^Esforço:/ }).filter({ visible: true }).click(); return panel(page); };
  const lastTurn = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_chat_turn").at(-1)?.args.request);

  test("Codex default resolves in the project and every effort is selectable without losing the base level", async ({ page }) => {
    await setup(page); await openSession(page);
    await page.getByRole("button", { name: "OpenAI Codex", exact: true }).click();
    await expect(page.getByLabel("Modelo", { exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "Opções do agente" }).click();
    await expect(page.locator(".ad-model-details")).toContainText("local-codex-model");
    await expect(page.locator(".ad-model-details")).toContainText("0.160.1");
    const probe = await page.evaluate(() => (window as any).__calls.find((c: any) => c.command === "list_agent_models" && c.args.runnerType === "codex"));
    expect(probe.args.workdir).toBe("C:\\Projects\\Test Project");
    await page.keyboard.press("Escape");
    await openEffort(page);
    const effort = panel(page).getByLabel("Esforço", { exact: true });
    for (const level of ["low", "medium", "high", "xhigh", "max", "ultra"]) { await effort.selectOption(level); await expect(effort).toHaveValue(level); }
    await expect(panel(page).getByRole("switch", { name: "Ultra", exact: true })).toBeChecked();
    await panel(page).getByRole("switch", { name: "Ultra", exact: true }).click();
    await expect(effort).toHaveValue("max");
    await effort.selectOption("ultra"); await effort.selectOption("medium");
    await expect(panel(page).getByRole("switch", { name: "Ultra", exact: true })).not.toBeChecked();
    await effort.selectOption("ultra"); await panel(page).getByRole("switch", { name: "Fast" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Abrir agente / entrar", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__ptyReady.length)).toBe(1);
    const launch = await page.evaluate(() => (window as any).__calls.find((c: any) => c.command === "start_pty_session").args);
    expect(launch.args).toEqual(expect.arrayContaining(['model_reasoning_effort="ultra"', 'service_tier="fast"']));
    expect(launch.args).not.toContain("--model");
    expect(await lastTurn(page)).toBeUndefined();
  });

  test("unresolved Codex default stays honest and an explicit model unlocks its capabilities", async ({ page }) => {
    await setup(page); await openSession(page);
    await page.evaluate(() => { (window as any).__codexUnknownDefault = true; });
    await page.getByRole("button", { name: "OpenAI Codex", exact: true }).click();
    await page.getByRole("button", { name: "Opções do agente" }).click();
    await expect(page.locator(".ad-model-details")).toContainText("Versão não verificada");
    await page.keyboard.press("Escape"); await openEffort(page);
    await expect(panel(page).getByRole("switch", { name: "Ultra", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.getByLabel("Modelo", { exact: true }).selectOption("local-lighter-model");
    await openEffort(page);
    const effort = panel(page).getByLabel("Esforço", { exact: true });
    await expect(effort.locator("option")).toHaveCount(5);
    await expect(panel(page).getByRole("switch", { name: "Fast" })).toBeDisabled();
    await effort.selectOption("none"); await effort.selectOption("minimal");
    await page.keyboard.press("Escape");
    await page.locator(".ad-chat-composer textarea:visible").fill("Use minimal reasoning");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect.poll(() => lastTurn(page)).toMatchObject({ effort: "minimal", model: "local-lighter-model", ultraMode: false, fastMode: false });
  });

  test("composer groups primary controls and its options remain usable in a compact window", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await setup(page); await openSession(page);
    const controls = page.locator(".ad-agent-controls:visible");
    await expect(controls.getByLabel("Modo", { exact: true })).toHaveValue("default");
    await expect(controls.getByLabel("Modo", { exact: true }).locator("option:checked")).toHaveText("Executar");
    await controls.getByRole("button", { name: "Opções do agente" }).click();
    const menu = page.getByRole("dialog", { name: "Opções do agente" });
    await expect(menu.getByRole("button", { name: "Atualizar catálogo de modelos" })).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    await expect(menu.getByRole("button", { name: "Gerenciar atualizações dos CLIs" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(menu.getByRole("button", { name: "Fechar opções" })).toBeFocused();
    await page.screenshot({ path: "test-results/composer-options-compact.png", animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(controls.getByRole("button", { name: "Opções do agente" })).toBeFocused();
    expect(await page.locator(".ad-chat-composer:visible").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: "test-results/composer-compact.png", animations: "disabled" });
  });

  test("CLI installer failures show actionable causes and keep retry available", async ({ page }) => {
    await setup(page); await openSession(page);
    await page.getByRole("button", { name: "Opções do agente" }).click();
    await page.getByRole("button", { name: "Gerenciar atualizações dos CLIs" }).click();
    const claude = page.getByRole("region", { name: "Atualizações dos agentes" }).getByRole("article", { name: "Claude Code" });
    for (const [error, message] of [
      ["cli_path_error:exit=1", "interpretar o caminho"],
      ["cli_files_in_use:exit=1", "EPERM/EBUSY"],
      ["cli_disk_full:exit=1", "espaço suficiente"],
      ["cli_certificate_error:exit=1", "certificado"],
      ["network_unavailable:exit=1", "Verifique a conexão"],
      ["cli_command_failed:exit=17", "Código de saída: 17"],
    ]) {
      await page.evaluate(error => { (window as any).__updateFailure = error; }, error);
      await claude.getByRole("button", { name: "Atualizar", exact: true }).click();
      await expect(claude.getByRole("alert")).toContainText(message);
      await expect(claude).toContainText("2.1.287");
      await expect(claude.getByRole("button", { name: "Atualizar", exact: true })).toBeEnabled();
    }
    await page.evaluate(() => { (window as any).__updateFailure = false; });
    await claude.getByRole("button", { name: "Atualizar", exact: true }).click();
    await expect(claude).toContainText("CLI atualizado. Catálogo recarregado.");
    expect(await lastTurn(page)).toBeUndefined();
  });

  test("Claude model versions come from the CLI and the response reports the effective model", async ({ page }) => {
    await setup(page); await openSession(page);
    const picker = page.getByLabel("Modelo", { exact: true });
    await expect(picker.locator("option")).toContainText(["Opus 5.5 (padrão)", "Opus 5.5", "Sonnet 5.5", "Fable 5.1", "Haiku 4.5"]);
    await picker.selectOption("sonnet");
    await page.getByRole("button", { name: "Opções do agente" }).click();
    await expect(page.locator(".ad-model-details")).toContainText("claude-sonnet-5-5");
    await expect(page.locator(".ad-model-details")).toContainText("2.1.287");
    await page.getByRole("button", { name: "Atualizar catálogo de modelos" }).click();
    await expect(picker).toBeEnabled();
    await page.keyboard.press("Escape");
    await picker.selectOption("haiku");
    await openEffort(page);
    await expect(panel(page).getByLabel("Esforço", { exact: true })).toBeDisabled();
    await expect(panel(page).getByRole("switch", { name: "Ultracode" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await picker.selectOption("opus");
    await page.evaluate(() => { (window as any).__catalogueFailure = true; });
    await page.getByRole("button", { name: "Opções do agente" }).click();
    await page.getByRole("button", { name: "Atualizar catálogo de modelos" }).click();
    await expect(page.getByText(/Não foi possível verificar as versões/)).toBeVisible();
    await expect(picker).toHaveValue("opus");
    await page.keyboard.press("Escape");
    expect(await lastTurn(page)).toBeUndefined();
    await page.locator(".ad-chat-composer textarea:visible").fill("Model identity test");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.locator(".ad-chat-heading")).toContainText("claude-opus-5-5");
  });

  test("CLI updates check on startup, report failures and refresh the catalogue after updating", async ({ page }) => {
    await setup(page); await openSession(page);
    await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "check_cli_update").length)).toBe(3);
    await page.getByRole("button", { name: "Opções do agente" }).click();
    await page.getByRole("button", { name: "Gerenciar atualizações dos CLIs" }).click();
    const updates = page.getByRole("region", { name: "Atualizações dos agentes" });
    const claude = updates.getByRole("article", { name: "Claude Code" });
    await expect(claude).toContainText("2.1.287");
    await expect(claude).toContainText("2.1.292");
    await page.evaluate(() => { (window as any).__updateFailure = true; });
    await claude.getByRole("button", { name: "Atualizar", exact: true }).click();
    await expect(claude.getByRole("alert")).toContainText("A atualização falhou");
    await page.evaluate(() => { (window as any).__updateFailure = false; });
    await claude.getByRole("button", { name: "Atualizar", exact: true }).click();
    await expect(claude).toContainText("CLI atualizado. Catálogo recarregado.");
    await expect(claude.getByRole("button", { name: "Atualizar", exact: true })).toBeDisabled();
    await page.screenshot({ path: "test-results/cli-updates.png", animations: "disabled" });
    await page.evaluate(() => { (window as any).__offline = true; });
    await updates.getByRole("button", { name: "Verificar atualizações" }).click();
    await expect(claude.getByRole("alert")).toContainText("registro oficial");
    await expect(claude).toContainText("2.1.292");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Opções do agente" }).click();
    await expect(page.locator(".ad-model-details")).toContainText("2.1.292");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Abrir agente / entrar", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__ptyReady.length)).toBe(1);
    await page.getByRole("tab", { name: "Conversa", exact: true }).click();
    await expect(page.getByRole("button", { name: "Encerrar terminal e conversar" })).toBeVisible();
    await page.getByRole("button", { name: "Opções do agente" }).click();
    await page.getByRole("button", { name: "Gerenciar atualizações dos CLIs" }).click();
    await expect(updates.getByRole("article", { name: "OpenAI Codex" }).getByRole("button", { name: "Atualizar", exact: true })).toBeDisabled();
    await expect(updates).toContainText("Encerre os agentes e terminais abertos");
  });

  test("Claude effort and Ultracode are independent, Fast is opt-in, and selections persist", async ({ page }) => {
    await setup(page); await openSession(page);
    await page.getByLabel("Modelo", { exact: true }).selectOption("opus");
    const options = await openEffort(page);
    await expect(options.getByLabel("Esforço", { exact: true })).toHaveValue("medium");
    await expect(options.getByRole("switch", { name: "Ultracode" })).not.toBeChecked();
    await expect(options.getByRole("switch", { name: "Fast" })).not.toBeChecked();
    await options.getByLabel("Esforço", { exact: true }).selectOption("low");
    await options.getByRole("switch", { name: "Ultracode" }).click();
    await options.getByRole("switch", { name: "Fast" }).click();
    await expect(options.getByLabel("Esforço", { exact: true })).toHaveValue("low");
    await page.screenshot({ path: "test-results/effort-claude.png", animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Esforço: Baixo · Fast" })).toBeFocused();
    await page.evaluate(() => { (window as any).__autoComplete = true; });
    await page.locator(".ad-chat-composer textarea:visible").fill("Use the selected effort");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect.poll(() => lastTurn(page)).toMatchObject({ effort: "low", fastMode: true, ultraMode: true, model: "opus" });
    await expect(page.getByRole("button", { name: "Parar resposta" })).toHaveCount(0);
    await page.reload();
    await page.getByRole("button", { name: /Use the selected effort Claude Code/ }).click();
    const reopen = page.getByTitle("Abrir conversa");
    if (await reopen.count()) await reopen.first().click();
    await expect(page.getByRole("button", { name: "Esforço: Baixo · Fast" })).toBeVisible();
    await openEffort(page);
    await expect(panel(page).getByRole("switch", { name: "Ultracode" })).toBeChecked();
    await panel(page).getByRole("switch", { name: "Ultracode" }).click();
    await panel(page).getByRole("switch", { name: "Fast" }).click();
    await page.keyboard.press("Escape");
    await page.locator(".ad-chat-composer textarea:visible").fill("Continue at low effort");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect.poll(() => lastTurn(page)).toMatchObject({ effort: "low", fastMode: false, ultraMode: false, providerSessionId: "native-chat-session" });
  });

  test("Codex offers only catalogue capabilities and Ultra restores the chosen effort when turned off", async ({ page }) => {
    await setup(page); await openSession(page);
    await page.getByRole("button", { name: "OpenAI Codex", exact: true }).click();
    await openEffort(page);
    await expect(panel(page).getByRole("switch", { name: "Ultra", exact: true })).toBeEnabled();
    await expect(panel(page).getByLabel("Esforço", { exact: true }).locator("option")).toHaveCount(6);
    await panel(page).getByLabel("Esforço", { exact: true }).selectOption("low");
    await panel(page).getByRole("switch", { name: "Ultra", exact: true }).click();
    await panel(page).getByRole("switch", { name: "Fast" }).click();
    await expect(panel(page).getByLabel("Esforço", { exact: true })).toBeEnabled();
    await expect(panel(page).getByLabel("Esforço", { exact: true })).toHaveValue("ultra");
    await page.screenshot({ path: "test-results/effort-codex.png", animations: "disabled" });
    await page.keyboard.press("Escape");
    await page.evaluate(() => { (window as any).__autoComplete = true; });
    await page.locator(".ad-chat-composer textarea:visible").fill("Run with Ultra");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect.poll(() => lastTurn(page)).toMatchObject({ runnerType: "codex", effort: "low", ultraMode: true, fastMode: true });
    await expect(page.getByRole("button", { name: "Parar resposta" })).toHaveCount(0);
    await openEffort(page);
    await panel(page).getByRole("switch", { name: "Ultra", exact: true }).click();
    await expect(panel(page).getByLabel("Esforço", { exact: true })).toBeEnabled();
    await expect(panel(page).getByLabel("Esforço", { exact: true })).toHaveValue("low");
    await panel(page).getByLabel("Esforço", { exact: true }).selectOption("max");
    await page.keyboard.press("Escape");
    await page.getByLabel("Modelo", { exact: true }).selectOption("local-lighter-model");
    await openEffort(page);
    await expect(panel(page).getByLabel("Esforço", { exact: true })).toHaveValue("medium");
    await expect(panel(page).getByRole("switch", { name: "Ultra", exact: true })).toBeDisabled();
    await expect(panel(page).getByRole("switch", { name: "Fast" })).not.toBeChecked();
    await page.keyboard.press("Escape");
    await page.locator(".ad-chat-composer textarea:visible").fill("Continue with the lighter model");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect.poll(() => lastTurn(page)).toMatchObject({ effort: "medium", ultraMode: false, fastMode: false, providerSessionId: "native-chat-session" });
  });

  for (const provider of ["claude-code", "codex"]) test(`${provider}: terminal returns to conversation, preserves draft and resumes after explicit stop`, async ({ page }) => {
    await setup(page); await openSession(page);
    if (provider === "codex") {
      await page.getByRole("button", { name: "OpenAI Codex", exact: true }).click();
      await page.getByLabel("Modelo", { exact: true }).selectOption("local-codex-model");
    }
    await openEffort(page);
    await panel(page).getByLabel("Esforço", { exact: true }).selectOption("low");
    await page.keyboard.press("Escape");
    const prompt = page.locator(".ad-chat-composer textarea:visible");
    await prompt.fill("Keep my draft");
    await page.getByRole("button", { name: "Abrir agente / entrar", exact: true }).click();
    const launches = () => page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_pty_session"));
    await expect.poll(async () => (await launches()).length).toBe(1);
    const launch = (await launches())[0].args;
    expect(launch.args).toEqual(expect.arrayContaining(provider === "codex" ? ['model_reasoning_effort="low"', 'service_tier="default"'] : ["--effort", "low", '{"fastMode":false,"ultracode":false}']));
    await page.evaluate(provider => (window as any).__emit("provider-session-bound", { session_id: "session", runner_type: provider, provider_session_id: "terminal-native-session" }), provider);
    await page.getByRole("tab", { name: "Conversa", exact: true }).click();
    await expect(prompt).toHaveValue("Keep my draft");
    await expect(page.getByRole("button", { name: "Enviar", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "stop_pty_session"))).toHaveLength(0);
    await page.getByRole("tab", { name: "Terminal nativo", exact: true }).click();
    await expect(page.locator(".xterm:visible")).toBeVisible();
    expect(await launches()).toHaveLength(1);
    await page.getByRole("tab", { name: "Conversa", exact: true }).click();
    await page.getByRole("button", { name: "Encerrar terminal e conversar" }).click();
    await expect(page.getByRole("button", { name: "Enviar", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect.poll(() => lastTurn(page)).toMatchObject({ prompt: "Keep my draft", providerSessionId: "terminal-native-session", effort: "low", ultraMode: false, fastMode: false });
  });

  test("returning while terminal starts waits for shutdown and surfaces stop failures", async ({ page }) => {
    await setup(page); await openSession(page);
    await page.locator(".ad-chat-composer textarea:visible").fill("Draft during native startup");
    await page.evaluate(() => { (window as any).__ptyStartDelay = 1500; (window as any).__failStop = true; });
    await page.getByRole("button", { name: "Abrir agente / entrar", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__calls.some((c: any) => c.command === "start_pty_session"))).toBe(true);
    await page.getByRole("tab", { name: "Conversa", exact: true }).click();
    await page.getByRole("button", { name: "Encerrar terminal e conversar" }).click();
    await expect(page.getByRole("button", { name: "Encerrando terminal…" })).toBeDisabled();
    await expect(page.getByRole("alert").filter({ hasText: "native stop failed" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Enviar", exact: true })).toBeDisabled();
    await page.evaluate(() => { (window as any).__failStop = false; });
    await page.getByRole("button", { name: "Encerrar terminal e conversar" }).click();
    await expect(page.getByRole("button", { name: "Enviar", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect.poll(() => lastTurn(page)).toMatchObject({ effort: "medium", fastMode: false, ultraMode: false });
  });

  test("native effort can change after stopping and restart receives the new controls", async ({ page }) => {
    await setup(page); await openSession(page);
    await page.getByRole("button", { name: "Abrir agente / entrar", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__ptyReady.length)).toBe(1);
    await openEffort(page);
    await expect(panel(page).getByLabel("Esforço", { exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.locator(".ad-session-toolbar").getByRole("button", { name: "Encerrar processo do agente" }).click();
    await expect(page.getByRole("button", { name: "Reiniciar", exact: true })).toBeVisible();
    await openEffort(page);
    await panel(page).getByLabel("Esforço", { exact: true }).selectOption("low");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Reiniciar", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_pty_session").length)).toBe(2);
    const launch = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_pty_session").at(-1).args);
    expect(launch.args).toEqual(expect.arrayContaining(["--effort", "low"]));
    expect(launch.env).toContainEqual(["CLAUDE_CODE_EFFORT_LEVEL", "low"]);
  });
}
