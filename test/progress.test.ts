import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { effectiveWaitSeconds } from "../src/mcp/mcp-server.js";
import { ConnectorClient, FAKE_AGENT_PATH } from "./helpers/connector-client.js";

describe("effectiveWaitSeconds", () => {
    it("caps waits at 100 s for hosts that do not ask for progress", () => {
        expect(effectiveWaitSeconds(120, false)).toBe(100);
        expect(effectiveWaitSeconds(600, false)).toBe(100);
        expect(effectiveWaitSeconds(30, false)).toBe(30);
        expect(effectiveWaitSeconds(0, false)).toBe(0);
    });

    it("keeps the requested wait for hosts that ask for progress", () => {
        expect(effectiveWaitSeconds(120, true)).toBe(120);
        expect(effectiveWaitSeconds(600, true)).toBe(600);
    });
});

describe("Progress while a call waits", () => {
    const client = new ConnectorClient();
    let configDir: string;

    beforeAll(async () => {
        configDir = mkdtempSync(join(tmpdir(), "steerlink-progress-"));
        const configPath = join(configDir, "config.json");
        writeFileSync(
            configPath,
            JSON.stringify({
                default_agent: "fake",
                agent_servers: { fake: { command: process.execPath, args: ["--import", "tsx", FAKE_AGENT_PATH] } },
            }),
        );
        await client.connect(
            { ACP_CONNECTOR_CONFIG: configPath, ACP_CONNECTOR_PROGRESS_INTERVAL_MS: "300" },
            false,
            true,
        );
    });

    afterAll(async () => {
        await client.close();
        await rm(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    });

    it("send_prompt reports rising progress to a host that asks for it", async () => {
        const session = await client.call<{ session_id: string }>("start_session", { cwd: configDir });
        const { data, progress } = await client.callWithProgress("send_prompt", {
            session_id: session.data.session_id,
            text: "slow",
        });
        expect(data.status).toBe("idle");
        expect(progress.length).toBeGreaterThanOrEqual(2);
        const values = progress.map((update) => update.progress);
        expect(values).toEqual(values.toSorted((a, b) => a - b));
        expect(progress[0]?.message).toMatch(/^Agent is working \(\d+ s\)$/);
        await client.call("close_session", { session_id: session.data.session_id });
    });

    it("get_session_updates reports progress while it long-polls", async () => {
        const session = await client.call<{ session_id: string }>("start_session", { cwd: configDir });
        const { progress } = await client.callWithProgress("get_session_updates", {
            session_id: session.data.session_id,
            wait_seconds: 1,
        });
        expect(progress.length).toBeGreaterThanOrEqual(1);
        expect(progress[0]?.message).toMatch(/^Waiting for the agent/);
        await client.call("close_session", { session_id: session.data.session_id });
    });

    it("a host that does not ask for progress gets none and the same result", async () => {
        const session = await client.call<{ session_id: string }>("start_session", { cwd: configDir });
        const turn = await client.call<{ status: string }>("send_prompt", {
            session_id: session.data.session_id,
            text: "hello",
        });
        expect(turn.data.status).toBe("idle");
        await client.call("close_session", { session_id: session.data.session_id });
    });
});
