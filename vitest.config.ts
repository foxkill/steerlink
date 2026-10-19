import { defineConfig } from "vitest/config";

/** Fast, hermetic tests: no network, no cost, no sign-in. */
export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        exclude: ["test/e2e/**", "**/node_modules/**"],
        testTimeout: 60000,
        hookTimeout: 60000,
        fileParallelism: false,
    },
});
