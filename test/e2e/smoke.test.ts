import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AuthStatusResult, TurnResult, UpdatesResult } from "../../src/sessions/session-manager.js";
import { ConnectorClient } from "../helpers/connector-client.js";

/**
 * Echter Smoke-Test gegen claude-agent-acp (`npm run test:smoke`). Läuft nur mit
 * vorhandener Anmeldung: ANTHROPIC_API_KEY (Default) oder bewusst
 * ACP_CONNECTOR_AUTH_MODE=subscription mit vorhandenem Claude-Code-Login.
 */
const authMode = process.env.ACP_CONNECTOR_AUTH_MODE ?? "";
const hasAuth = Boolean(process.env.ANTHROPIC_API_KEY) || authMode === "subscription";
const enabled = hasAuth;

describe.skipIf(!enabled)("Smoke: Connector → claude-agent-acp", () => {
    const client = new ConnectorClient();
    let workDir: string;

    beforeAll(async () => {
        workDir = mkdtempSync(join(tmpdir(), "acp-connector-smoke-"));
        await client.connect({ ACP_CONNECTOR_AUTH_MODE: authMode }, true);
    });

    afterAll(async () => {
        await client.close();
        // Asynchron: ein synchrones rmSync blockiert mit seinen Wiederholungen die Event-Loop.
        await rm(workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    });

    it("auth_status zeigt die aktive Methode ohne Secrets", async () => {
        const status = await client.call<AuthStatusResult>("auth_status", {});
        expect(status.isError).toBe(false);
        expect(status.data.problem).toBeNull();
        expect(status.data.agent_reported).not.toBeNull();
        expect(status.text).not.toMatch(/sk-ant-|@/);
    });

    it("erzeugt hello.txt erst nach Freigabe", { timeout: 300000 }, async () => {
        const session = await client.call<{ session_id: string; current_mode: string }>("start_session", {
            cwd: workDir,
            mode: "default",
        });
        expect(session.data.current_mode).toBe("default");
        const sessionId = session.data.session_id;

        const turn = await client.call<TurnResult>("send_prompt", {
            session_id: sessionId,
            text: "Erzeuge hello.txt mit 'hi'",
            timeout_seconds: 180,
        });
        expect(turn.data.status).toBe("awaiting_permission");
        expect(existsSync(join(workDir, "hello.txt"))).toBe(false);

        // Jede Freigabe erteilen, bis der Turn fertig ist.
        const lastTurn = await vi.waitFor(
            async () => {
                const pending = await client.call<{ pending_permissions: Array<{ permission_id: string }> }>(
                    "list_pending_permissions",
                    { session_id: sessionId },
                );
                for (const permission of pending.data.pending_permissions) {
                    await client.call("respond_permission", {
                        permission_id: permission.permission_id,
                        decision: "allow",
                    });
                }
                const updates = await client.call<UpdatesResult>("get_session_updates", {
                    session_id: sessionId,
                    wait_seconds: 10,
                });
                expect(updates.data.status).toBe("idle");
                return updates.data.last_turn;
            },
            { timeout: 280_000, interval: 0 },
        );

        expect(lastTurn?.stop_reason).toBe("end_turn");
        expect(lastTurn?.tool_calls).toContainEqual(expect.objectContaining({ kind: "edit", status: "completed" }));
        expect(readFileSync(join(workDir, "hello.txt"), "utf8").trim()).toBe("hi");

        const closed = await client.call<{ closed: boolean }>("close_session", { session_id: sessionId });
        expect(closed.data.closed).toBe(true);
    });
});
