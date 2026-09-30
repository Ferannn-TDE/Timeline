import { defineConfig } from "@playwright/test";

if (!process.env.LIVE_BASE_URL) throw Error("Set LIVE_BASE_URL to the actual local or deployed journal URL.");
export default defineConfig({
  testDir: "tests/live",
  workers: 1,
  reporter: "list",
  timeout: 90000,
  outputDir: "artifacts/live-browser",
  use: {
    baseURL: process.env.LIVE_BASE_URL,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  },
});
