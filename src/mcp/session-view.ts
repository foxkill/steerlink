import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { SessionManager } from "../sessions/session-manager.js";

/** MCP Apps (https://github.com/modelcontextprotocol/ext-apps): interactive views rendered by the host. */
export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const SESSION_VIEW_URI = "ui://steerlink/session-view.html";

/** Tools only the view may call; hosts that implement MCP Apps hide them from the model. */
export const VIEW_TOOLS = ["view_session_state", "view_answer_permission", "view_send_prompt", "view_cancel"] as const;

/** Longest long-poll the view may ask for, below common host request timeouts. */
const MAX_VIEW_WAIT_SECONDS = 25;

export function supportsMcpApps(capabilities?: ClientCapabilities): boolean {
    const extension: unknown = capabilities?.extensions?.[MCP_APPS_EXTENSION];
    if (typeof extension !== "object" || extension === null) {
        return false;
    }
    const mimeTypes: unknown = Reflect.get(extension, "mimeTypes");
    return Array.isArray(mimeTypes) && mimeTypes.includes(MCP_APP_MIME_TYPE);
}

/**
 * The bundled view (`npm run build:ui`). Next to the compiled module in
 * `dist/`, or in `dist/` when running from the sources (tests, tsx).
 */
function readViewHtml(): string {
    const candidates = [
        new URL("../ui/session-view.html", import.meta.url),
        new URL("../../dist/ui/session-view.html", import.meta.url),
    ];
    for (const candidate of candidates) {
        const path = fileURLToPath(candidate);
        if (existsSync(path)) {
            return readFileSync(path, "utf8");
        }
    }
    throw new Error("The session view is not built. Run npm run build:ui.");
}

function json(value: object): CallToolResult {
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: { ...value } };
}

function fail(error: unknown): CallToolResult {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

async function run(operation: () => Promise<object> | object): Promise<CallToolResult> {
    try {
        return json(await operation());
    } catch (error) {
        return fail(error);
    }
}

const appOnly = { ui: { visibility: ["app"] } };

/** The view's HTML resource. Resources must be registered before the server connects. */
export function registerSessionViewResource(server: McpServer): void {
    server.registerResource(
        "session-view",
        SESSION_VIEW_URI,
        {
            title: "SteerLink session",
            description: "Live view of a coding agent session with approve and deny buttons",
            mimeType: MCP_APP_MIME_TYPE,
        },
        () => ({
            contents: [
                {
                    uri: SESSION_VIEW_URI,
                    mimeType: MCP_APP_MIME_TYPE,
                    text: readViewHtml(),
                    _meta: { ui: { prefersBorder: true } },
                },
            ],
        }),
    );
}

/**
 * show_session and the view's own tools. Registered only for hosts that
 * declare MCP Apps: those hide app-only tools from the model, so an answer
 * through view_answer_permission really comes from the user's click.
 */
export function registerSessionViewTools(server: McpServer, manager: SessionManager): void {
    server.registerTool(
        "show_session",
        {
            title: "Show session",
            description:
                "Opens a live view of a session in the chat: the agent's messages, changes with diffs, and buttons to " +
                "approve or deny each change. Without session_id it shows the most recent open session.",
            inputSchema: { session_id: z.string().optional().describe("session_id from start_session") },
            _meta: { ui: { resourceUri: SESSION_VIEW_URI }, "ui/resourceUri": SESSION_VIEW_URI },
        },
        ({ session_id }) =>
            run(() => {
                const id = session_id ?? manager.latestSessionId();
                if (id === undefined) {
                    throw new Error("No open session. Start one with start_session first.");
                }
                const session = manager.listSessions().find((entry) => entry.session_id === id);
                if (!session) {
                    throw new Error(`Unknown session "${id}"`);
                }
                return {
                    session_id: id,
                    status: session.status,
                    note: "The session view is open in the chat; the user approves or denies changes there.",
                };
            }),
    );

    server.registerTool(
        "view_session_state",
        {
            title: "Session view: state",
            description: "Used by the session view only.",
            inputSchema: {
                session_id: z.string(),
                after_seq: z.number().int().min(0).optional(),
                wait_seconds: z.number().min(0).max(MAX_VIEW_WAIT_SECONDS).optional(),
            },
            annotations: { readOnlyHint: true },
            _meta: appOnly,
        },
        ({ session_id, after_seq, wait_seconds }) =>
            run(() => manager.viewState({ session_id, after_seq: after_seq ?? 0, wait_seconds: wait_seconds ?? 0 })),
    );

    server.registerTool(
        "view_answer_permission",
        {
            title: "Session view: answer a permission request",
            description: "Used by the session view only. The user's click in the view.",
            inputSchema: {
                permission_id: z.string(),
                decision: z.enum(["allow", "allow_always", "deny", "deny_always"]),
            },
            _meta: appOnly,
        },
        ({ permission_id, decision }) => run(() => manager.respondPermission({ permission_id, decision }, "user")),
    );

    server.registerTool(
        "view_send_prompt",
        {
            title: "Session view: send a message",
            description: "Used by the session view only. A message the user typed in the view.",
            inputSchema: { session_id: z.string(), text: z.string().min(1) },
            _meta: appOnly,
        },
        ({ session_id, text }) => run(() => manager.sendPrompt({ session_id, text, wait: false, timeout_seconds: 0 })),
    );

    server.registerTool(
        "view_cancel",
        {
            title: "Session view: stop the agent",
            description: "Used by the session view only.",
            inputSchema: { session_id: z.string() },
            _meta: appOnly,
        },
        ({ session_id }) => run(() => manager.cancel(session_id)),
    );
}
