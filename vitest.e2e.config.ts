import { defineConfig } from "vitest/config";

/**
 * End-to-End-Tests, die nur gezielt laufen (`npm run test:package`,
 * `npm run test:smoke`): sie brauchen Netz (npm install) bzw. eine echte
 * Anmeldung bei Anthropic.
 */
export default defineConfig({
    test: {
        include: ["test/e2e/**/*.test.ts"],
        testTimeout: 600000,
        hookTimeout: 600000,
        fileParallelism: false,
    },
});
