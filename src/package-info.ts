import { createRequire } from "node:module";

interface PackageJson {
  name: string;
  version: string;
}

/**
 * Name und Version kommen aus package.json, damit MCP-Server, ACP-Client,
 * Plugin-Manifest und npm-Paket nie auseinanderlaufen. Der Pfad stimmt sowohl
 * für `src/` (tsx) als auch für `dist/` (Build und installiertes Paket).
 */
const packageJson = createRequire(import.meta.url)("../package.json") as PackageJson;

export const PACKAGE_NAME: string = packageJson.name;
export const PACKAGE_VERSION: string = packageJson.version;
