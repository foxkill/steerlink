import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { decisionsFor, describePermission, supportsFormDialogs } from "../src/mcp/permission-prompt.js";
import type { AuthStatusResult, TurnResult, UpdatesResult } from "../src/sessions/session-manager.js";
import { ConnectorClient, FAKE_AGENT_PATH, type DialogHandler } from "./helpers/connector-client.js";
import { defined } from "./helpers/defined.js";

interface Setup {
    configPath: string;
    workDir: string;
    cleanup: () => Promise<void>;
}

function createSetup(): Setup {
    const configDir = mkdtempSync(join(tmpdir(), "steerlink-dialog-config-"));
    const workDir = mkdtempSync(join(tmpdir(), "steerlink-dialog-work-"));
    const configPath = join(configDir, "config.json");
    writeFileSync(
        configPath,
        JSON.stringify({
            default_agent: "fake",
            agent_servers: {
                fake: { command: process.execPath, args: ["--import", "tsx", FAKE_AGENT_PATH] },
            },
        }),
    );
    return {
        configPath,
        workDir,
        cleanup: async () => {
            await rm(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
            await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
        },
    };
}

async function startSession(client: ConnectorClient, cwd: string): Promise<string> {
    const session = await client.call<{ session_id: string }>("start_session", { cwd });
    expect(session.isError).toBe(false);
    return session.data.session_id;
}

const dismissDialog: DialogHandler = () => Promise.resolve({ action: "cancel" });

/** Answers like a person: after reading the dialog for a moment, longer than INSTANT_ANSWER_MS. */
async function afterReading(result: ElicitResult): Promise<ElicitResult> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 700);
    });
    return result;
}

describe("Permission dialog (MCP elicitation)", () => {
    const dialogs: Array<ElicitRequest["params"]> = [];
    let answer: DialogHandler = dismissDialog;
    const client = new ConnectorClient((request, signal) => {
        dialogs.push(request);
        return answer(request, signal);
    });
    let setup: Setup;

    beforeAll(async () => {
        setup = createSetup();
        await client.connect({ ACP_CONNECTOR_CONFIG: setup.configPath }, false, true);
    });

    afterAll(async () => {
        await client.close();
        await setup.cleanup();
    });

    beforeEach(() => {
        dialogs.length = 0;
    });

    it("auth_status reports that the user gets dialogs", async () => {
        const status = await client.call<AuthStatusResult>("auth_status", { probe: false });
        expect(status.data.permission_prompt).toEqual({ mode: "auto", user_dialog: true, note: null });
    });

    it("the user's choice in the dialog answers the request; the host only sees the result", async () => {
        answer = () => Promise.resolve({ action: "accept", content: { decision: "allow" } });
        const sessionId = await startSession(client, setup.workDir);

        const turn = await client.call<TurnResult>("send_prompt", {
            session_id: sessionId,
            text: "write dialog.txt hi",
        });

        expect(turn.data.status).toBe("idle");
        expect(readFileSync(join(setup.workDir, "dialog.txt"), "utf8")).toBe("hi");
        const dialog = defined(dialogs[0], "dialog");
        expect(dialog.message).toContain("fake wants to: Write dialog.txt");
        expect(dialog.message).toContain("dialog.txt (new file, 1 lines)");
        expect(dialog.message).toContain("hi");
        expect(dialog).toMatchObject({
            mode: "form",
            requestedSchema: {
                properties: {
                    decision: {
                        enum: ["allow", "allow_always", "deny"],
                        enumNames: ["Allow once", "Always allow", "Deny"],
                    },
                },
                required: ["decision"],
            },
        });
        const updates = await client.call<UpdatesResult>("get_session_updates", { session_id: sessionId });
        expect(updates.data.last_turn?.tool_calls[0]?.status).toBe("completed");
        await client.call("close_session", { session_id: sessionId });
    });

    it("a declined dialog is not a deny: the host asks in the chat instead", async () => {
        answer = () => afterReading({ action: "decline" });
        const sessionId = await startSession(client, setup.workDir);

        const turn = await client.call<TurnResult>("send_prompt", {
            session_id: sessionId,
            text: "write declined.txt x",
        });

        expect(turn.data.status).toBe("awaiting_permission");
        expect(defined(turn.data.pending_permissions[0], "pending permission").asked_user).toBe(false);
        expect(existsSync(join(setup.workDir, "declined.txt"))).toBe(false);
        await client.call("close_session", { session_id: sessionId });
    });

    it("a dismissed dialog hands the request back to the host", async () => {
        answer = () => afterReading({ action: "cancel" });
        const sessionId = await startSession(client, setup.workDir);

        const turn = await client.call<TurnResult>("send_prompt", {
            session_id: sessionId,
            text: "write handed.txt x",
        });

        expect(turn.data.status).toBe("awaiting_permission");
        const pending = defined(turn.data.pending_permissions[0], "pending permission");
        expect(pending.asked_user).toBe(false);
        expect(turn.data.hint).toContain("respond_permission");
        await client.call("respond_permission", { permission_id: pending.permission_id, decision: "allow" });
        await vi.waitFor(() => {
            expect(existsSync(join(setup.workDir, "handed.txt"))).toBe(true);
        });
        await client.call("close_session", { session_id: sessionId });
    });

    it("while the dialog is open the host is told to wait; answering it closes the dialog", async () => {
        let dialogSignal: AbortSignal | undefined;
        answer = (_request, signal) => {
            dialogSignal = signal;
            return new Promise<ElicitResult>((resolve) => {
                signal.addEventListener("abort", () => {
                    resolve({ action: "cancel" });
                });
            });
        };
        const sessionId = await startSession(client, setup.workDir);

        const turn = await client.call<TurnResult>("send_prompt", {
            session_id: sessionId,
            text: "write raced.txt x",
            timeout_seconds: 1,
        });

        expect(turn.data.status).toBe("awaiting_permission");
        const pending = defined(turn.data.pending_permissions[0], "pending permission");
        expect(pending.asked_user).toBe(true);
        expect(turn.data.hint).toContain("Do not ask them in the chat");

        const answered = await client.call("respond_permission", {
            permission_id: pending.permission_id,
            decision: "deny",
        });
        expect(answered.isError).toBe(false);
        await vi.waitFor(() => {
            expect(dialogSignal?.aborted).toBe(true);
        });
        const updates = await client.call<UpdatesResult>("get_session_updates", {
            session_id: sessionId,
            wait_seconds: 5,
        });
        expect(updates.data.events).toContainEqual(
            expect.objectContaining({ type: "permission_resolved", outcome: "reject_once", answered_by: "host" }),
        );
        expect(existsSync(join(setup.workDir, "raced.txt"))).toBe(false);
        await client.call("close_session", { session_id: sessionId });
    });

    it("events say that the user answered", async () => {
        answer = () => Promise.resolve({ action: "accept", content: { decision: "deny" } });
        const sessionId = await startSession(client, setup.workDir);

        await client.call<TurnResult>("send_prompt", {
            session_id: sessionId,
            text: "write byuser.txt x",
            wait: false,
        });
        const events: UpdatesResult["events"] = [];
        await vi.waitFor(async () => {
            const updates = await client.call<UpdatesResult>("get_session_updates", {
                session_id: sessionId,
                wait_seconds: 1,
            });
            events.push(...updates.data.events);
            expect(events.some((event) => event.type === "turn_end")).toBe(true);
        });

        expect(events).toContainEqual(
            expect.objectContaining({ type: "permission_resolved", outcome: "reject_once", answered_by: "user" }),
        );
        expect(existsSync(join(setup.workDir, "byuser.txt"))).toBe(false);
        await client.call("close_session", { session_id: sessionId });
    });
});

describe("A host that declares dialogs but declines them instantly (Grok Bot)", () => {
    let setup: Setup;
    const dialog = vi.fn<DialogHandler>(() => Promise.resolve({ action: "decline" }));
    const client = new ConnectorClient(dialog);

    beforeAll(async () => {
        setup = createSetup();
        await client.connect({ ACP_CONNECTOR_CONFIG: setup.configPath }, false, true);
    });

    afterAll(async () => {
        await client.close();
        await setup.cleanup();
    });

    it("falls back to the host instead of denying, and switches dialogs off", async () => {
        const sessionId = await startSession(client, setup.workDir);

        const first = await client.call<TurnResult>("send_prompt", {
            session_id: sessionId,
            text: "write first.txt x",
        });

        expect(first.data.status).toBe("awaiting_permission");
        const pending = defined(first.data.pending_permissions[0], "pending permission");
        expect(pending.asked_user).toBe(false);
        const status = await client.call<AuthStatusResult>("auth_status", { probe: false });
        expect(status.data.permission_prompt.user_dialog).toBe(false);
        expect(status.data.permission_prompt.note).toContain("answered a dialog instantly");

        await client.call("respond_permission", { permission_id: pending.permission_id, decision: "allow" });
        await vi.waitFor(() => {
            expect(existsSync(join(setup.workDir, "first.txt"))).toBe(true);
        });
        const second = await client.call<TurnResult>("send_prompt", {
            session_id: sessionId,
            text: "write second.txt x",
        });
        expect(second.data.status).toBe("awaiting_permission");
        expect(dialog).toHaveBeenCalledTimes(1);
        await client.call("close_session", { session_id: sessionId });
    });
});

describe("permission_prompt=required", () => {
    let setup: Setup;

    beforeAll(() => {
        setup = createSetup();
    });

    afterAll(async () => {
        await setup.cleanup();
    });

    it("without dialogs in the host, sessions refuse to start", async () => {
        const client = new ConnectorClient();
        await client.connect(
            { ACP_CONNECTOR_CONFIG: setup.configPath, ACP_CONNECTOR_PERMISSION_PROMPT: "required" },
            false,
            true,
        );
        try {
            const session = await client.call("start_session", { cwd: setup.workDir });
            expect(session.isError).toBe(true);
            expect(session.text).toContain("cannot show permission dialogs");
        } finally {
            await client.close();
        }
    });

    it("the host's model cannot allow, but can deny", async () => {
        const client = new ConnectorClient(() => Promise.resolve({ action: "cancel" }));
        await client.connect(
            { ACP_CONNECTOR_CONFIG: setup.configPath, ACP_CONNECTOR_PERMISSION_PROMPT: "required" },
            false,
            true,
        );
        try {
            const sessionId = await startSession(client, setup.workDir);
            const turn = await client.call<TurnResult>("send_prompt", {
                session_id: sessionId,
                text: "write required.txt x",
            });
            const pending = defined(turn.data.pending_permissions[0], "pending permission");

            const allowed = await client.call("respond_permission", {
                permission_id: pending.permission_id,
                decision: "allow",
            });
            expect(allowed.isError).toBe(true);
            expect(allowed.text).toContain("only the user can allow this");

            const denied = await client.call("respond_permission", {
                permission_id: pending.permission_id,
                decision: "deny",
            });
            expect(denied.isError).toBe(false);
            expect(existsSync(join(setup.workDir, "required.txt"))).toBe(false);
        } finally {
            await client.close();
        }
    });
});

describe("permission_prompt=off", () => {
    it("never shows a dialog, even if the host could", async () => {
        const setup = createSetup();
        const dialog = vi.fn<DialogHandler>(() => Promise.resolve({ action: "cancel" }));
        const client = new ConnectorClient(dialog);
        await client.connect(
            { ACP_CONNECTOR_CONFIG: setup.configPath, ACP_CONNECTOR_PERMISSION_PROMPT: "off" },
            false,
            true,
        );
        try {
            const status = await client.call<AuthStatusResult>("auth_status", { probe: false });
            expect(status.data.permission_prompt).toEqual({ mode: "off", user_dialog: false, note: null });
            const sessionId = await startSession(client, setup.workDir);
            const turn = await client.call<TurnResult>("send_prompt", {
                session_id: sessionId,
                text: "write off.txt x",
            });
            expect(turn.data.status).toBe("awaiting_permission");
            expect(dialog).not.toHaveBeenCalled();
        } finally {
            await client.close();
            await setup.cleanup();
        }
    });
});

describe("permission-prompt helpers", () => {
    const permission = {
        permission_id: "perm-1",
        session_id: "s",
        tool_call_id: "t",
        title: "Run npm test",
        kind: "execute",
        input: '{"command":"npm test"}',
        diffs: [],
        options: [
            { option_id: "a", name: "Yes", kind: "allow_once" },
            { option_id: "b", name: "No", kind: "reject_once" },
            { option_id: "c", name: "No, never", kind: "reject_always" },
        ],
        asked_user: false,
    };

    it("only form-capable hosts get dialogs", () => {
        expect(supportsFormDialogs({ elicitation: { form: {} } })).toBe(true);
        expect(supportsFormDialogs({ elicitation: { url: {} } })).toBe(false);
        expect(supportsFormDialogs({})).toBe(false);
        expect(supportsFormDialogs()).toBe(false);
    });

    it("offers exactly the agent's choices", () => {
        expect(decisionsFor(permission)).toEqual(["allow", "deny", "deny_always"]);
        expect(decisionsFor({ ...permission, options: [] })).toEqual([]);
    });

    it("shows the command when there is no diff", () => {
        const text = describePermission({ permission, agent: "claude", cwd: "/work" });
        expect(text).toBe('claude wants to: Run npm test\nProject: /work\n\n{"command":"npm test"}');
    });
});
