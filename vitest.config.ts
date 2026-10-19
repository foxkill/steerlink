import { defineConfig } from "vitest/config";

/** Schnelle, hermetische Tests: kein Netz, keine Kosten, keine Anmeldung. */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**", "**/node_modules/**"],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
