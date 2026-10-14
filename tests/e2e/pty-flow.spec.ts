import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/pty-flow-fixture", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }));
  await page.goto("/pty-flow-fixture");
  await page.evaluate(() => {
    const w = window as any;
    const callbacks = new Map<number, Function>(), listeners = new Map<string, number[]>(); let sequence = 0;
    w.__calls = []; w.__archive = {}; w.__deferred = [];
    w.__emit = (event: string, payload: unknown) => (listeners.get(event) ?? []).forEach(id => callbacks.get(id)?.({ event, id, payload }));
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = { transformCallback: (callback: Function) => { callbacks.set(++sequence, callback); return sequence; }, unregisterCallback: (id: number) => callbacks.delete(id), invoke: async (command: string, args: any) => {
      w.__calls.push({ command, args });
      if (command === "plugin:event|listen") { listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler]); return ++sequence; }
      if (command === "read_pty_output") {
        const archive = w.__archive[args.sessionId]; if (!archive) return null;
        const bytes: number[] = archive.bytes.slice(args.offset, args.offset + Math.min(args.maxBytes, 65536));
        return { runId: archive.runId, data: btoa(bytes.map(byte => String.fromCharCode(byte)).join("")), nextOffset: args.offset + bytes.length, endOffset: archive.bytes.length, closed: false };
      }
      if (command === "write_pty") await new Promise(resolve => setTimeout(resolve, 2));
      return null;
    } };
  });
});

test("@macos 20 subscribers use one event listener, route exact UTF-8 bytes and ACK only consumed output", async ({ page }) => {
  const initial = await page.evaluate(async () => {
    const modulePath = "/src/services/ptyOutputRouter.ts"; const router = await import(/* @vite-ignore */ modulePath);
    const w = window as any; w.__received = {}; w.__subscriptions = [];
    for (let i = 0; i < 20; i++) {
      const id = `pty-${i}`; w.__received[id] = [];
      const sub = router.attachPtyOutput(id, { data: (bytes: Uint8Array) => { w.__received[id].push(...bytes); return id === "pty-7" ? new Promise(resolve => w.__deferred.push(resolve)) : Promise.resolve(); } });
      w.__subscriptions.push(sub); await sub.ready;
    }
    const bytes = new TextEncoder().encode("\x1b[32mcafé 👩‍💻\x1b[0m\r\n");
    w.__expected = [...bytes];
    const split = 9;
    for (const [offset, end] of [[0, split], [split, bytes.length]]) w.__emit("pty-data", { session_id: "pty-7", run_id: 42, offset, end_offset: end, data: btoa([...bytes.slice(offset, end)].map(byte => String.fromCharCode(byte)).join("")) });
    await new Promise(resolve => setTimeout(resolve, 20));
    return { listeners: w.__calls.filter((call: any) => call.command === "plugin:event|listen" && call.args.event === "pty-data").length, acknowledgements: w.__calls.filter((call: any) => call.command === "ack_pty_output").length };
  });
  expect(initial).toEqual({ listeners: 1, acknowledgements: 0 });
  await page.evaluate(() => (window as any).__deferred.shift()());
  await expect.poll(() => page.evaluate(() => (window as any).__deferred.length)).toBe(1);
  await page.evaluate(() => (window as any).__deferred.shift()());
  const result = await page.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 10)); const w = window as any; return { received: w.__received["pty-7"], expected: w.__expected, otherBytes: Object.entries(w.__received).filter(([key]) => key !== "pty-7").flatMap(([, bytes]: any) => bytes).length, acks: w.__calls.filter((call: any) => call.command === "ack_pty_output").map((call: any) => call.args.endOffset) }; });
  expect(result.received).toEqual(result.expected); expect(result.otherBytes).toBe(0); expect(result.acks).toEqual([9, result.expected.length]);
});

test("@macos detaching a renderer preserves the child and replays a large archive in bounded exact chunks", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const modulePath = "/src/services/ptyOutputRouter.ts"; const router = await import(/* @vite-ignore */ modulePath);
    const w = window as any;
    const first = router.attachPtyOutput("replay", { data: () => Promise.resolve() }); await first.ready; first.dispose();
    const bytes = new TextEncoder().encode("ANSI \x1b[36m café 👩‍💻\x1b[0m\r\n".repeat(40000));
    w.__archive.replay = { runId: 8, bytes: [...bytes] };
    w.__emit("pty-data", { session_id: "replay", run_id: 8, offset: 0, end_offset: bytes.length, data: "" });
    let received = 0, mismatch = false, maximum = 0;
    const second = router.attachPtyOutput("replay", { data: chunk => { maximum = Math.max(maximum, chunk.length); for (let i = 0; i < chunk.length; i++) if (bytes[received + i] !== chunk[i]) mismatch = true; received += chunk.length; return Promise.resolve(); } });
    await second.ready; second.dispose();
    return { received, expected: bytes.length, mismatch, maximum, stopCalls: w.__calls.filter((call: any) => call.command === "stop_pty_session").length };
  });
  expect(result.received).toBe(result.expected); expect(result.mismatch).toBe(false); expect(result.maximum).toBeLessThanOrEqual(65536); expect(result.stopCalls).toBe(0);
});

test("@macos large paste preserves every byte and services interrupt between chunks", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const modulePath = "/src/services/ptyInput.ts"; const { writePtyInput } = await import(/* @vite-ignore */ modulePath);
    const w = window as any; const text = "café 👩‍💻\n".repeat(30000);
    const paste = writePtyInput("input", text); const interrupt = writePtyInput("input", "\x03"); const typing = writePtyInput("input", "echo ready\r");
    await Promise.all([paste, interrupt, typing]);
    const chunks = w.__calls.filter((call: any) => call.command === "write_pty").map((call: any) => atob(call.args.data));
    const controlIndex = chunks.findIndex((chunk: string) => chunk === "\x03");
    const bytes = Uint8Array.from(chunks.filter((chunk: string) => chunk !== "\x03").join(""), (char: string) => char.charCodeAt(0));
    return { controlIndex, received: new TextDecoder().decode(bytes), expected: text + "echo ready\r", maxChunk: Math.max(...chunks.map((chunk: string) => chunk.length)) };
  });
  expect(result.controlIndex).toBe(1); expect(result.received).toBe(result.expected); expect(result.maxChunk).toBeLessThanOrEqual(16384);
});
