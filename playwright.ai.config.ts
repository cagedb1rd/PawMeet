if (process.env.PAWMEET_ALLOW_LIVE_AI !== "approved")
  throw Error(
    "真实Qwen测试默认关闭；必须先获得用户明确批准，再设置PAWMEET_ALLOW_LIVE_AI=approved。原Phase4页面套件须按当前入口复核后才能执行。",
  );
import { defineConfig, devices } from "@playwright/test";
const port = Number(process.env.PAWMEET_AI_LIVE_PORT ?? 3105);
const origin = `http://localhost:${port}`;
const quotaPath = `.local/ai-live/${new Date().toISOString().replace(/[:.]/g, "-")}.quota.json`;
export default defineConfig({
  testDir: "./tests/live",
  testMatch: "ai.spec.ts",
  outputDir: ".local/ai-live/test-results",
  workers: 1,
  timeout: 120000,
  reporter: [
    ["list"],
    ["json", { outputFile: ".local/ai-live/playwright-report.json" }],
  ],
  use: { baseURL: origin, trace: "retain-on-failure" },
  projects: [
    { name: "qwen-live-desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `npm run start -- --port ${port}`,
    url: origin,
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      APP_ORIGIN: origin,
      AI_ENABLED: "true",
      AI_MAX_DAILY_CALLS: "3",
      QUOTA_STORE_PATH: quotaPath,
    },
  },
});
