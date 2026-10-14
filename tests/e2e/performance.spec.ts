import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("session output keeps durable persistence independent of streaming volume", async ({ page }) => {
  await page.route("**/performance-fixture", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }));
  await page.goto("/performance-fixture");
  const result = await page.evaluate(async () => {
    const w = window as any;
    let nativeWrites = 0, localWrites = 0;
    w.__TAURI_INTERNALS__ = { invoke: async (command: string) => { if (command === "save_ui_state") nativeWrites++; return null; } };
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { localWrites++; original.call(this, key, value); };
    const sessionPath = "/src/store/sessionStore.ts";
    const { useSessionStore } = await import(/* @vite-ignore */ sessionPath);
    const measurements: any[] = [];
    for (const count of [5, 20, 50]) {
      const sessions = Array.from({ length: count }, (_, i) => ({ id: `session-${i}`, name: `Session ${i}`, workspaceId: "project", workdir: "C:/fixture", status: "idle", currentTask: "", createdAt: i, runner: { type: "codex" }, diffFiles: [], output: [] }));
      useSessionStore.setState({ sessions, sessionOrderByWorkspace: { project: sessions.map(s => s.id) } });
      await new Promise(resolve => setTimeout(resolve, 120));
      nativeWrites = localWrites = 0;
      const samples: number[] = [];
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        const before = performance.now();
        useSessionStore.getState().appendOutput(`session-${i % Math.min(8, count)}`, `UTF-8 café 👩‍💻 ANSI \x1b[32m${i}\x1b[0m`);
        samples.push(performance.now() - before);
      }
      const elapsedMs = performance.now() - start;
      await new Promise(resolve => setTimeout(resolve, 120));
      samples.sort((a, b) => a - b);
      measurements.push({ sessions: count, streams: Math.min(8, count), events: 1000, elapsedMs, p50Ms: samples[500], p95Ms: samples[950], localWrites, nativeWrites, lastLine: useSessionStore.getState().sessions[999 % count]?.output.at(-1) });
    }
    Storage.prototype.setItem = original;
    return { browser: navigator.userAgent, measurements };
  });
  const phase = process.env.AGENTDECK_BENCHMARK_PHASE;
  if (phase) { const dir = join(process.cwd(), ".local", "benchmarks"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `v080-${phase}.json`), JSON.stringify(result, null, 2)); }
  if (phase !== "before") for (const sample of result.measurements) { expect(sample.localWrites).toBe(0); expect(sample.nativeWrites).toBe(0); }
  expect(result.measurements).toHaveLength(3);
});

test("slow native snapshots cannot overwrite a newer confirmed local revision", async ({ page }) => {
  await page.route("**/snapshot-fixture", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }));
  await page.goto("/snapshot-fixture");
  const result = await page.evaluate(async () => {
    const writes: string[] = []; let release: (() => void) | undefined;
    const w = window as any;
    w.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command !== "save_ui_state") return null;
      writes.push(args.value);
      if (writes.length === 1) await new Promise<void>(resolve => { release = resolve; });
      return null;
    } };
    const modulePath = "/src/store/persistStorage.ts";
    const { mirroredPersistStorage: storage } = await import(/* @vite-ignore */ modulePath);
    storage.setItem("snapshot-fixture", "revision-1");
    await new Promise(resolve => setTimeout(resolve, 50));
    storage.setItem("snapshot-fixture", "revision-2");
    storage.setItem("snapshot-fixture", "confirmed-revision-3");
    const immediate = localStorage.getItem("snapshot-fixture");
    const whileBlocked = [...writes];
    release!();
    await new Promise(resolve => setTimeout(resolve, 50));
    return { immediate, whileBlocked, writes };
  });
  expect(result.immediate).toBe("confirmed-revision-3");
  expect(result.whileBlocked).toEqual(["revision-1"]);
  expect(result.writes).toEqual(["revision-1", "confirmed-revision-3"]);
});
