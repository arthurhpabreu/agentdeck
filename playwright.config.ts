import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:1420", viewport: { width: 1360, height: 900 }, screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { browserName: "chromium", channel: process.env.PLAYWRIGHT_CHANNEL || (process.env.CI || process.platform !== "win32" ? "chromium" : "msedge") } },
    { name: "webkit", grep: /@macos/, use: { browserName: "webkit" } },
  ],
  webServer: { command: "corepack pnpm dev --host 127.0.0.1", url: "http://127.0.0.1:1420", reuseExistingServer: !process.env.CI },
});
