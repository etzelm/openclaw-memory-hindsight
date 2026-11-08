import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-helpers.ts", "dist/**"],
      reporter: ["text", "text-summary", "cobertura", "html"],
      // Floors are measured coverage minus a margin (2026-11-08); they must only go up.
      thresholds: {
        lines: 94,
        branches: 86,
        functions: 95,
        statements: 93,
      },
    },
  },
});
