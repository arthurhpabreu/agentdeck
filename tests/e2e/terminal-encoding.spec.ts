import { expect, test } from "@playwright/test";

test("large UTF-8 terminal input preserves accents, emoji and newlines without overflowing the stack", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/services/terminalEncoding.ts";
    const { encodeTerminalInput } = await import(/* @vite-ignore */ modulePath);
    const input = "ação 漢字 🙂\r\n\t".repeat(30_000);
    const encoded = encodeTerminalInput(input);
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(encoded), character => character.charCodeAt(0)));
    return {
      bytes: new TextEncoder().encode(input).byteLength,
      roundTrip: decoded === input,
      empty: encodeTerminalInput(""),
      ascii: atob(encodeTerminalInput("git status\r")),
    };
  });
  expect(result.bytes).toBeGreaterThan(256 * 1024);
  expect(result.roundTrip).toBe(true);
  expect(result.empty).toBe("");
  expect(result.ascii).toBe("git status\r");
});
