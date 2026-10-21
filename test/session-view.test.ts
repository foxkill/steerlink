import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MCP_APP_MIME_TYPE, MCP_APPS_EXTENSION, SESSION_VIEW_URI, VIEW_TOOLS } from "../src/mcp/session-view.js";
import type { ViewState } from "../src/sessions/session-events.js";
import type { AuthStatusResult, UpdatesResult } from "../src/sessions/session-manager.js";
import { ConnectorClient, FAKE_AGENT_PATH } from "./helpers/connector-client.js";
import { defined } from "./helpers/defined.js";

const MCP_APPS = { extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } } };

function writeConfig(dir: string): string {
    const configPath = join(dir, "config.json");
    writeFileSync(
        configPath,
        JSON.stringify({
            default_agent: "fake",
            agent_servers: { fake: { command: process.execPath, args: ["--import", "tsx", FAKE_AGENT_PATH] } },
        }),
    );
    return configPath;
}

async function state(client: ConnectorClient, args: Record<string, unknown>): Promise<ViewState> {
    return defined(await client.callStructured("view_session_state", args), "view state") as unknown as ViewState;
}

describe("Session view (MCP App) in a host that renders MCP Apps", () => {
    const client = new ConnectorClient(undefined, MCP_APPS);
    let configDir: string;
    let workDir: string;

    beforeAll(async () => {
        configDir = mkdtempSync(join(tmpdir(), "steerlink-view-config-"));
        workDir = mkdtempSync(join(tmpdir(), "steerlink-view-work-"));
        await client.connect(
            { ACP_CONNECTOR_CONFIG: writeConfig(configDir), ACP_CONNECTOR_PERMISSION_PROMPT: "required" },
            false,
            true,
        );
    });

    afterAll(async () => {
        await client.close();
        await rm(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
        await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    });

    it("offers show_session with the view, and the view's tools only to the app", async () => {
        const tools = await client.listTools();
        const show = defined(
            tools.find((tool) => tool.name === "show_session"),
            "show_session",
        );
        expect(show._meta).toMatchObject({ ui: { resourceUri: SESSION_VIEW_URI }, "ui/resourceUri": SESSION_VIEW_URI });
        for (const name of VIEW_TOOLS) {
            expect(tools.find((tool) => tool.name === name)?._meta).toEqual({ ui: { visibility: ["app"] } });
        }
        const status = await client.call<AuthStatusResult>("auth_status", { probe: false });
        expect(status.data.permission_prompt).toMatchObject({
            mode: "required",
            session_view: true,
            session_view_forced: false,
        });
        expect(status.data.host?.capabilities).toMatchObject(MCP_APPS);
    });

    it("serves the view as one self-contained HTML document", async () => {
        const [content] = await client.readResource(SESSION_VIEW_URI);
        expect(content?.mimeType).toBe(MCP_APP_MIME_TYPE);
        const html = String(content?.text);
        expect(html).toMatch(/^<!doctype html>/i);
        expect(html).toContain('<script type="module">');
        expect(html).not.toContain("steerlink:script");
        // Nothing may be loaded from outside the document.
        expect(html).not.toMatch(/<script[^>]+src=/i);
        expect(html).not.toMatch(/<link[^>]+href=/i);
    });

    it("show_session names the latest open session", async () => {
        const started = (await client.call<{ session_id: string }>("start_session", { cwd: workDir })).data;
        const shown = defined(await client.callStructured("show_session"), "show_session result");
        expect(shown.session_id).toBe(started.session_id);
        await client.call("close_session", { session_id: started.session_id });
        const none = await client.call("show_session");
        expect(none.isError).toBe(true);
    });

    it("the user's click in the view allows a change even in required mode", async () => {
        const started = (await client.call<{ session_id: string }>("start_session", { cwd: workDir })).data;
        const sessionId = started.session_id;
        await client.call("send_prompt", { session_id: sessionId, text: "write viewed.txt ok", wait: false });

        const waiting = await vi.waitFor(async () => {
            const current = await state(client, { session_id: sessionId, wait_seconds: 1 });
            expect(current.pending_permissions).toHaveLength(1);
            return current;
        });
        const permission = defined(waiting.pending_permissions[0], "pending permission");
        expect(waiting.status).toBe("awaiting_permission");

        // The host's model may not allow in required mode, the view may.
        const byModel = await client.call("respond_permission", {
            permission_id: permission.permission_id,
            decision: "allow",
        });
        expect(byModel.isError).toBe(true);
        const byUser = await client.call("view_answer_permission", {
            permission_id: permission.permission_id,
            decision: "allow",
        });
        expect(byUser.isError).toBe(false);

        await vi.waitFor(() => {
            expect(existsSync(join(workDir, "viewed.txt"))).toBe(true);
        });
        const after = await state(client, { session_id: sessionId, after_seq: waiting.last_seq, wait_seconds: 2 });
        expect(after.events).toContainEqual(
            expect.objectContaining({ type: "permission_resolved", outcome: "allow_once", answered_by: "user" }),
        );
        await client.call("close_session", { session_id: sessionId });
    });

    it("reading the view does not take events away from the host", async () => {
        const started = (await client.call<{ session_id: string }>("start_session", { cwd: workDir })).data;
        const sessionId = started.session_id;
        await client.call("view_send_prompt", { session_id: sessionId, text: "hello view" });
        await vi.waitFor(async () => {
            const current = await state(client, { session_id: sessionId, wait_seconds: 1 });
            expect(current.status).toBe("idle");
            expect(current.events.some((event) => event.type === "turn_end")).toBe(true);
        });

        const updates = await client.call<UpdatesResult>("get_session_updates", { session_id: sessionId });
        expect(updates.data.events).toContainEqual(
            expect.objectContaining({ type: "message", text: "echo: hello view" }),
        );
        await client.call("close_session", { session_id: sessionId });
    });

    it("text that grows in place reappears with the same id and a newer seq", async () => {
        const started = (await client.call<{ session_id: string }>("start_session", { cwd: workDir })).data;
        const sessionId = started.session_id;
        await client.call("view_send_prompt", { session_id: sessionId, text: "slow" });

        const first = await vi.waitFor(async () => {
            const current = await state(client, { session_id: sessionId, wait_seconds: 1 });
            const message = current.events.find((event) => event.type === "message");
            expect(message).toBeDefined();
            return { current, message: defined(message, "message") };
        });
        const later = await vi.waitFor(async () => {
            const current = await state(client, {
                session_id: sessionId,
                after_seq: first.current.last_seq,
                wait_seconds: 1,
            });
            const message = current.events.find((event) => event.type === "message");
            expect(message?.id).toBe(first.message.id);
            return defined(message, "updated message");
        });
        expect(later.seq).toBeGreaterThan(first.message.seq);
        expect(later.text.length).toBeGreaterThan(first.message.text.length);

        const stopped = await client.call("view_cancel", { session_id: sessionId });
        expect(stopped.isError).toBe(false);
        await client.call("close_session", { session_id: sessionId });
    });
});

describe("Session view in a host without MCP Apps", () => {
    it("offers neither show_session nor the view's tools", async () => {
        const client = new ConnectorClient();
        await client.connect({}, false, true);
        try {
            const names = await client.listToolNames();
            expect(names).not.toContain("show_session");
            for (const name of VIEW_TOOLS) {
                expect(names).not.toContain(name);
            }
            const status = await client.call<AuthStatusResult>("auth_status", { probe: false });
            expect(status.data.permission_prompt.session_view).toBe(false);
        } finally {
            await client.close();
        }
    });
});

describe("session_view setting", () => {
    let configDir: string;
    let workDir: string;

    beforeAll(() => {
        configDir = mkdtempSync(join(tmpdir(), "steerlink-view-setting-config-"));
        workDir = mkdtempSync(join(tmpdir(), "steerlink-view-setting-work-"));
    });

    afterAll(async () => {
        await rm(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
        await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    });

    it("off hides the view even from a host with MCP Apps", async () => {
        const client = new ConnectorClient(undefined, MCP_APPS);
        await client.connect({ ACP_CONNECTOR_SESSION_VIEW: "off" }, false, true);
        try {
            expect(await client.listToolNames()).not.toContain("show_session");
            const status = await client.call<AuthStatusResult>("auth_status", { probe: false });
            expect(status.data.permission_prompt.session_view).toBe(false);
        } finally {
            await client.close();
        }
    });

    it("on offers the view without declared support, but a click there is the host's answer", async () => {
        const client = new ConnectorClient();
        await client.connect(
            {
                ACP_CONNECTOR_CONFIG: writeConfig(configDir),
                ACP_CONNECTOR_SESSION_VIEW: "on",
                ACP_CONNECTOR_PERMISSION_PROMPT: "auto",
            },
            false,
            true,
        );
        try {
            const names = await client.listToolNames();
            expect(names).toContain("show_session");
            for (const name of VIEW_TOOLS) {
                expect(names).toContain(name);
            }
            const status = await client.call<AuthStatusResult>("auth_status", { probe: false });
            expect(status.data.permission_prompt).toMatchObject({ session_view: true, session_view_forced: true });

            const started = (await client.call<{ session_id: string }>("start_session", { cwd: workDir })).data;
            const shown = defined(await client.callStructured("show_session"), "show_session result");
            expect(String(shown.note)).toMatch(/did not declare MCP Apps/);

            await client.call("send_prompt", {
                session_id: started.session_id,
                text: "write forced.txt ok",
                wait: false,
            });
            const waiting = await vi.waitFor(async () => {
                const current = await state(client, { session_id: started.session_id, wait_seconds: 1 });
                expect(current.pending_permissions).toHaveLength(1);
                return current;
            });
            const permission = defined(waiting.pending_permissions[0], "pending permission");
            const answer = await client.call("view_answer_permission", {
                permission_id: permission.permission_id,
                decision: "allow",
            });
            expect(answer.isError).toBe(false);
            const after = await state(client, {
                session_id: started.session_id,
                after_seq: waiting.last_seq,
                wait_seconds: 2,
            });
            expect(after.events).toContainEqual(
                expect.objectContaining({ type: "permission_resolved", answered_by: "host" }),
            );
            await client.call("close_session", { session_id: started.session_id });
        } finally {
            await client.close();
        }
    });

    it("a forced view does not count as the user's approval channel in required mode", async () => {
        const client = new ConnectorClient();
        await client.connect(
            {
                ACP_CONNECTOR_CONFIG: writeConfig(configDir),
                ACP_CONNECTOR_SESSION_VIEW: "on",
                ACP_CONNECTOR_PERMISSION_PROMPT: "required",
            },
            false,
            true,
        );
        try {
            const result = await client.call("start_session", { cwd: workDir });
            expect(result.isError).toBe(true);
        } finally {
            await client.close();
        }
    });
});
