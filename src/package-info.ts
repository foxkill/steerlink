import { createRequire } from "node:module";

import { z } from "zod";

const packageJsonSchema = z.object({
    name: z.string().min(1),
    version: z.string().min(1),
});

/**
 * Name and version come from package.json so that the MCP server, ACP client,
 * plugin manifest and npm package never drift apart. The path is correct for
 * both `src/` (tsx) and `dist/` (build and installed package).
 */
const packageJson = packageJsonSchema.parse(createRequire(import.meta.url)("../package.json"));

export const PACKAGE_NAME: string = packageJson.name;
export const PACKAGE_VERSION: string = packageJson.version;
