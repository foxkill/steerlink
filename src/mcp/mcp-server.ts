import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { PACKAGE_NAME, PACKAGE_VERSION } from "../package-info.js";
import type { SessionManager } from "../sessions/session-manager.js";
import { createElicitationPrompter, supportsFormDialogs } from "./permission-prompt.js";
import { registerSessionViewResource, registerSessionViewTools, supportsMcpApps } from "./session-view.js";

function ok(value: object): CallToolResult {
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown): CallToolResult {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

async function run(operation: () => Promise<object> | object): Promise<CallToolResult> {
    try {
        return ok(await operation());
    } catch (error) {
        return fail(error);
    }
}

const sessionId = z.string().describe("session_id from start_session");
const agentName = z.string().optional().describe("Name from list_agents; defaults to the configured default_agent");

export function createMcpServer(manager: SessionManager): McpServer {
    const server = new McpServer(
        { name: PACKAGE_NAME, version: PACKAGE_VERSION },
        {
            instructions:
                "Controls ACP coding agents (default: Claude Code via claude-agent-acp). Flow: start_session(cwd) → send_prompt(text). " +
                "If send_prompt reports status=awaiting_permission, answer with respond_permission(permission_id, allow|deny), then " +
                "poll get_session_updates(wait_seconds) until status=idle. Long tasks: send_prompt with wait=false, then poll. " +
                "If the show_session tool is offered, call it right after start_session: the user then follows the session " +
                "and approves changes in a live view in the chat.",
        },
    );

    // The view's HTML must be registered before connecting; its tools only for hosts with MCP Apps (below).
    registerSessionViewResource(server);
    let viewToolsRegistered = false;

    // Once the host has introduced itself: show permission requests as dialogs if it can,
    // and offer the session view if it renders MCP Apps.
    server.server.oninitialized = () => {
        const capabilities = server.server.getClientCapabilities();
        const client = server.server.getClientVersion();
        manager.setHost({
            name: client?.name ?? null,
            version: client?.version ?? null,
            capabilities: capabilities ?? null,
        });
        const prompter = supportsFormDialogs(capabilities)
            ? createElicitationPrompter(server, () => {
                  manager.setPermissionPrompter(
                      undefined,
                      "Dialogs switched off: the host declared form support but answered a dialog instantly, " +
                          "so it cannot show them. Permission requests go to the host again.",
                  );
              })
            : undefined;
        manager.setPermissionPrompter(prompter);
        const declared = supportsMcpApps(capabilities);
        const mode = manager.sessionViewMode();
        if ((mode === "on" || (mode === "auto" && declared)) && !viewToolsRegistered) {
            viewToolsRegistered = true;
            registerSessionViewTools(server, manager, declared ? "user" : "host");
            manager.enableSessionView(!declared);
        }
    };

    server.registerTool(
        "list_agents",
        {
            title: "List ACP agents",
            description: "Lists the configured ACP agents (like Zed's agent_servers) with status and auth methods.",
            inputSchema: {},
            annotations: { readOnlyHint: true },
        },
        () => run(() => ({ agents: manager.listAgents() })),
    );

    server.registerTool(
        "start_session",
        {
            title: "Start session",
            description:
                "Starts a new agent session in a working directory. mode: e.g. 'default' (asks before changes, the default), " +
                "'acceptEdits', 'plan', 'auto', 'bypassPermissions'; the available modes are listed in the response. " +
                "available_commands lists the slash commands this session accepts (send one as the prompt text, e.g. '/compact'); " +
                "commands that are not listed, such as terminal-only ones, do not work. null means the agent did not report any.",
            inputSchema: {
                cwd: z.string().describe("Absolute path of the working directory"),
                agent: agentName,
                mode: z
                    .string()
                    .optional()
                    .describe("Session mode; defaults to 'default' (every change needs approval)"),
            },
        },
        ({ cwd, agent, mode }) => run(() => manager.startSession({ cwd, agent, mode: mode ?? "default" })),
    );

    server.registerTool(
        "send_prompt",
        {
            title: "Send prompt",
            description:
                "Sends a prompt. With wait=true (the default) the call returns as soon as the turn ends, an approval is needed, " +
                "or timeout_seconds elapses. Returns the response text, tool calls with diffs, and pending approvals. wait=false only starts the turn.",
            inputSchema: {
                session_id: sessionId,
                text: z.string().min(1).describe("Prompt text"),
                wait: z.boolean().optional().describe("Wait for the turn to end or an approval request (default true)"),
                timeout_seconds: z
                    .number()
                    .int()
                    .min(1)
                    .max(3600)
                    .optional()
                    .describe("Maximum wait time (default 120)"),
            },
        },
        ({ session_id, text, wait, timeout_seconds }) =>
            run(() =>
                manager.sendPrompt({ session_id, text, wait: wait ?? true, timeout_seconds: timeout_seconds ?? 120 }),
            ),
    );

    server.registerTool(
        "get_session_updates",
        {
            title: "Get session updates",
            description:
                "Returns all events since the last call (text, tool calls, diffs, approvals, turn end) plus the status. " +
                "wait_seconds > 0 waits that long for new events (long polling).",
            inputSchema: {
                session_id: sessionId,
                wait_seconds: z.number().int().min(0).max(600).optional().describe("Long-polling duration (default 0)"),
                include_thoughts: z.boolean().optional().describe("Include the agent's thought chunks (default false)"),
            },
            annotations: { readOnlyHint: true },
        },
        ({ session_id, wait_seconds, include_thoughts }) =>
            run(() =>
                manager.getUpdates({
                    session_id,
                    wait_seconds: wait_seconds ?? 0,
                    include_thoughts: include_thoughts ?? false,
                }),
            ),
    );

    server.registerTool(
        "list_pending_permissions",
        {
            title: "Pending approvals",
            description:
                "Lists the agents' pending permission requests (optionally for one session only) with tool, input, diff and options.",
            inputSchema: { session_id: sessionId.optional() },
            annotations: { readOnlyHint: true },
        },
        ({ session_id }) => run(() => ({ pending_permissions: manager.listPendingPermissions(session_id) })),
    );

    server.registerTool(
        "respond_permission",
        {
            title: "Answer approval",
            description:
                "Answers a permission request. decision: allow (once), allow_always, deny (once), deny_always. " +
                "Alternatively, a specific option_id from list_pending_permissions.",
            inputSchema: {
                permission_id: z.string(),
                decision: z.enum(["allow", "allow_always", "deny", "deny_always"]).optional(),
                option_id: z.string().optional(),
            },
        },
        ({ permission_id, decision, option_id }) =>
            run(() => manager.respondPermission({ permission_id, decision, option_id })),
    );

    server.registerTool(
        "set_mode",
        {
            title: "Set session mode",
            description: "Switches a session's mode (e.g. default, acceptEdits, plan).",
            inputSchema: { session_id: sessionId, mode: z.string() },
        },
        ({ session_id, mode }) => run(() => manager.setMode(session_id, mode)),
    );

    server.registerTool(
        "cancel",
        {
            title: "Cancel turn",
            description: "Cancels the running turn (session/cancel) and withdraws pending approvals.",
            inputSchema: { session_id: sessionId },
        },
        ({ session_id }) => run(() => manager.cancel(session_id)),
    );

    server.registerTool(
        "close_session",
        {
            title: "Close session",
            description: "Cancels running work and closes the session.",
            inputSchema: { session_id: sessionId },
        },
        ({ session_id }) => run(() => manager.closeSession(session_id)),
    );

    server.registerTool(
        "list_sessions",
        {
            title: "List sessions",
            description: "Lists all sessions of this connector with their status and available slash commands.",
            inputSchema: {},
            annotations: { readOnlyHint: true },
        },
        () => run(() => ({ sessions: manager.listSessions() })),
    );

    server.registerTool(
        "auth_status",
        {
            title: "Auth status",
            description:
                "Shows which sign-in method is active (API key or Claude subscription), whether credentials are present, and what the agent " +
                "itself reports, without secrets. restart_agent=true restarts the agent (e.g. after logging in in a terminal).",
            inputSchema: {
                agent: agentName,
                probe: z
                    .boolean()
                    .optional()
                    .describe("Start the agent if needed and wait for its report (default true)"),
                restart_agent: z
                    .boolean()
                    .optional()
                    .describe("Restart the agent process first (only when no sessions are open)"),
            },
        },
        ({ agent, probe, restart_agent }) =>
            run(() => manager.authStatus({ agent, probe: probe ?? true, restart_agent: restart_agent ?? false })),
    );

    server.registerTool(
        "authenticate",
        {
            title: "Sign in",
            description:
                "Runs an auth method offered by the agent (see auth_status.auth_methods). Terminal methods (e.g. Claude login) " +
                "only return the command that the human runs in a terminal themselves.",
            inputSchema: { agent: agentName, method_id: z.string() },
        },
        ({ agent, method_id }) => run(() => manager.authenticate({ agent, method_id })),
    );

    return server;
}
