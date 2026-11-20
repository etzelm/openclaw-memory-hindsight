import { defineConfig } from "vitest/config";

// The shared GitLab runner is slow under load, so give CI extra headroom. Local runs keep the
// vitest defaults. Vitest 5.1 has no option for the worker start-up timeout, so CI also runs
// fewer workers to cut start-up contention.
const ci = Boolean(process.env.CI);

export default defineConfig({
  test: {
    ...(ci && { testTimeout: 20_000, hookTimeout: 30_000, teardownTimeout: 30_000, maxWorkers: 2 }),
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
