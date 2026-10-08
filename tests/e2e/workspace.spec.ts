import { test, expect, type Page } from "@playwright/test";
import { effortCases } from "./effort-cases";
import { commandCases } from "./command-cases";
import { sessionNameCases } from "./session-name-cases";
import { appUpdateCases } from "./app-update-cases";
import { compactionCases } from "./compaction-cases";
import { chatActivityCases } from "./chat-activity-cases";
import { chatReliabilityCases } from "./chat-reliability-cases";
import { workspaceColorCases } from "./workspace-color-cases";

effortCases(setup, openSession);
commandCases(setup);
sessionNameCases(setup, openSession);
appUpdateCases(setup);
compactionCases(setup, openSession);
chatActivityCases(setup, openSession);
chatReliabilityCases(setup, openSession);
workspaceColorCases(setup);

test("titlebar CLI indicator opens update management and follows confirmed results", async ({ page }) => {
  await setup(page);
  const badge = page.locator(".ad-titlebar").getByRole("button", { name: "3 atualizações dos CLIs", exact: true });
  await expect(badge).toBeVisible();
  await badge.click();
  const updates = page.getByRole("region", { name: "Atualizações dos agentes", exact: true });
  await expect(updates).toBeVisible();
  await updates.getByRole("article", { name: "Claude Code", exact: true }).getByRole("button", { name: "Atualizar", exact: true }).click();
  await expect(page.locator(".ad-titlebar").getByRole("button", { name: "2 atualizações dos CLIs", exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const modulePath = "/src/store/cliUpdateStore.ts";
    const { useCliUpdateStore } = await import(/* @vite-ignore */ modulePath);
    useCliUpdateStore.setState((state: any) => ({ entries: Object.fromEntries(Object.entries(state.entries).map(([key, value]: any) => [key, { ...value, error: "network_unavailable" }])) }));
  });
  await expect(page.locator(".ad-cli-update-indicator")).toHaveCount(0);
});

/** Exercise the real React UI with the native boundary mocked, without running account tasks. */
async function setup(page: Page, locale = "pt-BR") {
  await page.addInitScript(({ locale }) => {
    const w = window as any;
    const callbacks = new Map<number, Function>();
    const listeners = new Map<string, Map<number, number>>();
    let id = 0;
    w.__calls = [];
    w.__failStart = false;
    w.__autoComplete = false;
    w.__chatListenDelay = 0;
    w.__chatTurns = {};
    w.__ptyReady = [];
    w.__emit = (event: string, payload: any) => {
      for (const [eventId, cb] of listeners.get(event) ?? []) callbacks.get(cb)?.({ event, id: eventId, payload });
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "popup" }, currentWebview: { label: "popup" } },
      transformCallback: (cb: Function) => { callbacks.set(++id, cb); return id; },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        w.__calls.push({ command, args });
        if (command === "check_app_update") {
          if (w.__appUpdateCheckFail) throw new Error("network_unavailable");
          return w.__appUpdateResult ?? { installed: "0.6.1", latest: "0.6.1", updateAvailable: false, supported: true, installerKind: "exe" };
        }
        if (command === "download_app_update") {
          if (w.__appUpdateDownloadFail) throw new Error("checksum_mismatch");
          await new Promise(resolve => setTimeout(resolve, 100));
          return { version: "0.6.2", filename: w.__appUpdateResult.installerKind === "msi" ? "Agentdeck_0.6.2_x64_en-US.msi" : "Agentdeck_0.6.2_x64-setup.exe" };
        }
        if (command === "install_app_update") {
          if (w.__appUpdateInstallFail) throw new Error("checksum_mismatch");
          return;
        }
        if (command === "plugin:event|listen") {
          if (!listeners.has(args.event)) listeners.set(args.event, new Map());
          const listenerId = ++id;
          listeners.get(args.event)!.set(listenerId, args.handler);
          if (args.event === "chat-event" && w.__chatListenDelay) await new Promise(resolve => setTimeout(resolve, w.__chatListenDelay));
          return listenerId;
        }
        if (command === "plugin:event|unlisten") { listeners.get(args.event)?.delete(args.eventId); return; }
        if (command === "plugin:window|is_maximized") return !!w.__maximized;
        if (command === "plugin:window|toggle_maximize") { w.__maximized = !w.__maximized; w.__emit("tauri://resize", { width: 1360, height: 900 }); return; }
        if (command === "plugin:window|scale_factor") return 1;
        if (command === "plugin:window|outer_size") return { width: 1360, height: 900 };
        if (command === "plugin:window|outer_position") return { x: 0, y: 0 };
        if (command === "recover_workspace_sessions" || command === "backfill_workspace_session_bindings" || command.startsWith("get_git_diff")) return [];
        if (command === "get_git_status") return { staged: [], unstaged: [], untracked: [], conflicts: [], committed: [] };
        if (command === "check_cli") return true;
        if (command === "list_agent_commands") return w.__agentCommands?.[args.runnerType] ?? null;
        if (command === "get_provider_usage") return [];
        if (command === "observe_agent_sessions") return [];
        if (command === "get_chat_turn_status") {
          if (w.__chatStatusFail) throw new Error("Process status unavailable");
          return w.__chatTurnStatus ?? { turnId: w.__chatTurns[args.sessionId], running: true, pid: 8765, status: "running" };
        }
        if (command === "save_chat_attachment") return { name: args.name, path: "C:\\AppData\\chat-attachments\\" + args.name, mimeType: args.mimeType, size: Math.floor(args.dataBase64.length * 3 / 4) };
        if (command === "start_chat_turn") {
          if (w.__failStart) throw new Error("chat spawn test failure");
          const req = args.request;
          w.__chatTurns[req.sessionId] = req.turnId;
          const emit = (event: any) => w.__emit("chat-event", { sessionId: req.sessionId, turnId: req.turnId, ...event });
          emit({ kind: "status", status: "started", pid: 8765, model: req.runnerType === "claude-code" ? "claude-opus-5-5" : undefined });
          emit({ kind: "session", providerSessionId: req.providerSessionId || "native-chat-session" });
          const output = () => {
            emit({ kind: "tool", itemId: "read", title: "Read project", text: "README.md", status: "completed" });
            emit({ kind: "text", itemId: "answer", text: "## Architecture review\n\n", delta: true });
            emit({ kind: "text", itemId: "answer", text: "Readable **agent response** with a verified tool event.", delta: true });
            emit({ kind: "status", status: "finishing", usage: req.runnerType === "codex" ? { input_tokens: 45, cached_input_tokens: 10, output_tokens: 20 } : { input_tokens: 30, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 20 } });
            if (w.__autoComplete) emit({ kind: "done", status: "completed" });
          };
          if (req.compactBeforeTurn) {
            w.__compactionPending = { sessionId: req.sessionId, turnId: req.turnId, input: [] };
            emit({ kind: "status", status: "compacting" });
            setTimeout(() => {
              if (w.__failCompact) { emit({ kind: "error", text: "Context compaction was not confirmed. Your next request was not sent." }); emit({ kind: "done", status: "error" }); w.__compactionPending = undefined; return; }
              emit({ kind: "compaction", itemId: req.turnId + ":before-turn", status: "before-turn" });
              for (const id of w.__compactionPending?.input ?? []) emit({ kind: "input", itemId: id, status: "accepted" });
              w.__compactionPending = undefined; output();
            }, w.__compactionDelay ?? 50);
          } else setTimeout(output, 30);
          return;
        }
        if (command === "steer_chat_turn") {
          if (w.__failSteer) throw new Error("Additional input failed");
          if (w.__compactionPending?.turnId === args.request.turnId) w.__compactionPending.input.push(args.messageId);
          else w.__emit("chat-event", { sessionId: args.request.sessionId, turnId: args.request.turnId, kind: "input", itemId: args.messageId, status: "accepted" });
          return "queued";
        }
        if (command === "stop_chat_turn") { w.__emit("chat-event", { sessionId: args.sessionId, turnId: w.__chatTurns[args.sessionId], kind: "done", status: "stopped" }); return; }
        if (command === "check_cli_update") {
          if (w.__offline) throw new Error("network_unavailable");
          return { provider: args.provider, installed: w.__updated?.[args.provider] ? "2.1.292" : "2.1.287", latest: "2.1.292", updateAvailable: !w.__updated?.[args.provider], method: "npm", executable: "C:\\Users\\Test\\npm\\" + args.provider + ".cmd", error: null };
        }
        if (command === "update_agent_cli") {
          if (w.__updateFailure) throw new Error(typeof w.__updateFailure === "string" ? w.__updateFailure : "cli_command_failed");
          await new Promise(resolve => setTimeout(resolve, 200));
          w.__updated ??= {}; w.__updated[args.provider] = true;
          return { provider: args.provider, installed: "2.1.292", latest: "2.1.292", updateAvailable: false, method: "npm", executable: "C:\\Users\\Test\\npm\\" + args.provider + ".cmd", error: null };
        }
        if (command === "list_agent_models" && w.__catalogueFailure) throw new Error("catalogue failure");
        if (command === "list_agent_models") return args.runnerType === "codex" ? [
          ...w.__codexUnknownDefault ? [] : [{ id: "default", label: "Codex local model", resolvedModel: "local-codex-model", cliVersion: "0.160.1", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"], fastMode: true }],
          { id: "local-codex-model", label: "Codex local model", resolvedModel: "local-codex-model", cliVersion: "0.160.1", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"], fastMode: true },
          { id: "local-lighter-model", label: "Codex lighter model", resolvedModel: "local-lighter-model", cliVersion: "0.160.1", reasoningEfforts: ["none", "minimal", "low", "medium", "high"], fastMode: false },
        ] : args.runnerType === "claude-code" ? [
          { id: "default", label: "Default (recommended)", resolvedModel: "claude-opus-5-5", cliVersion: w.__updated?.[args.runnerType] ? "2.1.292" : "2.1.287", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], fastMode: true },
          ...[["opus", "Opus 5.5", "claude-opus-5-5"], ["sonnet", "Sonnet 5.5", "claude-sonnet-5-5"], ["fable", "Fable 5.1", "claude-fable-5-1"], ["haiku", "Haiku 4.5", "claude-haiku-4-5-20251001"]].map(([id, label, resolvedModel]) => ({ id, label, resolvedModel, cliVersion: w.__updated?.[args.runnerType] ? "2.1.292" : "2.1.287", reasoningEfforts: id === "haiku" ? [] : ["low", "medium", "high", "xhigh", "max"], fastMode: id === "opus" }))
        ] : [];
        if (command === "reserve_session_id") return String(Date.now());
        if (command === "pick_folder") return "C:\\Projects\\Test Project";
        if (command === "get_knowledge_source") return null;
        if (command === "start_pty_session") {
          if (w.__ptyStartDelay) await new Promise(resolve => setTimeout(resolve, w.__ptyStartDelay));
          if (w.__failStart) throw new Error("spawn test failure");
          w.__ptyReady.push(args.sessionId);
          w.__emit("pty-started", { session_id: args.sessionId, pid: 9876, command: args.command, workdir: args.workdir });
          setTimeout(() => w.__emit("pty-data", { session_id: args.sessionId, data: btoa("Agent output\r\n") }), 20);
          return;
        }
        if (command === "stop_pty_session") { if (w.__failStop) throw new Error("native stop failed"); w.__emit("pty-exit", { session_id: args.sessionId, stopped: true }); return; }
        if (command === "load_ui_states" || command === "load_deleted_ui_state") return {};
        return null;
      },
    };
    if (!localStorage.getItem("agentdeck-settings")) {
      localStorage.setItem("agentdeck-settings", JSON.stringify({ state: { settings: { locale, theme: "dark", splitPaneSidebarWidth: 300, splitWidgetPanelCollapsed: true, runner: { type: "claude-code" } } }, version: 0 }));
      localStorage.setItem("agentdeck-workspaces", JSON.stringify({ state: { workspaces: [{ id: "project", name: "Agentdeck project", path: "C:\\Projects\\Test Project", color: "blue", createdAt: 1, order: 0 }], activeWorkspaceId: "project" }, version: 0 }));
      localStorage.setItem("agentdeck-sessions", JSON.stringify({ state: { sessions: [{ id: "session", name: "Implementation", workspaceId: "project", workdir: "C:\\Projects\\Test Project", status: "idle", currentTask: "", createdAt: 1, diffFiles: [], output: [], runner: { type: "claude-code" } }], activeSessionId: "session" }, version: 0 }));
    }
  }, { locale });
  await page.goto("/");
}

async function openSession(page: Page) {
  await page.getByText("Implementation", { exact: true }).first().click();
  // The sidebar row can select a session before its explicit open action.
  const open = page.getByTitle("Abrir conversa");
  if (await open.count()) await open.first().click();
  await expect(page.getByPlaceholder("Descreva a tarefa, faça uma pergunta ou peça uma revisão de código…")).toBeVisible();
}

for (const provider of ["Claude Code", "OpenAI Codex"]) test(`${provider} accepts additional input while working and keeps one active conversation`, async ({ page }) => {
  await setup(page); await openSession(page);
  await page.getByRole("button", { name: provider, exact: true }).click();
  const input = page.locator(".ad-chat-composer textarea");
  await expect(page.getByRole("switch", { name: "Acesso total à máquina", exact: true })).toBeChecked();
  await input.fill("Implementar login");
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Architecture review" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Acesso total à máquina", exact: true })).toBeDisabled();
  await input.fill("Também adicione recuperação de senha");
  await page.getByRole("button", { name: "Enviar complemento", exact: true }).click();
  await expect(page.getByText("Complemento entregue", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Parar resposta", exact: true })).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__calls.filter((c: any) => ["start_chat_turn", "steer_chat_turn"].includes(c.command)));
  expect(calls).toHaveLength(2);
  expect(calls[0].args.request.fullAccess).toBe(true);
  expect(calls[1].args.request.turnId).toBe(calls[0].args.request.turnId);
  expect(calls[1].args.request.prompt).toBe("Também adicione recuperação de senha");
  await page.evaluate(() => { (window as any).__failSteer = true; });
  await input.fill("Não use dependências extras");
  await page.getByRole("button", { name: "Enviar complemento", exact: true }).click();
  await expect(page.getByText("Complemento não entregue — reenviar", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("Não use dependências extras");
  await page.getByRole("button", { name: "Parar resposta", exact: true }).click();
  const access = page.getByRole("switch", { name: "Acesso total à máquina", exact: true });
  await access.click();
  await expect(access).not.toBeChecked();
  await input.fill("Continuar com permissões padrão");
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  const last = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_chat_turn").at(-1));
  expect(last.args.request.fullAccess).toBe(false);
  expect(last.args.request.providerSessionId).toBe("native-chat-session");
});

test("stopping a pending launch does not restart it with an additional message", async ({ page }) => {
  await setup(page); await openSession(page);
  await page.evaluate(() => { (window as any).__chatListenDelay = 1200; });
  const input = page.locator(".ad-chat-composer textarea");
  await input.fill("Primeiro pedido");
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await input.fill("Complemento antes de iniciar");
  await page.getByRole("button", { name: "Enviar complemento", exact: true }).click();
  await page.getByRole("button", { name: "Parar resposta", exact: true }).click();
  await expect(page.getByText("Resposta interrompida", { exact: true })).toBeVisible();
  await expect(page.getByText("Complemento não entregue — reenviar", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => ["start_chat_turn", "steer_chat_turn"].includes(c.command)))).toHaveLength(0);
});

test("side terminal opens directly and preserves its process and chat draft when collapsed", async ({ page }) => {
  await setup(page); await openSession(page);
  const prompt = page.locator(".ad-chat-composer textarea:visible");
  await prompt.fill("Rascunho preservado");
  const terminal = page.getByRole("complementary", { name: "Terminal", exact: true });
  const launches = () => page.evaluate(() => (window as any).__calls.filter((call: any) => call.command === "start_pty_session"));
  expect(await launches()).toHaveLength(0);
  await page.evaluate(() => { (window as any).__ptyStartDelay = 800; });
  await page.getByRole("button", { name: "Expandir terminal", exact: true }).click();
  await expect(terminal).toBeVisible();
  await expect.poll(async () => (await launches()).length).toBe(1);
  // Collapse/reopen while native startup is pending must not create a second shell.
  await terminal.getByRole("button", { name: "Recolher terminal" }).click();
  await expect(page.getByRole("button", { name: "Expandir terminal", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Expandir terminal", exact: true }).click();
  await expect(terminal.locator(".xterm:visible")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((call: any) => call.command === "plugin:event|listen" && call.args.event === "pty-data").length)).toBeGreaterThan(0);
  const shell = (await launches())[0];
  expect(shell.args).toMatchObject({ command: "cmd.exe", args: ["/K"], workdir: "C:\\Projects\\Test Project" });
  expect(shell.args.cols).toBeGreaterThan(40);
  expect(shell.args.rows).toBeGreaterThan(25);
  await expect.poll(() => page.evaluate(() => (window as any).__ptyReady.length)).toBe(1);
  await terminal.locator(".xterm-helper-textarea:visible").pressSequentially("echo ready");
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((call: any) => call.command === "write_pty").length)).toBeGreaterThan(0);
  expect(await launches()).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).__calls.filter((call: any) => call.command === "stop_pty_session"))).toHaveLength(0);
  await expect(terminal.getByText("Limites das IAs", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Preencher painel", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("provider-usage-bar")).toBeVisible();
  await terminal.getByRole("button", { name: "Recolher terminal" }).click();
  await expect(prompt).toHaveValue("Rascunho preservado");
});

test("terminal tabs support switching, closing and recovery after repeated startup failures", async ({ page }) => {
  await setup(page); await openSession(page);
  await page.getByRole("button", { name: "Expandir terminal", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Terminal", exact: true });
  const launches = () => page.evaluate(() => (window as any).__calls.filter((call: any) => call.command === "start_pty_session"));
  await expect.poll(async () => (await launches()).length).toBe(1);
  const firstId = (await launches())[0].args.sessionId;
  await panel.getByRole("button", { name: "Nova aba de terminal" }).click();
  await expect(panel.getByRole("tab", { name: "Terminal 2", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => (await launches()).length).toBe(2);
  const secondId = (await launches())[1].args.sessionId;
  await panel.getByRole("tab", { name: "Terminal 1", exact: true }).click();
  await page.keyboard.press("ArrowRight");
  await expect(panel.getByRole("tab", { name: "Terminal 2", exact: true })).toBeFocused();
  await expect(panel.locator(".ci-pty-terminal:visible")).toHaveCount(1);
  await page.screenshot({ path: "test-results/terminal-panel.png", animations: "disabled" });
  await panel.getByRole("button", { name: /Terminal 2/ }).click();
  await expect(panel.getByRole("tab")).toHaveCount(1);
  await expect.poll(() => page.evaluate(id => (window as any).__calls.some((call: any) => call.command === "stop_pty_session" && call.args.sessionId === id), secondId)).toBe(true);
  expect(await page.evaluate(id => (window as any).__calls.some((call: any) => call.command === "stop_pty_session" && call.args.sessionId === id), firstId)).toBe(false);
  expect(await launches()).toHaveLength(2);
  await page.evaluate(() => { (window as any).__failStart = true; });
  await panel.getByRole("button", { name: "Nova aba de terminal" }).click();
  await expect(panel.getByRole("button", { name: "Reiniciar", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Reiniciar", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Reiniciar", exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__failStart = false; });
  await panel.getByRole("button", { name: "Reiniciar", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Reiniciar", exact: true })).toHaveCount(0);
});

test("old widget layouts become a single terminal with all tabs and fit a smaller window", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("agentdeck-settings")!);
    stored.state.settings.splitWidgetPanelCollapsed = true;
    stored.state.settings.splitWidgetCanvas = { cellSize: 12, items: [
      { id: "usage-old", type: "usage", visible: true, col: 999, row: 999, colSpan: 18, rowSpan: 10 },
      { id: "terminal-old", type: "terminal", visible: true, col: 999, row: 999, colSpan: 18, rowSpan: 10, tabs: [{ id: "one", title: "Terminal 1", ptySessionKey: "old-one" }], activeTabId: "one" },
      { id: "terminal-hidden", type: "terminal", visible: false, col: 10, row: 3, colSpan: 18, rowSpan: 10, tabs: [{ id: "seven", title: "Terminal 7", ptySessionKey: "old-seven" }], activeTabId: "seven" },
    ] };
    localStorage.setItem("agentdeck-settings", JSON.stringify(stored));
  });
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.reload(); await openSession(page);
  await page.getByRole("button", { name: "Expandir terminal", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Terminal", exact: true });
  await expect(panel.getByRole("tab")).toHaveText(["Terminal 1", "Terminal 7"]);
  await panel.getByRole("tab", { name: "Terminal 7" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((call: any) => call.command === "start_pty_session" && call.args.sessionId.includes("old-seven")).length)).toBe(1);
  await expect(panel.locator("[draggable='true']")).toHaveCount(0);
  const bounds = await panel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.width).toBeGreaterThan(400);
  expect(bounds!.height).toBeGreaterThan(550);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1000);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/terminal-panel-small.png", animations: "disabled" });
});

test("closing a tab while its restart is pending stops the late native process", async ({ page }) => {
  await setup(page); await openSession(page);
  await page.getByRole("button", { name: "Expandir terminal", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Terminal", exact: true });
  await expect.poll(() => page.evaluate(() => (window as any).__ptyReady.length)).toBe(1);
  await page.evaluate(() => { (window as any).__failStart = true; });
  await panel.getByRole("button", { name: "Nova aba de terminal" }).click();
  await expect(panel.getByRole("button", { name: "Reiniciar", exact: true })).toBeVisible();
  await page.evaluate(() => { const w = window as any; w.__failStart = false; w.__ptyStartDelay = 800; });
  await panel.getByRole("button", { name: "Reiniciar", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((call: any) => call.command === "start_pty_session").length)).toBe(3);
  const restartingId = await page.evaluate(() => (window as any).__calls.filter((call: any) => call.command === "start_pty_session").at(-1).args.sessionId);
  await panel.getByRole("button", { name: /Terminal 2/ }).click();
  await expect(panel.getByRole("tab")).toHaveCount(1);
  await expect.poll(() => page.evaluate(id => (window as any).__calls.some((call: any) => call.command === "stop_pty_session" && call.args.sessionId === id), restartingId)).toBe(true);
});

test("Windows controls are on the right and issue native actions", async ({ page }) => {
  await setup(page);
  const close = page.getByRole("button", { name: "Fechar Agentdeck", exact: true });
  const box = await close.boundingBox();
  expect(box!.x).toBeGreaterThan(1250);
  await page.getByRole("button", { name: "Minimizar", exact: true }).click();
  await page.getByRole("button", { name: "Maximizar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restaurar", exact: true })).toBeVisible();
  await close.click();
  const calls = await page.evaluate(() => (window as any).__calls.map((c: any) => c.command));
  expect(calls).toEqual(expect.arrayContaining(["plugin:window|minimize", "plugin:window|toggle_maximize", "exit_app"]));
  await expect(page.locator(".ad-brand img")).toHaveAttribute("src", "/agentdeck-icon.png");
});

test("structured chat streams readable messages, retains native context, and stops safely", async ({ page }) => {
  await setup(page); await openSession(page);
  await page.getByLabel("Modelo", { exact: true }).selectOption("opus");
  await page.getByLabel("Modo", { exact: true }).selectOption("plan");
  const prompt = page.getByPlaceholder("Descreva a tarefa, faça uma pergunta ou peça uma revisão de código…");
  // Text boxes grow with their content; nothing exposes a drag-to-resize grip.
  expect(await prompt.evaluate(el => getComputedStyle(el).resize)).toBe("none");
  await prompt.fill("Review the architecture");
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Architecture review" })).toBeVisible();
  await expect(page.locator(".ad-message-assistant")).toHaveCount(1);
  await expect(page.getByText("Read project", { exact: true })).toBeVisible();
  const start = await page.evaluate(() => (window as any).__calls.find((c: any) => c.command === "start_chat_turn"));
  expect(start.args.request).toMatchObject({ model: "opus", mode: "plan", prompt: "Review the architecture", runnerType: "claude-code" });
  await expect(page.getByRole("tab", { name: "Terminal nativo", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Parar resposta", exact: true }).click();
  await expect(page.getByText("Resposta interrompida", { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__autoComplete = true; });
  await page.getByPlaceholder("Continue a conversa…").fill("Follow up\nWith another line");
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await expect(page.getByPlaceholder("Continue a conversa…")).toHaveValue("");
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_chat_turn").length)).toBe(2);
  const followup = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_chat_turn").at(-1));
  expect(followup.args.request.providerSessionId).toBe("native-chat-session");
  expect(followup.args.request.prompt).toBe("Follow up\nWith another line");
  expect(await page.getByPlaceholder("Continue a conversa…").evaluate(el => getComputedStyle(el).resize)).toBe("none");
  await page.screenshot({ path: "test-results/chat-live-pt.png" });
  await page.reload();
  await expect(page.getByText("Follow up\nWith another line", { exact: true })).toBeVisible();
});

test("startup failures stay visible and offer restart", async ({ page }) => {
  await setup(page); await openSession(page);
  await page.evaluate(() => { (window as any).__failStart = true; });
  await page.getByRole("button", { name: "Abrir agente / entrar", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "spawn test failure" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reiniciar", exact: true })).toBeVisible();
});

test("all interface languages persist and settings leave Windows controls visible", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "Configurações", exact: true }).click();
  await expect(page.getByRole("button", { name: "Fechar Agentdeck", exact: true })).toBeVisible();
  await page.getByText("Español", { exact: true }).click();
  await expect(page.getByText("Preferencias", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Cerrar Agentdeck", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Configuración", exact: true }).click();
  await page.getByText("English", { exact: true }).click();
  await expect(page.getByText("Preferences", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeVisible();
});

test("Codex models come from the local catalogue and the selected model is passed to Codex", async ({ page }) => {
  await setup(page); await openSession(page);
  await page.getByRole("button", { name: "OpenAI Codex", exact: true }).click();
  await expect(page.getByLabel("Modelo", { exact: true }).locator('option[value="local-codex-model"]')).toHaveCount(1);
  await page.getByLabel("Modelo", { exact: true }).selectOption("local-codex-model");
  await page.getByRole("button", { name: "Abrir agente / entrar", exact: true }).click();
  await expect(page.getByText("Processo iniciado", { exact: true }).first()).toBeVisible();
  const start = await page.evaluate(() => (window as any).__calls.find((c: any) => c.command === "start_pty_session" && c.args.sessionId === "session"));
  expect(start.args.command).toBe("codex");
  expect(start.args.args).toEqual(["--model", "local-codex-model", "-c", 'model_reasoning_effort="medium"', "-c", 'service_tier="default"', "-c", "features.fast_mode=false", "--dangerously-bypass-approvals-and-sandbox"]);
});

test("two agents coexist and a collapsed tools panel does not spawn a shell", async ({ page }) => {
  await setup(page); await openSession(page);
  expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_pty_session"))).toHaveLength(0);
  await page.getByRole("button", { name: "Abrir agente / entrar", exact: true }).click();
  await expect(page.getByText("Processo iniciado", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "+ Nova sessão", exact: true }).click();
  await page.getByRole("button", { name: "Google Gemini", exact: true }).click();
  await expect(page.getByText("Processo iniciado", { exact: true }).last()).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_pty_session").length)).toBe(2);
  const calls = await page.evaluate(() => (window as any).__calls);
  const starts = calls.filter((c: any) => c.command === "start_pty_session");
  expect(starts).toHaveLength(2);
  expect(starts.map((c: any) => c.args.command)).toEqual(["claude", "gemini"]);
  expect(new Set(starts.map((c: any) => c.args.sessionId)).size).toBe(2);
  expect(calls.filter((c: any) => c.command === "stop_pty_session")).toHaveLength(0);
});

test("light theme and reduced motion remain readable at a smaller window size", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page); await openSession(page);
  await page.getByRole("button", { name: "Configurações", exact: true }).click();
  await page.getByRole("button", { name: "Aparência", exact: true }).click();
  await page.getByText("Claro", { exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: "Enviar", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/agentdeck-light-pt.png" });
});

test("attachments, objective, image paste and sketch reach the native chat request", async ({ page }) => {
  await setup(page); await openSession(page);
  await page.getByRole("button", { name: "Adicionar contexto", exact: true }).click();
  await page.getByRole("button", { name: "Objetivo da conversa", exact: true }).click();
  await page.getByRole("textbox", { name: "Objetivo da conversa", exact: true }).fill("A readable accessible workspace");
  await page.getByLabel("Adicionar arquivos ou imagens", { exact: true }).setInputFiles({ name: "architecture.md", mimeType: "text/markdown", buffer: Buffer.from("# Existing architecture") });
  await expect(page.locator(".ad-attachments").getByText("architecture.md", { exact: true })).toBeVisible();
  const prompt = page.getByPlaceholder("Descreva a tarefa, faça uma pergunta ou peça uma revisão de código…");
  await prompt.evaluate(el => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 48; const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#0da861"; ctx.fillRect(0, 0, 48, 48);
    const bytes = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), c => c.charCodeAt(0));
    const data = new DataTransfer(); data.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  });
  await expect(page.locator(".ad-attachments img")).toHaveCount(1);
  await page.getByRole("button", { name: "Adicionar contexto", exact: true }).click();
  await page.getByRole("button", { name: "Desenhar", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Esboço para o agente" })).toBeVisible();
  await page.getByRole("button", { name: "Anexar esboço", exact: true }).click();
  await expect(page.locator(".ad-attachments").getByText("sketch.png", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/chat-attachments-pt.png" });
  await prompt.fill("Review these files");
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Architecture review" })).toBeVisible();
  const request = await page.evaluate(() => (window as any).__calls.find((c: any) => c.command === "start_chat_turn").args.request);
  expect(request.attachments.map((a: any) => a.name)).toEqual(["architecture.md", "pasted.png", "sketch.png"]);
  expect(request.prompt).toContain("A readable accessible workspace");
  expect(request.attachments.every((a: any) => !a.preview && a.path.startsWith("C:"))).toBe(true);
  await page.getByRole("button", { name: "Parar resposta", exact: true }).click();
  await page.evaluate(() => { (window as any).__autoComplete = true; });
  await page.getByPlaceholder("Continue a conversa…").fill("Continue the review");
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_chat_turn").length)).toBe(2);
  const followup = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_chat_turn")[1].args.request);
  expect(followup.providerSessionId).toBeTruthy();
  expect(followup.prompt).toBe("Continue the review");
  expect(followup.attachments).toEqual([]);
});

test("chat launch failure preserves the prompt, retries, searches and exports", async ({ page }) => {
  await setup(page); await openSession(page);
  await page.evaluate(() => { (window as any).__failStart = true; });
  await page.getByPlaceholder("Descreva a tarefa, faça uma pergunta ou peça uma revisão de código…").fill("Keep this task");
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("chat spawn test failure");
  await expect(page.getByPlaceholder("Continue a conversa…")).toHaveValue("Keep this task");
  await page.evaluate(() => { (window as any).__failStart = false; (window as any).__autoComplete = true; });
  await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Architecture review" })).toBeVisible();
  await page.getByRole("button", { name: "Buscar", exact: true }).click();
  await page.getByRole("textbox", { name: "Buscar na conversa", exact: true }).fill("no-such-result");
  await expect(page.getByText("Nenhuma mensagem encontrada.")).toBeVisible();
  await page.getByRole("textbox", { name: "Buscar na conversa", exact: true }).fill("Architecture");
  await expect(page.getByRole("heading", { name: "Architecture review" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Exportar conversa", exact: true }).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/\.md$/);
});

test("native terminal preserves slash commands and activity diagnostics", async ({ page }) => {
  await setup(page); await openSession(page);
  await page.getByRole("button", { name: "Abrir agente / entrar", exact: true }).click();
  await expect(page.getByText("Processo iniciado", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Atividade", exact: true }).click();
  await expect(page.getByText("PID 9876")).toBeVisible();
  await page.getByLabel("Comandos do agente", { exact: true }).selectOption("/model");
  expect(await page.evaluate(() => (window as any).__calls.some((c: any) => c.command === "send_pty_query" && c.args.query === "/model"))).toBe(true);
  await page.getByRole("button", { name: "Encerrar processo do agente" }).click();
  await expect(page.getByText("Interrompido por você", { exact: true }).first()).toBeVisible();
  await page.getByRole("tab", { name: "Conversa", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Seu próximo projeto começa aqui", exact: true })).toBeVisible();
  await expect(page.locator(".ad-chat-suggestions")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Explique a arquitetura deste projeto", exact: true })).toHaveCount(0);
  await page.screenshot({ path: "test-results/chat-restored.png", animations: "disabled" });
});

test("stopping during listener initialization never launches a delayed agent", async ({ page }) => {
  await setup(page); await openSession(page);
  await page.evaluate(() => { (window as any).__chatListenDelay = 1500; });
  await page.getByPlaceholder("Descreva a tarefa, faça uma pergunta ou peça uma revisão de código…").fill("Cancel before startup");
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await page.getByRole("button", { name: "Parar resposta", exact: true }).click();
  await expect(page.getByText("Resposta interrompida", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "start_chat_turn"))).toHaveLength(0);
  await expect(page.getByPlaceholder("Continue a conversa…")).toHaveValue("Cancel before startup");
});

test("subagent messages have identity and blocked permissions offer native recovery", async ({ page }) => {
  await setup(page); await openSession(page);
  await page.getByPlaceholder("Descreva a tarefa, faça uma pergunta ou peça uma revisão de código…").fill("Review with a subagent");
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Architecture review" })).toBeVisible();
  await page.evaluate(() => {
    const w = window as any; const base = { sessionId: "session", turnId: w.__chatTurns.session };
    w.__emit("chat-event", { ...base, kind: "text", itemId: "child-text", parentId: "review-child-1", text: "Subagent review result" });
    w.__emit("chat-event", { ...base, kind: "tool", itemId: "permission-required", title: "Permission required", text: "Approve in native terminal", status: "blocked" });
    w.__emit("chat-event", { ...base, kind: "done", status: "completed" });
    w.__emit("chat-event", { ...base, kind: "text", itemId: "late", text: "Discard this late output" });
  });
  await expect(page.locator(".ad-subagent-label")).toContainText("Subagente");
  await expect(page.getByText("Discard this late output")).toHaveCount(0);
  await page.locator(".ad-chat-bottom").getByRole("button", { name: "Terminal nativo", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__calls.some((c: any) => c.command === "start_pty_session" && c.args.sessionId === "session"))).toBe(true);
  const start = await page.evaluate(() => (window as any).__calls.find((c: any) => c.command === "start_pty_session" && c.args.sessionId === "session"));
  expect(start.args.args).toEqual(["--resume", "native-chat-session", "--effort", "medium", "--settings", '{"fastMode":false,"ultracode":false}', "--permission-mode", "bypassPermissions"]);
});
