import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for auth-service e2e tests.
 *
 * The full Docker Compose stack (postgres + auth-service + testapp + setup)
 * is expected to be running before Playwright starts.
 *
 * Start with:
 *   docker compose -f tests/e2e/docker-compose.yml up --wait
 *
 * Then run:
 *   pnpm test:e2e
 *
 * Or use the combined script:
 *   pnpm test:e2e:docker
 */
export default defineConfig({
  testDir: "./specs",
  fullyParallel: false,
  retries: process.env["CI"] ? 2 : 0,
  workers: 1,
  reporter: process.env["CI"] ? "github" : "list",
  timeout: 30_000,

  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
