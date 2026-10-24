import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/package-info.js";
import type { AuthStatusResult, TurnResult, UpdatesResult, AgentInfo } from "../src/sessions/session-manager.js";
import { ConnectorClient, FAKE_AGENT_PATH } from "./helpers/connector-client.js";
import { defined } from "./helpers/defined.js";

interface StartSessionResult {
    session_id: string;
    current_mode: string | null;
    available_modes: Array<{ id: string; name: string }>;
    available_commands: Array<{ command: string; description: string; input_hint: string | null }> | null;
}

describe("Connector with fake ACP agent (MCP → connector → ACP)", () => {
    const client = new ConnectorClient();
    let workDir: string;
    let configDir: string;

    beforeAll(async () => {
        configDir = mkdtempSync(join(tmpdir(), "acp-connector-config-"));
        workDir = mkdtempSync(join(tmpdir(), "acp-connector-work-"));
        const configPath = join(configDir, "config.json");
        writeFileSync(
            configPath,
            JSON.stringify({
                default_agent: "fake",
                agent_servers: {
                    fake: {
                        type: "custom",
                        command: process.execPath,
                        args: ["--import", "tsx", FAKE_AGENT_PATH],
                        env: { FAKE_FLAG: "1" },
                    },
                },
            }),
        );
        await client.connect({ ACP_CONNECTOR_CONFIG: configPath }, false, true);
    });

    afterAll(async () => {
        await client.close();
        await rm(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
        await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    });

    it("offers all tools", async () => {
        const names = await client.listToolNames();
        expect(names).toEqual(
            expect.arrayContaining([
                "list_agents",
                "start_session",
                "send_prompt",
                "get_session_updates",
                "list_pending_permissions",
                "respond_permission",
                "cancel",
                "close_session",
                "auth_status",
                "authenticate",
                "set_mode",
                "list_sessions",
            ]),
        );
    });

    it("lists agents like Zed's agent_servers", async () => {
        const result = await client.call<{ agents: AgentInfo[] }>("list_agents");
        const names = result.data.agents.map((agent) => agent.name);
        expect(names).toEqual(expect.arrayContaining(["claude", "fake"]));
        const fake = result.data.agents.find((agent) => agent.name === "fake");
        expect(fake?.default).toBe(true);
        expect(fake?.env_keys).toEqual(["FAKE_FLAG"]);
    });

    it("start_session and list_sessions report the session's slash commands", async () => {
        const session = await client.call<StartSessionResult>("start_session", { cwd: workDir });
        const expected = [
            { command: "/compact", description: "Compact the conversation", input_hint: null },
            { command: "/review", description: "Review changes", input_hint: "what to review" },
        ];
        expect(session.data.available_commands).toEqual(expected);
        const listed = await client.call<{
            sessions: Array<{ session_id: string; available_commands: StartSessionResult["available_commands"] }>;
        }>("list_sessions");
        expect(listed.data.sessions.find((entry) => entry.session_id === session.data.session_id)).toMatchObject({
            available_commands: expected,
        });
        await client.call("close_session", { session_id: session.data.session_id });
    });

    it("session → prompt → approval → file exists", async () => {
        const session = await client.call<StartSessionResult>("start_session", { cwd: workDir });
        expect(session.isError).toBe(false);
        expect(session.data.current_mode).toBe("default");

        const turn = await client.call<TurnResult>("send_prompt", {
            session_id: session.data.session_id,
            text: "write hello.txt hi",
        });
        expect(turn.data.status).toBe("awaiting_permission");
        const permission = defined(turn.data.pending_permissions[0], "pending permission");
        expect(permission.title).toBe("Write hello.txt");
        expect(defined(turn.data.tool_calls[0], "tool call").diffs[0]).toMatchObject({
            new_text: "hi",
            old_text: null,
        });
        expect(existsSync(join(workDir, "hello.txt"))).toBe(false);

        const pending = await client.call<{ pending_permissions: Array<{ permission_id: string }> }>(
            "list_pending_permissions",
        );
        expect(pending.data.pending_permissions.map((entry) => entry.permission_id)).toContain(
            permission.permission_id,
        );

        const answer = await client.call<{ selected_option: { kind: string } }>("respond_permission", {
            permission_id: permission.permission_id,
            decision: "allow",
        });
        expect(answer.data.selected_option.kind).toBe("allow_once");

        const polls: UpdatesResult[] = [];
        const updates = await vi.waitFor(
            async () => {
                const result = (
                    await client.call<UpdatesResult>("get_session_updates", {
                        session_id: session.data.session_id,
                        wait_seconds: 2,
                    })
                ).data;
                polls.push(result);
                expect(result.status).toBe("idle");
                return result;
            },
            { timeout: 40_000, interval: 0 },
        );
        // turn_end arrives exactly once, in the same poll as status=idle.
        const withTurnEnd = polls.filter((poll) => poll.events.some((event) => event.type === "turn_end"));
        expect(withTurnEnd.map((poll) => poll.status)).toEqual(["idle"]);
        expect(updates.last_turn?.stop_reason).toBe("end_turn");
        expect(updates.last_turn?.tool_calls[0]?.status).toBe("completed");
        expect(updates.last_turn?.response_text).toContain("Done");
        expect(readFileSync(join(workDir, "hello.txt"), "utf8")).toBe("hi");
    });

    it("deny writes nothing", async () => {
        const session = await client.call<StartSessionResult>("start_session", { cwd: workDir });
        const turn = await client.call<TurnResult>("send_prompt", {
            session_id: session.data.session_id,
            text: "write denied.txt nope",
        });
        await client.call("respond_permission", {
            permission_id: defined(turn.data.pending_permissions[0], "pending permission").permission_id,
            decision: "deny",
        });
        const updates = await client.call<UpdatesResult>("get_session_updates", {
            session_id: session.data.session_id,
            wait_seconds: 5,
        });
        const types = updates.data.events.map((event) => event.type);
        expect(types).toContain("permission_resolved");
        expect(existsSync(join(workDir, "denied.txt"))).toBe(false);
    });

    it("acceptEdits needs no approval", async () => {
        const session = await client.call<StartSessionResult>("start_session", { cwd: workDir, mode: "acceptEdits" });
        expect(session.data.current_mode).toBe("acceptEdits");
        const turn = await client.call<TurnResult>("send_prompt", {
            session_id: session.data.session_id,
            text: "write auto.txt ok",
        });
        expect(turn.data.status).toBe("idle");
        expect(readFileSync(join(workDir, "auto.txt"), "utf8")).toBe("ok");
    });

    it("wait=false does not block; polling and cancel work", async () => {
        const session = await client.call<StartSessionResult>("start_session", { cwd: workDir });
        const started = Date.now();
        const turn = await client.call<TurnResult>("send_prompt", {
            session_id: session.data.session_id,
            text: "slow",
            wait: false,
        });
        expect(Date.now() - started).toBeLessThan(1500);
        expect(turn.data.status).toBe("running");

        const updates = await client.call<UpdatesResult>("get_session_updates", {
            session_id: session.data.session_id,
            wait_seconds: 2,
        });
        expect(updates.data.events.some((event) => event.type === "message")).toBe(true);

        const second = await client.call<TurnResult>("send_prompt", {
            session_id: session.data.session_id,
            text: "one more",
        });
        expect(second.isError).toBe(true);

        const cancelled = await client.call<TurnResult>("cancel", { session_id: session.data.session_id });
        expect(cancelled.data.status).toBe("idle");
        expect(cancelled.data.stop_reason).toBe("cancelled");
    });

    it("cancel withdraws pending approvals", async () => {
        const session = await client.call<StartSessionResult>("start_session", { cwd: workDir });
        const turn = await client.call<TurnResult>("send_prompt", {
            session_id: session.data.session_id,
            text: "write never.txt x",
        });
        expect(turn.data.status).toBe("awaiting_permission");
        const cancelled = await client.call<TurnResult>("cancel", { session_id: session.data.session_id });
        expect(cancelled.data.stop_reason).toBe("cancelled");
        expect(cancelled.data.pending_permissions).toHaveLength(0);
        expect(existsSync(join(workDir, "never.txt"))).toBe(false);
    });

    it("close_session ends the session", async () => {
        const session = await client.call<StartSessionResult>("start_session", { cwd: workDir });
        const closed = await client.call<{ closed: boolean }>("close_session", { session_id: session.data.session_id });
        expect(closed.data.closed).toBe(true);
        const after = await client.call("send_prompt", { session_id: session.data.session_id, text: "hello" });
        expect(after.isError).toBe(true);
    });

    it("auth_status reports the running server version", async () => {
        const status = await client.call<AuthStatusResult>("auth_status", { agent: "fake", probe: false });
        expect(status.data.server).toEqual({ name: PACKAGE_NAME, version: PACKAGE_VERSION, node: process.version });
        expect(PACKAGE_VERSION).toBe(
            (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string })
                .version,
        );
    });

    it("auth_status reports the identity without email", async () => {
        const status = await client.call<AuthStatusResult>("auth_status", { agent: "fake" });
        expect(status.data.agent_reported).toEqual({ kind: "account", label: "Fake Max", plan: "max" });
        expect(status.data.note).toBeNull();
        expect(status.text).not.toContain("secret@example.com");
        expect(status.data.auth_methods.map((method) => method.id)).toEqual(["fake-login", "fake-agent-auth"]);
    });

    it("authenticate: terminal method only returns the command, agent method is executed", async () => {
        const terminal = await client.call<{ command: string }>("authenticate", {
            agent: "fake",
            method_id: "fake-login",
        });
        expect(terminal.data.command).toContain("--login");
        const direct = await client.call<{ result: string }>("authenticate", {
            agent: "fake",
            method_id: "fake-agent-auth",
        });
        expect(direct.data.result).toBe("authenticate succeeded");
    });

    it("auth_status: api_key mode without a key does not start Claude", async () => {
        const status = await client.call<AuthStatusResult>("auth_status", { agent: "claude" });
        expect(status.data.auth_mode).toBe("api_key");
        expect(status.data.effective_method).toMatch(/^none: auth_mode=api_key/);
        expect(status.data.credentials.anthropic_api_key_set).toBe(false);
        expect(status.data.problem).toContain("ANTHROPIC_API_KEY");
        const session = await client.call("start_session", { cwd: workDir, agent: "claude" });
        expect(session.isError).toBe(true);
    });

    it("rejects a relative cwd", async () => {
        const session = await client.call("start_session", { cwd: "relative/path" });
        expect(session.isError).toBe(true);
    });
});

describe("auth_status in subscription mode without a token", () => {
    const client = new ConnectorClient();
    let configDir: string;

    beforeAll(async () => {
        configDir = mkdtempSync(join(tmpdir(), "acp-connector-no-login-"));
        const configPath = join(configDir, "config.json");
        // A Claude-profile agent without a stored login: it reports "Not logged in".
        writeFileSync(
            configPath,
            JSON.stringify({
                default_agent: "claude-like",
                agent_servers: {
                    "claude-like": {
                        command: process.execPath,
                        args: ["--import", "tsx", FAKE_AGENT_PATH],
                        env: { FAKE_AUTH_KIND: "none", FAKE_NO_COMMANDS: "1" },
                        auth_profile: "claude",
                    },
                },
            }),
        );
        await client.connect(
            { ACP_CONNECTOR_CONFIG: configPath, ACP_CONNECTOR_AUTH_MODE: "subscription", CLAUDE_CODE_OAUTH_TOKEN: "" },
            false,
            true,
        );
    });

    afterAll(async () => {
        await client.close();
        await rm(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    });

    it('reports "Not logged in" as a problem and names the login method', async () => {
        const status = await client.call<AuthStatusResult>("auth_status", {});
        expect(status.data.credentials.claude_code_oauth_token_set).toBe(false);
        expect(status.data.agent_reported).toEqual({ kind: "none", label: "Not logged in" });
        expect(status.data.problem).toMatch(/^Not signed in/);
        expect(status.data.problem).toContain("claude-ai-login");
        expect(status.data.note).toBeNull();
    });
});

describe("auth_status with a subscription token", () => {
    const client = new ConnectorClient();
    let configDir: string;

    beforeAll(async () => {
        configDir = mkdtempSync(join(tmpdir(), "acp-connector-token-"));
        const configPath = join(configDir, "config.json");
        // A Claude-profile agent that, like claude-agent-acp before its first session, reports "Not logged in".
        writeFileSync(
            configPath,
            JSON.stringify({
                default_agent: "claude-like",
                agent_servers: {
                    "claude-like": {
                        command: process.execPath,
                        args: ["--import", "tsx", FAKE_AGENT_PATH],
                        env: { FAKE_AUTH_KIND: "none", FAKE_NO_COMMANDS: "1" },
                        auth_profile: "claude",
                    },
                },
            }),
        );
        await client.connect(
            {
                ACP_CONNECTOR_CONFIG: configPath,
                ACP_CONNECTOR_AUTH_MODE: "subscription",
                CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token-not-real",
            },
            false,
            true,
        );
    });

    afterAll(async () => {
        await client.close();
        await rm(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    });

    it('explains the misleading pre-session "Not logged in" and never shows the token', async () => {
        const status = await client.call<AuthStatusResult>("auth_status", {});
        expect(status.data.problem).toBeNull();
        expect(status.data.credentials.claude_code_oauth_token_set).toBe(true);
        expect(status.data.agent_reported).toEqual({ kind: "none", label: "Not logged in" });
        expect(status.data.note).toMatch(/check only sees a stored claude\.ai login/);
        expect(status.data.note).toMatch(/the first answered prompt confirms it/);
        expect(status.text).not.toContain("test-oauth-token-not-real");
    });

    it("an agent that reports no slash commands gives available_commands: null", async () => {
        const session = await client.call<StartSessionResult>("start_session", { cwd: configDir });
        expect(session.isError).toBe(false);
        expect(session.data.available_commands).toBeNull();
        await client.call("close_session", { session_id: session.data.session_id });
    });

    it('after an answered prompt the note confirms the sign-in, though the agent still says "Not logged in"', async () => {
        const session = await client.call<StartSessionResult>("start_session", { cwd: configDir });
        const turn = await client.call<{ status: string }>("send_prompt", {
            session_id: session.data.session_id,
            text: "hello",
        });
        expect(turn.data.status).toBe("idle");
        const status = await client.call<AuthStatusResult>("auth_status", { probe: false });
        expect(status.data.agent_reported).toEqual({ kind: "none", label: "Not logged in" });
        expect(status.data.note).toMatch(/this agent has already answered a prompt/);
        expect(status.data.note).not.toMatch(/updates after/);
        await client.call("close_session", { session_id: session.data.session_id });
    });
});
