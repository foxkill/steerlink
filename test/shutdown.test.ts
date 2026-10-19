import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, describe, expect, it, vi } from "vitest";

import { killProcessTree, SPAWN_IN_OWN_PROCESS_GROUP } from "../src/acp/process-tree.js";
import { ConnectorClient, FAKE_AGENT_PATH, REPO_ROOT } from "./helpers/connector-client.js";

interface Pids {
    agent: number;
    grandchild: number;
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: der Prozess existiert, gehört aber jemand anderem.
        return error instanceof Error && "code" in error && error.code === "EPERM";
    }
}

function readPids(path: string): Pids {
    return JSON.parse(readFileSync(path, "utf8")) as Pids;
}

const scratch = mkdtempSync(join(tmpdir(), "acp-shutdown-test-"));
const tsxLoader = pathToFileURL(join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;

afterAll(async () => {
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
});

describe("killProcessTree", () => {
    it("beendet einen Prozess samt Enkelprozess", async () => {
        const pidFile = join(scratch, "tree.json");
        // Elternprozess, der einen Enkel startet, dessen PID meldet und dann wartet.
        const script = [
            'const { spawn } = require("node:child_process");',
            'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });',
            `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ agent: process.pid, grandchild: child.pid }));`,
            "setInterval(() => {}, 1 << 30);",
        ].join("\n");
        const parent = spawn(process.execPath, ["-e", script], {
            stdio: "ignore",
            detached: SPAWN_IN_OWN_PROCESS_GROUP,
            windowsHide: true,
        });
        const pids = await vi.waitFor(() => readPids(pidFile), { timeout: 10_000, interval: 50 });
        expect([isAlive(pids.agent), isAlive(pids.grandchild)]).toEqual([true, true]);

        killProcessTree(parent);

        await vi.waitFor(
            () => {
                expect([isAlive(pids.agent), isAlive(pids.grandchild)]).toEqual([false, false]);
            },
            { timeout: 5_000, interval: 50 },
        );
    });
});

describe("Herunterfahren des Connectors", () => {
    it("lässt keinen Agent und keinen Enkelprozess zurück, auch wenn der Agent stdin ignoriert", async () => {
        const pidFile = join(scratch, "agent.json");
        const configPath = join(scratch, "config.json");
        writeFileSync(
            configPath,
            JSON.stringify({
                default_agent: "stubborn",
                agent_servers: {
                    stubborn: {
                        command: process.execPath,
                        args: ["--import", tsxLoader, FAKE_AGENT_PATH],
                        env: { FAKE_STUBBORN: "1", FAKE_PID_FILE: pidFile },
                    },
                },
            }),
        );
        const client = new ConnectorClient();
        await client.connect({ ACP_CONNECTOR_CONFIG: configPath }, false, true);
        const session = await client.call<{ session_id: string }>("start_session", { cwd: scratch });
        expect(session.isError).toBe(false);
        const pids = await vi.waitFor(
            () => {
                expect(existsSync(pidFile)).toBe(true);
                return readPids(pidFile);
            },
            { timeout: 10_000, interval: 50 },
        );
        expect([isAlive(pids.agent), isAlive(pids.grandchild)]).toEqual([true, true]);

        // Wie ein MCP-Host: stdin schließen; nach 2 s käme SIGTERM.
        const started = Date.now();
        await client.close();
        const closeMs = Date.now() - started;

        await vi.waitFor(
            () => {
                expect([isAlive(pids.agent), isAlive(pids.grandchild)]).toEqual([false, false]);
            },
            { timeout: 3_000, interval: 50 },
        );
        // Der Connector beendet sich selbst, bevor der Client zu SIGTERM greifen muss.
        expect(closeMs).toBeLessThan(2_000);
    });
});
