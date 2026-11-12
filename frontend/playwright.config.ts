import { existsSync } from "node:fs";

import { defineConfig, devices } from "@playwright/test";

// E2E runs against a real stack: `docker compose up` (web on 8080) in CI, or `npm run dev` (5173) locally.
// The API must run with ENV=dev, so local accounts exist and the agent uses the deterministic fake provider.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5173";
// Use the installed Chrome when there is one (no browser download); CI installs Playwright's Chromium.
const chrome = !process.env.CI && existsSync("C:/Program Files/Google/Chrome/Application/chrome.exe");

export default defineConfig({
  testDir: "e2e",
  // Screenshot capture for the landing page only runs on request: CAPTURE=1 npx playwright test capture
  grepInvert: process.env.CAPTURE ? undefined : /@capture/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
    ...(chrome ? { channel: "chrome" } : {}),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, ...(chrome ? { channel: "chrome" } : {}) } }],
});
