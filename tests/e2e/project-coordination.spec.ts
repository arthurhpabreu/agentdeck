import { expect, test, type Page } from "@playwright/test";
import { setupImprovements } from "./improvements-fixtures";

async function setupTeam(page: Page, options: { existing?: boolean; historyCount?: number; unfocusedTrigger?: boolean } = {}) {
  await setupImprovements(page);
  await page.evaluate(async ({ existing, historyCount }) => {
    const { useWorkspaceStore } = await import("/src/store/workspaceStore.ts" as string);
    const { useSessionStore } = await import("/src/store/sessionStore.ts" as string);
    useWorkspaceStore.setState((state: any) => ({ workspaces: [...state.workspaces, { id: "two", name: "Projeto parceiro", path: "C:/fixtures/two", color: "blue", createdAt: 2, order: 1 }] }));
    useSessionStore.setState((state: any) => ({ sessions: state.sessions.map((session: any) => session.id === "session-2" ? { ...session, workspaceId: "two", workdir: "C:/fixtures/two", runner: { type: "claude-code" } } : session.id === "session-1" ? { ...session, runner: { type: "gemini" } } : session) }));
    const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
    const member = (sessionId: string) => {
      const session = useSessionStore.getState().sessions.find((entry: any) => entry.id === sessionId);
      const workspace = useWorkspaceStore.getState().workspaces.find((entry: any) => entry.id === session.workspaceId);
      return { memberId: `member-${sessionId}`, sessionId, projectPath: workspace.path, projectName: workspace.name, name: session.name, provider: session.runner.type, workdir: session.worktreePath || session.workdir, status: sessionId === "session-2" ? "running" : "idle", activity: "Revisando integração", summary: "", stale: false };
    };
    w.__teamCalls = []; w.__teamFailSend = false; w.__teamKeys = new Map();
    w.__teamHistory = Array.from({ length: historyCount ?? 4 }, (_, index) => ({ seq: index + 1, senderId: index % 2 ? "member-session-0" : "member-session-2", senderName: index % 2 ? "Conversa 0" : "Conversa 2", recipientId: null, kind: index % 2 ? "update" : "reply", message: `Mensagem de coordenação ${index + 1}`, createdAt: 1792497600000 + index * 1000, deliveryStatus: "delivered" }));
    w.__teamBoard = { team: existing ? { id: "fixture-team", name: "Integração conjunta", objective: "Integrar os projetos e revisar os testes.", automatic: true } : null, selfId: "member-session-0", members: existing ? [member("session-0"), member("session-2")] : [], messages: [], claims: [{ memberId: "member-session-2", path: "src/api.ts", workdir: "C:/fixtures/two", expiresAt: Date.now() + 60_000 }] };
    const response = (before?: number) => {
      if (!w.__teamBoard.team) return { ...w.__teamBoard, messages: [] };
      const messages = w.__teamHistory.filter((message: any) => before == null || message.seq < before).slice(-20);
      const cursor = messages[0]?.seq ?? null;
      return { ...w.__teamBoard, messages, beforeCursor: cursor, hasMore: cursor != null && w.__teamHistory.some((message: any) => message.seq < cursor) };
    };
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
      if (command === "coordination_team_pending") return [];
      if (command === "coordination_team_configure") {
        w.__teamCalls.push({ command, ...args });
        w.__teamBoard = { ...w.__teamBoard, team: { id: args.input.teamId || "fixture-team", name: args.input.name, objective: args.input.objective, automatic: args.input.automatic }, members: args.input.members.map((entry: any) => member(entry.sessionId)) };
        return JSON.stringify(response());
      }
      if (command === "coordination_call" && args.name.startsWith("team_")) {
        w.__teamCalls.push({ command, ...args });
        if (args.name === "team_board") {
          const result = args.sessionId === "session-0" ? response(args.input.before) : { team: null, members: [], messages: [] };
          if (w.__teamDelayBoard) return new Promise(resolve => { w.__resolveTeamBoard = () => resolve(JSON.stringify(result)); });
          return JSON.stringify(result);
        }
        if (args.name === "team_send") {
          if (w.__teamFailSend) throw new Error("Conexão temporariamente indisponível");
          if (!w.__teamKeys.has(args.input.idempotencyKey)) {
            const seq = (w.__teamHistory.at(-1)?.seq ?? 0) + 1;
            w.__teamHistory.push({ seq, senderId: "member-session-0", senderName: "Conversa 0", recipientId: args.input.recipientId || null, kind: args.input.kind, message: args.input.message, createdAt: Date.now(), deliveryStatus: "queued" });
            w.__teamKeys.set(args.input.idempotencyKey, seq);
          }
          return JSON.stringify({ queued: true });
        }
        if (args.name === "team_leave") { w.__teamBoard = { team: null, members: [], messages: [] }; return JSON.stringify({ left: true }); }
        if (args.name === "team_inbox") throw new Error("The UI must not consume the agent inbox");
      }
      return original(command, args);
    };
    window.dispatchEvent(new Event("agentdeck-team-changed"));
  }, options);
  const trigger = page.getByRole("button", { name: "Equipe de agentes", exact: true });
  if (options.unfocusedTrigger) {
    await page.locator(".ad-chat-composer textarea:visible").focus();
    // Reproduce Safari's pointer policy: the click opens the drawer without
    // moving document.activeElement to its button first.
    await trigger.evaluate(element => element.addEventListener("mousedown", event => event.preventDefault(), { once: true }));
  }
  await trigger.click();
  return page.getByRole("dialog", { name: "Equipe de agentes", exact: true });
}

test("agent team selects chats across projects, shows work context, and pauses automation @macos", async ({ page }) => {
  const panel = await setupTeam(page, { unfocusedTrigger: true });
  await expect(panel.getByRole("heading", { name: "Criar equipe", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Criar equipe", exact: true })).toBeDisabled();
  await expect(panel.getByRole("checkbox", { name: /Conversa 0/ })).toBeChecked();
  await expect(panel.getByRole("checkbox", { name: /Conversa 0/ })).toBeDisabled();
  await panel.getByRole("textbox", { name: "Nome da equipe", exact: true }).fill("Integração conjunta");
  await panel.getByRole("textbox", { name: "Objetivo compartilhado", exact: true }).fill("Integrar os projetos e revisar os testes.");
  await panel.getByRole("checkbox", { name: /Conversa 1/ }).check();
  await panel.getByRole("checkbox", { name: /Conversa 2.*Projeto parceiro/ }).check();
  await expect(panel.getByRole("switch", { name: "Coordenação automática" })).toBeChecked();
  await panel.getByRole("button", { name: "Criar equipe", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Integração conjunta", exact: true })).toBeVisible();
  const configuration = await page.evaluate(() => (window as any).__teamCalls.find((call: any) => call.command === "coordination_team_configure").input);
  expect(configuration).toMatchObject({ name: "Integração conjunta", automatic: true });
  expect(configuration.members.map((member: any) => member.sessionId)).toEqual(["session-0", "session-1", "session-2"]);
  expect(configuration.members.find((member: any) => member.sessionId === "session-2").projectPath).toBe("C:/fixtures/two");
  await panel.locator("summary").click();
  await expect(panel.locator(".ad-team-members")).toContainText("Projeto parceiro · Claude");
  await expect(panel.locator(".ad-team-members")).toContainText("src/api.ts");
  await panel.getByRole("switch", { name: "Coordenação automática" }).click();
  await expect(panel.getByRole("switch", { name: "Coordenação automática" })).not.toBeChecked();
  expect(await page.evaluate(() => (window as any).__teamCalls.filter((call: any) => call.command === "coordination_team_configure").at(-1).input.members)).toHaveLength(3);
  await panel.locator("summary").click();
  await panel.getByRole("textbox", { name: "Mensagem para a equipe", exact: true }).fill("Vou revisar os testes da integração.");
  await panel.getByRole("button", { name: "Enviar mensagem", exact: true }).click();
  await expect(panel.getByRole("log")).toContainText("Vou revisar os testes da integração.");
  const sends = await page.evaluate(() => (window as any).__teamCalls.filter((call: any) => call.name === "team_send"));
  expect(sends[0].input).toMatchObject({ message: "Vou revisar os testes da integração.", kind: "update" });
  expect(sends[0].input.recipientId).toBeUndefined();
  expect(sends[0].input.idempotencyKey).toBeTruthy();
  expect(await page.evaluate(() => (window as any).__improvementCalls.filter((call: any) => ["start_chat_turn", "steer_chat_turn", "send_pty_query"].includes(call.command)))).toEqual([]);
  await panel.locator("summary").click();
  await panel.locator(".ad-team-members").evaluate(element => { element.scrollTop = element.scrollHeight; });
  await panel.getByRole("log").evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(panel.getByRole("log").locator("article").last()).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: ".local/validation/agent-team-desktop.png", animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page.getByRole("button", { name: "Equipe de agentes", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Equipe de agentes", exact: true })).toContainText("Equipe · 3 agentes");
  const trigger = page.getByRole("button", { name: "Equipe de agentes", exact: true });
  await trigger.click();
  await panel.getByRole("button", { name: "Fechar equipe", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.locator(".ad-team-backdrop").click({ position: { x: 12, y: 100 } });
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await trigger.evaluate(element => {
    (window as any).__teamReturnedFocus = 0;
    element.addEventListener("focus", () => { (window as any).__teamReturnedFocus++; });
  });
  await panel.locator("summary").click();
  await panel.getByRole("button", { name: "Conversa 2", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect.poll(() => page.evaluate(async () => (await import("/src/store/sessionStore.ts" as string)).useSessionStore.getState().activeSessionId)).toBe("session-2");
  expect(await page.evaluate(() => (window as any).__teamReturnedFocus)).toBe(0);
});

test("team timeline keeps earlier pages and refreshes without consuming agent inbox @macos", async ({ page }) => {
  const panel = await setupTeam(page, { existing: true, historyCount: 125 });
  await expect(panel.getByRole("log").locator("article")).toHaveCount(20);
  for (let pageNumber = 0; pageNumber < 6; pageNumber++) {
    await panel.getByRole("button", { name: "Carregar mensagens anteriores" }).click();
    await expect(panel.getByRole("log").locator("article")).toHaveCount(Math.min(125, 40 + pageNumber * 20));
  }
  await expect(panel.getByRole("button", { name: "Carregar mensagens anteriores" })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("agentdeck-team-changed")));
  await expect(panel.getByRole("log").locator("article")).toHaveCount(125);
  await expect(panel.getByRole("log").locator("article").first()).toContainText("Mensagem de coordenação 1");
  await expect(panel.getByRole("log").locator("article").last()).toContainText("Mensagem de coordenação 125");
  expect(await page.evaluate(() => (window as any).__teamCalls.filter((call: any) => call.name === "team_inbox"))).toEqual([]);
});

test("direct task requests without randomUUID preserve a failed draft and reuse the retry key @macos", async ({ page }) => {
  const panel = await setupTeam(page, { existing: true });
  await page.evaluate(() => Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined }));
  await expect(panel.getByRole("checkbox", { name: "Solicitar uma tarefa" })).toBeDisabled();
  await panel.getByRole("combobox", { name: "Destino" }).selectOption("member-session-2");
  await panel.getByRole("checkbox", { name: "Solicitar uma tarefa" }).check();
  await panel.getByRole("textbox", { name: "Mensagem para a equipe", exact: true }).fill("Revise os testes do projeto parceiro.");
  await page.evaluate(() => { (window as any).__teamFailSend = true; });
  await panel.getByRole("button", { name: "Enviar mensagem", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Conexão temporariamente indisponível");
  await expect(panel.getByRole("textbox", { name: "Mensagem para a equipe", exact: true })).toHaveValue("Revise os testes do projeto parceiro.");
  await page.evaluate(() => { (window as any).__teamFailSend = false; });
  await panel.getByRole("button", { name: "Enviar mensagem", exact: true }).click();
  await expect(panel.getByRole("textbox", { name: "Mensagem para a equipe", exact: true })).toHaveValue("");
  await expect(panel.getByRole("log").locator("article").last()).toContainText("Na fila");
  await expect(panel.getByRole("log").locator("article").last()).toContainText("Solicitação");
  const sends = await page.evaluate(() => (window as any).__teamCalls.filter((call: any) => call.name === "team_send"));
  expect(sends).toHaveLength(2);
  expect(sends[0].input).toMatchObject({ recipientId: "member-session-2", kind: "request" });
  expect(sends[0].input.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(sends[0].input.idempotencyKey).toBe(sends[1].input.idempotencyKey);
});

test("team forms explain Unicode byte limits before sending @macos", async ({ page }) => {
  const panel = await setupTeam(page);
  await panel.getByRole("checkbox", { name: /Conversa 2/ }).check();
  await panel.getByRole("textbox", { name: "Nome da equipe", exact: true }).fill("é".repeat(100));
  await expect(panel).toContainText("200/160 bytes · Limite de envio excedido");
  await expect(panel.getByRole("button", { name: "Criar equipe", exact: true })).toBeDisabled();
  await panel.getByRole("textbox", { name: "Nome da equipe", exact: true }).fill("Equipe café");
  await panel.getByRole("textbox", { name: "Objetivo compartilhado", exact: true }).fill("🦀".repeat(600));
  await expect(panel).toContainText("2400/2000 bytes · Limite de envio excedido");
  await expect(panel.getByRole("button", { name: "Criar equipe", exact: true })).toBeDisabled();
  await panel.getByRole("textbox", { name: "Objetivo compartilhado", exact: true }).fill("Revisar a integração.");
  await panel.getByRole("button", { name: "Criar equipe", exact: true }).click();
  await panel.getByRole("textbox", { name: "Mensagem para a equipe", exact: true }).fill("🦀".repeat(800));
  await expect(panel).toContainText("3200/3000 bytes · Limite de envio excedido");
  await expect(panel.getByRole("button", { name: "Enviar mensagem", exact: true })).toBeDisabled();
});

test("team drawer fits a narrow window, traps focus, and respects chat opt-out @macos", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await setupTeam(page, { existing: true });
  const bounds = await panel.boundingBox();
  expect(bounds?.x).toBe(0); expect(bounds?.width).toBe(390);
  await expect(panel.getByRole("textbox", { name: "Mensagem para a equipe", exact: true })).toBeInViewport();
  await expect(panel.getByRole("button", { name: "Enviar mensagem", exact: true })).toBeInViewport();
  await panel.getByRole("combobox", { name: "Destino" }).selectOption("member-session-2");
  await panel.getByRole("button", { name: "Atualizar equipe", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest(".ad-team-panel"))).toBe(true);
  await page.screenshot({ path: ".local/validation/agent-team-narrow.png", animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await page.evaluate(async () => {
    const { useSessionStore } = await import("/src/store/sessionStore.ts" as string);
    useSessionStore.getState().updateSession("session-0", { coordinationEnabled: false });
  });
  await page.getByRole("button", { name: "Equipe de agentes", exact: true }).click();
  await expect(panel).toContainText("A coordenação está desativada");
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  const previous = await page.evaluate(() => (window as any).__teamCalls.length);
  await page.evaluate(() => window.dispatchEvent(new Event("agentdeck-team-changed")));
  expect(await page.evaluate(() => (window as any).__teamCalls.length)).toBe(previous);
  await panel.getByRole("button", { name: "Ativar coordenação neste chat" }).click();
  await expect(panel.getByRole("heading", { name: "Integração conjunta", exact: true })).toBeVisible();
});
