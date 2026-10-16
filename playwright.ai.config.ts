import { defineConfig, devices } from "@playwright/test";
const port = Number(process.env.PAWMEET_AI_LIVE_PORT ?? 3105);
const origin = `http://localhost:${port}`;
export default defineConfig({
  testDir: "./tests/live",
  testMatch: "ai.spec.ts",
  workers: 1,
  timeout: 120000,
  reporter: [
    ["list"],
    ["json", { outputFile: ".local/ai-live/playwright-report.json" }],
  ],
  use: { baseURL: origin, trace: "retain-on-failure" },
  projects: [
    { name: "glm-live-desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `npm run start -- --port ${port}`,
    url: origin,
    reuseExistingServer: false,
    timeout: 60000,
    env: { APP_ORIGIN: origin, AI_ENABLED: "true" },
  },
});
