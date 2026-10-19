import { randomUUID } from "node:crypto";
/**
 * Minimaler ACP-Agent für Tests. Verhalten je nach Prompt:
 * - "write <datei> <inhalt>": fragt um Erlaubnis (außer im Modus acceptEdits)
 *   und schreibt die Datei ins Session-cwd.
 * - "slow": streamt Text, bis der Turn abgebrochen wird oder 3 s vergehen.
 * - sonst: antwortet mit einem Echo.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import {
    agent,
    methods,
    ndJsonStream,
    PROTOCOL_VERSION,
    type AgentContext,
    type PromptResponse,
} from "@agentclientprotocol/sdk";

interface FakeSession {
    cwd: string;
    mode: string;
    abort: AbortController | null;
}

const sessions = new Map<string, FakeSession>();

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
        });
    });
}

async function say(client: AgentContext, sessionId: string, text: string): Promise<void> {
    await client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    });
}

async function writeTurn(
    client: AgentContext,
    sessionId: string,
    session: FakeSession,
    file: string,
    content: string,
): Promise<PromptResponse> {
    const path = join(session.cwd, file);
    const toolCallId = `call-${randomUUID()}`;
    await say(client, sessionId, `Ich lege ${file} an.`);
    await client.notify(methods.client.session.update, {
        sessionId,
        update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: `Write ${file}`,
            kind: "edit",
            status: "pending",
            locations: [{ path }],
            content: [{ type: "diff", path, oldText: null, newText: content }],
            rawInput: { file_path: path, content },
        },
    });

    if (session.mode !== "acceptEdits") {
        const response = await client.request(methods.client.session.requestPermission, {
            sessionId,
            toolCall: { toolCallId, title: `Write ${file}`, kind: "edit", rawInput: { file_path: path, content } },
            options: [
                { optionId: "allow-once", name: "Yes", kind: "allow_once" },
                { optionId: "allow-always", name: "Always", kind: "allow_always" },
                { optionId: "reject", name: "No", kind: "reject_once" },
            ],
        });
        if (response.outcome.outcome === "cancelled") {
            return { stopReason: "cancelled" };
        }
        if (!response.outcome.optionId.startsWith("allow")) {
            await client.notify(methods.client.session.update, {
                sessionId,
                update: { sessionUpdate: "tool_call_update", toolCallId, status: "failed" },
            });
            await say(client, sessionId, " Abgelehnt, nichts geschrieben.");
            return { stopReason: "end_turn" };
        }
    }

    writeFileSync(path, content);
    await client.notify(methods.client.session.update, {
        sessionId,
        update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: `File created at ${path}` } }],
        },
    });
    await say(client, sessionId, ` Fertig: ${file} enthält '${content}'.`);
    return { stopReason: "end_turn" };
}

async function slowTurn(client: AgentContext, sessionId: string, signal: AbortSignal): Promise<PromptResponse> {
    try {
        for (let index = 0; index < 30; index += 1) {
            await say(client, sessionId, `tick${index} `);
            await sleep(100, signal);
        }
    } catch {
        return { stopReason: "cancelled" };
    }
    return { stopReason: "end_turn" };
}

const stream = ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

agent({ name: "fake-agent" })
    .onRequest(methods.agent.initialize, (context) => {
        // Wie claude-agent-acp: Identität per Erweiterungs-Notification, inkl. E-Mail,
        // die der Connector herausfiltern muss.
        setTimeout(() => {
            void context.client.notify("_auth/status_update", {
                authStatus: {
                    kind: "account",
                    label: "Fake Max",
                    account: { plan: "max", email: "secret@example.com" },
                },
            });
        }, 10);
        return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
            agentInfo: { name: "fake-agent", title: "Fake Agent", version: "1.0.0" },
            authMethods: [
                {
                    id: "fake-login",
                    name: "Fake Login",
                    description: "Interaktiver Login",
                    type: "terminal",
                    args: ["--login"],
                },
                { id: "fake-agent-auth", name: "Fake Agent Auth", description: null },
            ],
        };
    })
    .onRequest(methods.agent.authenticate, () => ({}))
    .onRequest(methods.agent.session.new, (context) => {
        const sessionId = randomUUID();
        sessions.set(sessionId, { cwd: context.params.cwd, mode: "default", abort: null });
        return {
            sessionId,
            modes: {
                currentModeId: "default",
                availableModes: [
                    { id: "default", name: "Manual" },
                    { id: "acceptEdits", name: "Accept edits" },
                ],
            },
        };
    })
    .onRequest(methods.agent.session.setMode, (context) => {
        const session = sessions.get(context.params.sessionId);
        if (session) {
            session.mode = context.params.modeId;
        }
        return {};
    })
    .onRequest(methods.agent.session.close, (context) => {
        sessions.delete(context.params.sessionId);
        return {};
    })
    .onRequest(methods.agent.session.prompt, async (context) => {
        const session = sessions.get(context.params.sessionId);
        if (!session) {
            throw new Error("unknown session");
        }
        session.abort = new AbortController();
        const block = context.params.prompt[0];
        const text = block?.type === "text" ? block.text : "";
        const [, path, content] = /^write (\S+) (.+)$/.exec(text) ?? [];
        if (path !== undefined && content !== undefined) {
            return writeTurn(context.client, context.params.sessionId, session, path, content);
        }
        if (text === "slow") {
            return slowTurn(context.client, context.params.sessionId, session.abort.signal);
        }
        await say(context.client, context.params.sessionId, `echo: ${text}`);
        return { stopReason: "end_turn" };
    })
    .onNotification(methods.agent.session.cancel, (context) => {
        sessions.get(context.params.sessionId)?.abort?.abort();
    })
    .connect(stream);
