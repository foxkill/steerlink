import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AgentInfo, AuthStatusResult, TurnResult } from "../../src/sessions/session-manager.js";
import { ConnectorClient, FAKE_AGENT_PATH, REPO_ROOT } from "../helpers/connector-client.js";

/**
 * Prüft das veröffentlichte Paket so, wie ein Host es nutzt (`npm run test:package`):
 * bauen, `npm pack`, Tarball in einen leeren Ordner installieren und die
 * installierte Binary über `npx` als MCP-Server starten. Braucht Netz für die
 * Abhängigkeiten (u. a. die native Claude-Binary des Agent SDK).
 */

const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    name: string;
    version: string;
};

const EXPECTED_TOOLS = [
    "auth_status",
    "authenticate",
    "cancel",
    "close_session",
    "get_session_updates",
    "list_agents",
    "list_pending_permissions",
    "list_sessions",
    "respond_permission",
    "send_prompt",
    "set_mode",
    "start_session",
];

interface PackResult {
    filename: string;
    files: Array<{ path: string }>;
}

function npm(args: string[], cwd: string): string {
    const npmCli = process.env.npm_execpath;
    if (npmCli && /npm-cli\.[cm]?js$/.test(npmCli)) {
        return execFileSync(process.execPath, [npmCli, ...args], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
    }
    return execFileSync("npm", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
    });
}

function listFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? listFiles(path) : [path];
    });
}

function directorySize(dir: string): number {
    return listFiles(dir).reduce((sum, file) => sum + statSync(file).size, 0);
}

function samePath(a: string, b: string): boolean {
    const normalize = (path: string): string => {
        const real = realpathSync(path);
        return process.platform === "win32" ? real.toLowerCase() : real;
    };
    return normalize(a) === normalize(b);
}

describe("npm-Paket: pack → install → npx", () => {
    const client = new ConnectorClient();
    const scratch = mkdtempSync(join(tmpdir(), "acp-package-test-"));
    const installDir = join(scratch, "host");
    const workDir = join(scratch, "work");
    let pack: PackResult;

    beforeAll(async () => {
        npm(["run", "build"], REPO_ROOT);
        // --ignore-scripts: der Build ist schon gelaufen, und Skript-Ausgaben würden das JSON verunreinigen.
        pack = (
            JSON.parse(
                npm(["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], REPO_ROOT),
            ) as PackResult[]
        )[0];

        mkdirSync(installDir, { recursive: true });
        mkdirSync(workDir, { recursive: true });
        writeFileSync(join(installDir, "package.json"), JSON.stringify({ name: "package-test-host", private: true }));
        const started = Date.now();
        npm(
            ["install", join(scratch, pack.filename), "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock"],
            installDir,
        );
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const megabytes = (directorySize(join(installDir, "node_modules")) / 1024 / 1024).toFixed(0);
        console.log(
            `Installation: ${seconds} s, node_modules ${megabytes} MB (erster npx-Start beim Nutzer lädt ähnlich viel)`,
        );

        const configPath = join(scratch, "agents.json");
        const tsxLoader = pathToFileURL(join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
        writeFileSync(
            configPath,
            JSON.stringify({
                agent_servers: { fake: { command: process.execPath, args: ["--import", tsxLoader, FAKE_AGENT_PATH] } },
            }),
        );

        // Wie im Plugin: npx startet die installierte Binary; --no-install verhindert einen Download.
        await client.connectCommand({
            command: "npx",
            args: ["--no-install", packageJson.name],
            cwd: installDir,
            isolated: true,
            env: {
                ACP_CONNECTOR_CONFIG: configPath,
                ACP_CONNECTOR_AUTH_MODE: "api_key",
                ANTHROPIC_API_KEY: "sk-test-not-a-real-key-123456",
                // Der Adapter soll keine Einstellungen im echten Benutzerprofil anfassen.
                CLAUDE_CONFIG_DIR: join(scratch, "claude-config"),
            },
        });
    });

    afterAll(async () => {
        await client.close();
        rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    });

    it("enthält genau den gebauten Code, keine Quellen, Tests, Source Maps oder Secrets", () => {
        const packed = pack.files.map((file) => file.path.replace(/\\/g, "/")).sort();
        const built = listFiles(join(REPO_ROOT, "dist"))
            .filter((file) => file.endsWith(".js"))
            .map((file) => relative(REPO_ROOT, file).replace(/\\/g, "/"));
        const docs = ["README.md", "package.json", ...(existsSync(join(REPO_ROOT, "LICENSE")) ? ["LICENSE"] : [])];
        expect(packed).toEqual([...built, ...docs].sort());
        expect(readFileSync(join(REPO_ROOT, "dist", "main.js"), "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    });

    it("meldet Name und Version aus package.json und bietet alle Tools an", async () => {
        expect(client.serverVersion()).toEqual({ name: packageJson.name, version: packageJson.version });
        expect((await client.listToolNames()).sort()).toEqual(EXPECTED_TOOLS);
    });

    it("findet claude-agent-acp in der Installation, nicht im Repo", async () => {
        const agents = (await client.call<{ agents: AgentInfo[] }>("list_agents")).data.agents;
        const claude = agents.find((agent) => agent.name === "claude");
        const adapterDir = join(installDir, "node_modules", "@agentclientprotocol", "claude-agent-acp");
        expect(claude?.args[0]).toBeDefined();
        expect(samePath(join(claude!.args[0], "..", ".."), adapterDir)).toBe(true);
    });

    it("startet den echten Claude-Adapter aus der Installation", async () => {
        const status = await client.call<AuthStatusResult>("auth_status", { agent: "claude" });
        expect(status.data.problem).toBeNull();
        expect(status.data.hide_claude_auth).toBe(true);
        expect(status.text).not.toContain("sk-test-not-a-real-key");
        const claude = (await client.call<{ agents: AgentInfo[] }>("list_agents")).data.agents.find(
            (agent) => agent.name === "claude",
        );
        expect(claude?.running).toBe(true);
        expect(claude?.agent_info?.name).toBeTruthy();
    });

    it("führt eine Session über die installierte Binary aus", async () => {
        const session = await client.call<{ session_id: string }>("start_session", {
            cwd: workDir,
            agent: "fake",
            mode: "acceptEdits",
        });
        expect(session.isError).toBe(false);
        const turn = await client.call<TurnResult>("send_prompt", {
            session_id: session.data.session_id,
            text: "write packaged.txt ok",
        });
        expect(turn.data.status).toBe("idle");
        expect(readFileSync(join(workDir, "packaged.txt"), "utf8")).toBe("ok");
        await client.call("close_session", { session_id: session.data.session_id });
    });
});
