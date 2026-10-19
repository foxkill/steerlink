import { defineConfig } from "vitest/config";

/**
 * End-to-end tests that only run on demand (`npm run test:package`,
 * `npm run test:smoke`): they need network access (npm install) or real
 * Anthropic credentials, respectively.
 */
export default defineConfig({
    test: {
        include: ["test/e2e/**/*.test.ts"],
        testTimeout: 600000,
        hookTimeout: 600000,
        fileParallelism: false,
    },
});
