import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["src/tests/global-setup.ts"],
    setupFiles: ["src/tests/setup-env.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Run files sequentially — avoids parallel container connections and
    // cleanDb races between test files.
    fileParallelism: false,
  },
});
