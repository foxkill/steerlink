import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientCapabilities, ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";

import { DECISION_LABEL, decisionsFor, truncate, type PendingPermissionSummary } from "../sessions/session-events.js";
import type { PermissionPrompter } from "../sessions/session-manager.js";

/** How long a dialog stays open before the request falls back to the host. */
export const PROMPT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * A dialog that is declined or dismissed faster than this was not answered by
 * a person: the host declares elicitation support but cannot show the form
 * (seen in Grok Bot). Dialogs are then switched off for this host.
 */
export const INSTANT_ANSWER_MS = 500;

const PREVIEW_CHARS = 1500;

/** Form dialogs only; a client that offers URL mode alone cannot show one. */
export function supportsFormDialogs(capabilities?: ClientCapabilities): boolean {
    return capabilities?.elicitation?.form !== undefined;
}

/** Plain-text description of the request: what, where, and a preview of the change or command. */
export function describePermission(request: {
    permission: PendingPermissionSummary;
    agent: string;
    cwd: string;
}): string {
    const { permission } = request;
    const lines = [`${request.agent} wants to: ${permission.title}`, `Project: ${request.cwd}`];
    for (const diff of permission.diffs) {
        const change =
            diff.old_text === null
                ? `new file, ${diff.new_lines} lines`
                : `${diff.old_lines} → ${diff.new_lines} lines`;
        lines.push("", `File: ${diff.path} (${change})`, truncate(diff.new_text, PREVIEW_CHARS).text);
    }
    if (permission.diffs.length === 0 && permission.input) {
        lines.push("", truncate(permission.input, PREVIEW_CHARS).text);
    }
    return lines.join("\n");
}

/**
 * Asks the user through MCP elicitation (a form dialog in the host). Accept
 * with a decision answers the request. Decline, cancel, a timeout or an error
 * leave it to the host, which then asks in the chat: a declined form is not a
 * reliable "deny", because some hosts decline forms they cannot show.
 * `onUnusable` is called when the host answered too fast for a person.
 */
export function createElicitationPrompter(
    server: McpServer,
    onUnusable: () => void,
    now: () => number = Date.now,
): PermissionPrompter {
    return async (request, signal) => {
        const decisions = decisionsFor(request.permission);
        if (decisions.length === 0) {
            return null;
        }
        const params: ElicitRequestFormParams = {
            mode: "form",
            message: describePermission(request),
            requestedSchema: {
                type: "object",
                properties: {
                    decision: {
                        type: "string",
                        title: "Decision",
                        enum: decisions,
                        enumNames: decisions.map((decision) => DECISION_LABEL[decision]),
                    },
                },
                required: ["decision"],
            },
        };
        const shownAt = now();
        const result = await server.server.elicitInput(params, { signal, timeout: PROMPT_TIMEOUT_MS });
        if (result.action !== "accept") {
            if (now() - shownAt < INSTANT_ANSWER_MS) {
                onUnusable();
            }
            return null;
        }
        const chosen = result.content?.decision;
        return decisions.find((decision) => decision === chosen) ?? null;
    };
}
