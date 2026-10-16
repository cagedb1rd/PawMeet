import { defineConfig, devices } from "@playwright/test";
const port = Number(process.env.PAWMEET_E2E_PORT ?? 3103);
export default defineConfig({
  testDir: "./tests/live",
  outputDir: ".local/maps-live",
  fullyParallel: false,
  workers: 1,
  timeout: 150000,
  use: { baseURL: `http://localhost:${port}`, trace: "off" },
  projects: [
    {
      name: "desktop-live",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile-live",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    command: `npm run start -- --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 120000,
  },
});
