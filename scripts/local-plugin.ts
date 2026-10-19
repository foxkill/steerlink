/**
 * Installs this plugin into Cursor's local plugin folder for testing before
 * it is published (https://cursor.com/docs/plugins.md#test-plugins-locally),
 * then starts the MCP server exactly as the installed mcp.json describes and
 * checks it.
 *
 * The installed mcp.json runs `npx -y <local tarball>` instead of the npm
 * registry, so the test uses the same install path as real users.
 *
 * Usage:
 *   npm run plugin:local                     # install + verify (api_key mode)
 *   npm run plugin:local -- --subscription   # use your own Claude Code login instead
 *   npm run plugin:local -- --remove         # uninstall
 *   npm run plugin:local -- --target <dir>   # custom install folder
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

import { validatePlugin } from "./validate-plugin.js";

const repoRoot = resolve(import.meta.dirname, "..");

/** Files that make up the plugin; mcp.json is written separately. */
const PLUGIN_FILES = [".cursor-plugin", "skills", "assets", "README.md", "LICENSE"];

const manifestSchema = z.object({ name: z.string().min(1), version: z.string().min(1) });
const mcpSchema = z.object({
    mcpServers: z.record(
        z.string(),
        z.object({
            command: z.string(),
            args: z.array(z.string()).default([]),
            env: z.record(z.string(), z.string()).default({}),
        }),
    ),
});
const authStatusSchema = z.object({
    auth_mode: z.string(),
    effective_method: z.string(),
    problem: z.string().nullable(),
});

type McpConfig = z.infer<typeof mcpSchema>;

function npm(args: string[], cwd: string): string {
    const npmCli = process.env.npm_execpath;
    if (npmCli !== undefined && /npm-cli\.[cm]?js$/.test(npmCli)) {
        return execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: "utf8" });
    }
    return execFileSync("npm", args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
}

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, "utf8"));
}

/** Replaces `${VAR}` with the value from the environment, like a host with the variable configured. */
function expandVariables(value: string): string {
    return value.replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (placeholder, name: string) => {
        const resolved = process.env[name];
        return resolved === undefined || resolved.length === 0 ? placeholder : resolved;
    });
}

function install(target: string, subscription: boolean): McpConfig {
    const result = validatePlugin(repoRoot);
    if (result.errors.length > 0) {
        throw new Error(`Plugin check failed:\n- ${result.errors.join("\n- ")}`);
    }

    console.log("Building and packing …");
    npm(["run", "build"], repoRoot);
    rmSync(target, { recursive: true, force: true });
    const packageDir = join(target, "package");
    mkdirSync(packageDir, { recursive: true });
    npm(["pack", "--ignore-scripts", "--pack-destination", packageDir], repoRoot);
    const tarball = readdirSync(packageDir).find((file) => file.endsWith(".tgz"));
    if (tarball === undefined) {
        throw new Error("npm pack did not produce a tarball");
    }
    // npm only recognizes a local tarball reliably as a `file:` spec with forward slashes (Windows too).
    const tarballSpec = `file:${join(packageDir, tarball).replaceAll("\\", "/")}`;

    for (const entry of PLUGIN_FILES) {
        const source = join(repoRoot, entry);
        if (existsSync(source)) {
            cpSync(source, join(target, entry), { recursive: true });
        }
    }

    const manifest = manifestSchema.parse(readJson(join(repoRoot, ".cursor-plugin", "plugin.json")));
    const mcp = mcpSchema.parse(readJson(join(repoRoot, "mcp.json")));
    const published = `${manifest.name}@${manifest.version}`;
    for (const server of Object.values(mcp.mcpServers)) {
        server.args = server.args.map((arg) => (arg === published ? tarballSpec : arg));
        if (subscription) {
            server.env.ACP_CONNECTOR_AUTH_MODE = "subscription";
        }
    }
    writeFileSync(join(target, "mcp.json"), `${JSON.stringify(mcp, null, 4)}\n`);
    console.log(`Installed to ${target}`);
    return mcp;
}

async function verify(mcp: McpConfig, subscription: boolean): Promise<boolean> {
    let ok = true;
    for (const [name, server] of Object.entries(mcp.mcpServers)) {
        console.log(`\nStarting "${name}" as the host would: ${server.command} ${server.args.join(" ")}`);
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
                env[key] = value;
            }
        }
        for (const [key, value] of Object.entries(server.env)) {
            env[key] = expandVariables(value);
        }
        const client = new Client({ name: "local-plugin-check", version: "1.0.0" });
        const transport = new StdioClientTransport({
            command: server.command,
            args: server.args,
            env,
            cwd: tmpdir(),
            stderr: "inherit",
        });
        try {
            // The first start may download dependencies (about 300 MB) into the npx cache.
            await client.connect(transport, { timeout: 600_000 });
            const tools = (await client.listTools()).tools.map((tool) => tool.name);
            console.log(`Server: ${JSON.stringify(client.getServerVersion())}`);
            console.log(`Tools (${tools.length}): ${tools.join(", ")}`);
            const result = await client.callTool({ name: "auth_status", arguments: {} }, undefined, {
                timeout: 120_000,
            });
            const content = z.array(z.object({ text: z.string() })).parse(result.content);
            const status = authStatusSchema.parse(JSON.parse(content.map((item) => item.text).join("")));
            console.log(`auth_mode: ${status.auth_mode}`);
            console.log(`effective_method: ${status.effective_method}`);
            console.log(`problem: ${status.problem ?? "none"}`);
            if (tools.length !== 12) {
                ok = false;
            }
            if (status.problem !== null && (subscription || process.env.ANTHROPIC_API_KEY !== undefined)) {
                ok = false;
            }
        } finally {
            await client.close();
        }
    }
    return ok;
}

async function main(): Promise<number> {
    const { values } = parseArgs({
        options: {
            subscription: { type: "boolean", default: false },
            remove: { type: "boolean", default: false },
            target: { type: "string" },
            "no-verify": { type: "boolean", default: false },
        },
    });
    const manifest = manifestSchema.parse(readJson(join(repoRoot, ".cursor-plugin", "plugin.json")));
    const target = resolve(values.target ?? join(homedir(), ".cursor", "plugins", "local", manifest.name));

    if (values.remove) {
        rmSync(target, { recursive: true, force: true });
        console.log(`Removed ${target}. Reload Cursor (Developer: Reload Window).`);
        return 0;
    }

    const mcp = install(target, values.subscription);
    if (values["no-verify"]) {
        return 0;
    }
    const ok = await verify(mcp, values.subscription);
    console.log(
        ok
            ? "\nLocal plugin check passed. In Cursor: run Developer: Reload Window, open Customize and confirm the plugin."
            : "\nLocal plugin check FAILED (see above).",
    );
    if (!values.subscription && process.env.ANTHROPIC_API_KEY === undefined) {
        console.log(
            "Note: no ANTHROPIC_API_KEY in this shell, so the server reports the missing key. " +
                "Set the plugin variable in the host, or rerun with --subscription to use your own Claude Code login.",
        );
    }
    return ok ? 0 : 1;
}

try {
    process.exitCode = await main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
