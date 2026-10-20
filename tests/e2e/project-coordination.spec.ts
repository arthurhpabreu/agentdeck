import { expect, test } from "@playwright/test";
import { setupImprovements } from "./improvements-fixtures";

test("project chats show peer activity, exchange notes without starting turns, and support opting out @macos", async ({ page }) => {
  await setupImprovements(page);
  await page.evaluate(() => {
    const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
    w.__coordinationCalls = [];
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === "coordination_call") {
        w.__coordinationCalls.push(args);
        if (args.name === "project_peers") return JSON.stringify({ peers:[{ sessionId:args.input.offset ? "session-2" : "session-1", name:args.input.offset ? "Conversa 2" : "Conversa 1", provider:"gemini", workdir:"C:\\fixtures\\one", status:"running", activity:"Revendo integração", summary:args.input.offset ? "Revisando testes" : "Trabalhando em src/api.ts", updatedAt:Date.now(), stale:false }], nextOffset:args.input.offset ? null : 1 });
        if (args.name === "project_inbox") return JSON.stringify({ messages:args.input.after ? [] : [{ seq:7, sender:"session-1", message:"Reservei src/api.ts; revise os testes.", createdAt:Date.now() }], cursor:7 });
        return JSON.stringify({ queued:true });
      }
      return original(command, args);
    };
  });
  await page.getByRole("button", { name:"Chats do projeto", exact:true }).click();
  const panel = page.getByRole("region", { name:"Chats do projeto" });
  await expect(panel).toContainText("Trabalhando em src/api.ts");
  await expect(panel).toContainText("Reservei src/api.ts; revise os testes.");
  await panel.getByRole("button", { name:"Outros chats +", exact:true }).click();
  await expect(panel).toContainText("Revisando testes");
  await panel.getByRole("textbox", { name:"Nota de coordenação", exact:true }).fill("Vou revisar os testes; preserve minha worktree.");
  await panel.getByRole("button", { name:"Enviar nota", exact:true }).click();
  await expect(panel.getByRole("status")).toContainText("Nota guardada");
  const calls = await page.evaluate(() => (window as any).__coordinationCalls);
  expect(calls.find((call: any) => call.name === "project_send").input).toEqual({ sessionId:"session-1", message:"Vou revisar os testes; preserve minha worktree." });
  expect(await page.evaluate(() => (window as any).__improvementCalls.filter((call: any) => ["start_chat_turn","steer_chat_turn","send_pty_query"].includes(call.command)))).toEqual([]);
  await page.screenshot({ path:"test-results/project-coordination-enabled.png", animations:"disabled" });
  await panel.getByRole("checkbox", { name:"Compartilhar atividade e receber notas" }).uncheck();
  await expect(panel).toContainText("A coordenação está desativada");
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__improvementCalls.filter((call: any) => call.command === "coordination_sync_sessions").at(-1)?.args.entries.find((entry: any) => entry.sessionId === "session-0")?.enabled)).toBe(false);
  await page.screenshot({ path:"test-results/project-coordination.png", animations:"disabled" });
});
