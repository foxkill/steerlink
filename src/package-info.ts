import { createRequire } from "node:module";

import { z } from "zod";

const packageJsonSchema = z.object({
    name: z.string().min(1),
    version: z.string().min(1),
});

/**
 * Name und Version kommen aus package.json, damit MCP-Server, ACP-Client,
 * Plugin-Manifest und npm-Paket nie auseinanderlaufen. Der Pfad stimmt sowohl
 * für `src/` (tsx) als auch für `dist/` (Build und installiertes Paket).
 */
const packageJson = packageJsonSchema.parse(createRequire(import.meta.url)("../package.json"));

export const PACKAGE_NAME: string = packageJson.name;
export const PACKAGE_VERSION: string = packageJson.version;
