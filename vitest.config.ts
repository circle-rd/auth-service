import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      reporter: ["text", "lcov"],
      include: ["src/routes/**", "src/services/**"],
      thresholds: { lines: 80 },
    },
  },
});
