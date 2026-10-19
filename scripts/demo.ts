/**
 * End-to-end proof, just like Grok Bot: an MCP client starts the built
 * connector (dist/main.js) over stdio, and the connector starts
 * claude-agent-acp over ACP.
 *
 * Flow: start_session(temp folder) → send_prompt → grant approval →
 * get_session_updates until idle → check hello.txt.
 *
 * Usage: npm run build && npm run demo
 * Auth: ANTHROPIC_API_KEY (default) or deliberately ACP_CONNECTOR_AUTH_MODE=subscription.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuthStatusResult, TurnResult, UpdatesResult } from "../src/sessions/session-manager.js";
import { ConnectorClient } from "../test/helpers/connector-client.js";

const PROMPT = "Create hello.txt containing 'hi'";
const MAX_ROUNDS = 30;

function log(label: string, value: string | object): void {
    console.log(`\n=== ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
}

async function main(): Promise<number> {
    const workDir = mkdtempSync(join(tmpdir(), "grokbot-acp-demo-"));
    const client = new ConnectorClient();
    // Only pass the two connector variables on; secrets come from the environment.
    await client.connect({ ACP_CONNECTOR_AUTH_MODE: process.env.ACP_CONNECTOR_AUTH_MODE ?? "" }, true);

    try {
        log("tools/list", (await client.listToolNames()).join(", "));

        const auth = await client.call<AuthStatusResult>("auth_status", {});
        log("auth_status", auth.isError ? auth.text : auth.data);
        if (auth.isError || auth.data.problem) {
            return 1;
        }

        const session = await client.call<{ session_id: string; current_mode: string | null }>("start_session", {
            cwd: workDir,
            mode: "default",
        });
        log("start_session", session.isError ? session.text : session.data);
        if (session.isError) {
            return 1;
        }
        const sessionId = session.data.session_id;

        const turn = await client.call<TurnResult>("send_prompt", {
            session_id: sessionId,
            text: PROMPT,
            timeout_seconds: 180,
        });
        log(`send_prompt "${PROMPT}"`, {
            status: turn.data.status,
            pending_permissions: turn.data.pending_permissions,
            hint: turn.data.hint,
        });

        let status = turn.data.status;
        let lastTurn: TurnResult | null = turn.data;
        let granted = 0;
        for (let round = 0; round < MAX_ROUNDS && status !== "idle" && status !== "closed"; round += 1) {
            const pending = await client.call<{ pending_permissions: Array<{ permission_id: string; title: string }> }>(
                "list_pending_permissions",
                {
                    session_id: sessionId,
                },
            );
            for (const permission of pending.data.pending_permissions) {
                const answer = await client.call<object>("respond_permission", {
                    permission_id: permission.permission_id,
                    decision: "allow",
                });
                granted += 1;
                log(`respond_permission ${permission.permission_id} (${permission.title})`, answer.data);
            }
            const updates = await client.call<UpdatesResult>("get_session_updates", {
                session_id: sessionId,
                wait_seconds: 10,
            });
            status = updates.data.status;
            lastTurn = updates.data.last_turn;
            console.log(
                `… status=${status}, new events:${updates.data.events.map((event) => event.type).join(", ") || "-"}`,
            );
        }

        log("last turn", {
            status,
            stop_reason: lastTurn?.stop_reason,
            error: lastTurn?.error,
            response_text: lastTurn?.response_text,
            tool_calls: lastTurn?.tool_calls.map((call) => ({
                title: call.title,
                kind: call.kind,
                status: call.status,
                diffs: call.diffs,
            })),
        });

        await client.call("close_session", { session_id: sessionId });

        const file = join(workDir, "hello.txt");
        const exists = existsSync(file);
        const content = exists ? readFileSync(file, "utf8") : "";
        log("result", { file, exists, content, permissions_granted: granted });
        return exists && content.trim() === "hi" && granted > 0 ? 0 : 1;
    } finally {
        await client.close();
        // Asynchronous: a synchronous rmSync blocks the event loop with its retries.
        await rm(workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
}

try {
    const code = await main();
    console.log(code === 0 ? "\nDEMO OK" : "\nDEMO FAILED");
    process.exit(code);
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}
