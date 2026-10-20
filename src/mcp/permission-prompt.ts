import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientCapabilities, ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";

import { truncate, type PendingPermissionSummary } from "../sessions/session-events.js";
import type { PermissionDecision, PermissionPrompter } from "../sessions/session-manager.js";

/** How long a dialog stays open before the request falls back to the host. */
export const PROMPT_TIMEOUT_MS = 15 * 60 * 1000;

const PREVIEW_CHARS = 1500;

const DECISION_FOR_KIND: Record<string, PermissionDecision> = {
    allow_once: "allow",
    allow_always: "allow_always",
    reject_once: "deny",
    reject_always: "deny_always",
};

const DECISION_LABEL: Record<PermissionDecision, string> = {
    allow: "Allow once",
    allow_always: "Always allow",
    deny: "Deny",
    deny_always: "Always deny",
};

/** Form dialogs only; a client that offers URL mode alone cannot show one. */
export function supportsFormDialogs(capabilities?: ClientCapabilities): boolean {
    return capabilities?.elicitation?.form !== undefined;
}

/** The decisions this request offers, in the agent's order, without duplicates. */
export function decisionsFor(permission: PendingPermissionSummary): PermissionDecision[] {
    const decisions: PermissionDecision[] = [];
    for (const option of permission.options) {
        const decision = DECISION_FOR_KIND[option.kind];
        if (decision && !decisions.includes(decision)) {
            decisions.push(decision);
        }
    }
    return decisions;
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
 * with a decision answers the request; decline means deny; cancel, a timeout
 * or an error leave it to the host.
 */
export function createElicitationPrompter(server: McpServer): PermissionPrompter {
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
        const result = await server.server.elicitInput(params, { signal, timeout: PROMPT_TIMEOUT_MS });
        if (result.action === "decline") {
            return decisions.includes("deny") ? "deny" : null;
        }
        if (result.action !== "accept") {
            return null;
        }
        const chosen = result.content?.decision;
        return decisions.find((decision) => decision === chosen) ?? null;
    };
}
