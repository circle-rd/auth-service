import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "src/**/*.integration.test.ts"],
    coverage: {
      reporter: ["text", "lcov"],
      include: ["src/routes/**", "src/services/**"],
      thresholds: { lines: 80 },
    },
  },
});
