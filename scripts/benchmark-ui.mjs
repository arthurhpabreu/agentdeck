import { chromium } from "@playwright/test";
import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const phase = process.argv[2];
if (!["before", "after"].includes(phase)) throw new Error("Use before or after; start the comparison servers first.");
// Writes only synthetic benchmark artifacts. No provider accounts or model requests.
const outputDirectory = ".local/benchmarks";
const { mkdirSync } = await import("node:fs"); mkdirSync(outputDirectory, { recursive: true });
const url = phase === "before" ? "http://127.0.0.1:1421" : "http://127.0.0.1:1420";
const source = ts.createSourceFile("fixture.ts", readFileSync("tests/e2e/workspace.spec.ts", "utf8"), ts.ScriptTarget.Latest, true);
let initializer;
function find(node) { if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "addInitScript" && !initializer) initializer = node.arguments[0].getText(source); ts.forEachChild(node, find); }
find(source);
writeFileSync(".local/benchmarks/native-fixture.mjs", ts.transpileModule(`export default ${initializer};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
const { default: nativeFixture } = await import(pathToFileURL(resolve(".local/benchmarks/native-fixture.mjs")).href);
const browser = await chromium.launch({ channel: process.argv.includes("--edge") ? "msedge" : undefined, headless: true });
const measurements = [];
for (const sessionCount of [5, 20, 50]) {
  console.log(`Benchmark ${phase}: ${sessionCount} sessions`);
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(nativeFixture, { locale: "en" });
  await page.addInitScript(({ sessionCount }) => {
    const w = window;
    w.__benchStopped = new Set();
    const nativeInvoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (command, args) => { if (command === "stop_chat_turn") w.__benchStopped.add(args.sessionId); return nativeInvoke(command, args); };
    const sessions = Array.from({ length: sessionCount }, (_, i) => ({ id: `session-${i}`, name: `Load session ${i}`, workspaceId: "project", workdir: "C:/fixture", createdAt: i + 1, currentTask: "", status: "idle", runner: { type: "codex" }, output: [], diffFiles: [] }));
    localStorage.setItem("agentdeck-sessions", JSON.stringify({ state: { sessions, activeSessionId: "session-0" }, version: 0 }));
    const original = Storage.prototype.setItem;
    w.__localWriteCount = 0;
    Storage.prototype.setItem = function(key, value) { w.__localWriteCount++; original.call(this, key, value); };
  }, { sessionCount });
  await page.goto(url);
  await page.getByText("Load session 0", { exact: true }).first().click();
  const input = page.locator(".ad-chat-composer textarea:visible");
  await input.waitFor({ state: "visible" });
  await page.evaluate(async ({ sessionCount }) => {
    const sessionPath = "/src/store/sessionStore.ts", chatPath = "/src/store/chatStore.ts";
    const { useSessionStore } = await import(sessionPath), { useChatStore, ensureChatEvents } = await import(chatPath);
    await ensureChatEvents();
    const w = window;
    const largeText = "Detailed contextual project history café 👩‍💻\n".repeat(4096);
    useChatStore.getState().patch("session-0", { messages: Array.from({ length: 100 }, (_, i) => ({ id: `history-${i}`, role: "assistant", text: largeText, at: i, order: i })), draft: "", busy: false });
    w.__historyBytes = new TextEncoder().encode(largeText).length * 100;
    for (let i = 0; i < Math.min(8, sessionCount); i++) {
      useChatStore.getState().patch(`session-${i}`, { busy: true, turnId: `load-turn-${i}`, status: "working" });
      w.__chatTurns[`session-${i}`] = `load-turn-${i}`;
    }
    w.__sessionStore = useSessionStore;
    w.__chatStore = useChatStore;
    w.__typedLatency = [];
    const input = document.querySelector(".ad-chat-composer textarea");
    input.addEventListener("input", () => { const started = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => w.__typedLatency.push(performance.now() - started))); });
  }, { sessionCount });
  await page.waitForTimeout(600);
  if (!await page.locator(".ad-chat-messages").evaluate(element => element.textContent.includes("Detailed contextual project history"))) throw new Error("Seeded transcript did not reach the application view; restart Vite to discard stale test modules.");
  const cdp = await context.newCDPSession(page); await cdp.send("Performance.enable");
  const before = await cdp.send("Performance.getMetrics");
  const counters = await page.evaluate(() => ({ native: window.__calls.length, local: window.__localWriteCount }));
  await page.evaluate(({ sessionCount }) => {
    const w = window; let count = 0;
    w.__streamTimer = setInterval(() => {
      for (let i = 0; i < Math.min(8, sessionCount); i++) {
        if (w.__benchStopped.has(`session-${i}`)) continue;
        w.__emit("chat-event", { sessionId: `session-${i}`, turnId: `load-turn-${i}`, kind: "text", itemId: "streamed-answer", text: `Reliable streaming chunk café ${count}. `, delta: true });
        w.__sessionStore.getState().appendOutput(`session-${i}`, `activity ${count}`);
      }
      count++;
    }, 16);
  }, { sessionCount });
  await input.pressSequentially("typing during eight streams", { delay: 15 });
  const switches = [];
  for (let i = 1; i <= Math.min(sessionCount - 1, 8); i++) {
    const start = performance.now();
    await page.getByText(`Load session ${i}`, { exact: true }).first().click();
    await page.locator(".ad-session-tabs:visible").filter({ hasText: `Load session ${i}` }).waitFor({ state: "visible" });
    switches.push(performance.now() - start);
  }
  await page.getByText("Load session 0", { exact: true }).first().click();
  await page.locator(".ad-session-tabs:visible").filter({ hasText: "Load session 0" }).waitFor({ state: "visible" });
  const cancelStart = performance.now();
  await page.getByRole("button", { name: "Stop response", exact: true }).click();
  await page.getByRole("button", { name: "Stop response", exact: true }).waitFor({ state: "hidden" });
  const cancelMs = performance.now() - cancelStart;
  await page.evaluate(() => clearInterval(window.__streamTimer));
  await page.waitForTimeout(300);
  const after = await cdp.send("Performance.getMetrics");
  const totals = await page.evaluate(({ start }) => ({ historyBytes: window.__historyBytes, typed: window.__typedLatency, nativeCalls: window.__calls.slice(start.native).length, nativeWrites: window.__calls.slice(start.native).filter(call => call.command === "save_ui_state").length, localWrites: window.__localWriteCount - start.local, mountedPanels: document.querySelectorAll(".ad-session-tabs").length }), { start: counters });
  const metric = (collection, name) => collection.metrics.find(metric => metric.name === name)?.value;
  const percentiles = values => { const sorted = [...values].sort((a, b) => a - b); return { samples: sorted.length, p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] }; };
  measurements.push({ sessions: sessionCount, streams: Math.min(8, sessionCount), historyBytes: totals.historyBytes, typing: percentiles(totals.typed), switching: percentiles(switches), cancelMs, nativeCalls: totals.nativeCalls, nativeWrites: totals.nativeWrites, localWrites: totals.localWrites, mountedPanels: totals.mountedPanels, taskCpuSeconds: metric(after, "TaskDuration") - metric(before, "TaskDuration"), scriptCpuSeconds: metric(after, "ScriptDuration") - metric(before, "ScriptDuration"), jsHeapBytes: metric(after, "JSHeapUsedSize") });
  await context.close();
}
await browser.close();
const result = { phase, browser: "Headless Microsoft Edge/Chromium", viewport: "1360x900", nativeBoundary: "Mocked; no account/model/real PTY", limitations: "CDP CPU/heap reflect browser renderer only, not native WebView/agent process. Latencies include automation and two animation frames; not absolute responsiveness guarantees. Drag and native memory/IPC queue peaks are separately functional-tested, not statistically benchmarked here.", measurements };
writeFileSync(`.local/benchmarks/v080-ui-${phase}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
