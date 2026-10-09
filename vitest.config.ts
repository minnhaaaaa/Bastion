import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/api/src/**/*.test.ts", "tests/**/*.test.ts"],
    // Each DB-backed file boots its own in-process Postgres (PGlite); under parallel load that
    // takes several seconds, so the 5s default is too tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
