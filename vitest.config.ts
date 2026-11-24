import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./frontend/src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "frontend/src/utils/**/*.test.ts",
      "frontend/src/stores/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "src/**/*.integration.test.ts"],
    setupFiles: ["src/tests/setup-unit.ts"],
    coverage: {
      reporter: ["text", "lcov"],
      include: ["src/routes/**", "src/services/**"],
      thresholds: { lines: 80 },
    },
  },
});
