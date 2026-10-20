import type { PermissionOption, ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk";

/** Truncated diff of a file, as reported by a tool call. */
export interface DiffSummary {
    path: string;
    old_text: string | null;
    new_text: string;
    old_lines: number;
    new_lines: number;
    truncated: boolean;
}

export interface ToolCallSummary {
    tool_call_id: string;
    title: string;
    kind: string;
    status: string;
    locations: string[];
    diffs: DiffSummary[];
    output?: string | undefined;
}

export interface PermissionOptionSummary {
    option_id: string;
    name: string;
    kind: string;
}

export interface PendingPermissionSummary {
    permission_id: string;
    session_id: string;
    tool_call_id: string;
    title: string;
    kind: string;
    input?: string | undefined;
    diffs: DiffSummary[];
    options: PermissionOptionSummary[];
    /** True while the user is answering this request in the host's dialog; do not ask them again. */
    asked_user: boolean;
}

/**
 * `seq` orders events and grows when an event is updated in place; `id` is
 * the event's stable identity (its first seq).
 */
export type SessionEvent = { id?: number } & (
    | { seq: number; type: "message"; text: string }
    | { seq: number; type: "thought"; text: string }
    | { seq: number; type: "tool_call"; tool_call: ToolCallSummary }
    | { seq: number; type: "plan"; entries: Array<{ content: string; status: string; priority: string }> }
    | { seq: number; type: "mode"; mode_id: string }
    | { seq: number; type: "permission_request"; permission: PendingPermissionSummary }
    | {
          seq: number;
          type: "permission_resolved";
          permission_id: string;
          outcome: string;
          answered_by?: "user" | "host" | undefined;
      }
    | { seq: number; type: "turn_end"; stop_reason: string }
    | { seq: number; type: "error"; message: string }
);

export const MAX_TEXT = 4000;

export function truncate(text: string, max: number = MAX_TEXT): { text: string; truncated: boolean } {
    if (text.length <= max) {
        return { text, truncated: false };
    }
    return { text: `${text.slice(0, max)}\n…[${text.length - max} characters truncated]`, truncated: true };
}

function countLines(text: string | null | undefined): number {
    if (!text) {
        return 0;
    }
    return text.split("\n").length;
}

export function summarizeDiffs(content: ToolCallContent[] | null | undefined): DiffSummary[] {
    const diffs: DiffSummary[] = [];
    for (const item of content ?? []) {
        if (item.type !== "diff") {
            continue;
        }
        const oldText = item.oldText === null || item.oldText === undefined ? null : truncate(item.oldText);
        const newText = truncate(item.newText);
        diffs.push({
            path: item.path,
            old_text: oldText ? oldText.text : null,
            new_text: newText.text,
            old_lines: countLines(item.oldText),
            new_lines: countLines(item.newText),
            truncated: newText.truncated || (oldText?.truncated ?? false),
        });
    }
    return diffs;
}

export function summarizeTextContent(content: ToolCallContent[] | null | undefined): string | undefined {
    const parts: string[] = [];
    for (const item of content ?? []) {
        if (item.type === "content" && item.content.type === "text") {
            parts.push(item.content.text);
        }
    }
    return parts.length > 0 ? truncate(parts.join("\n"), 2000).text : undefined;
}

export function summarizeLocations(locations: ToolCallLocation[] | null | undefined): string[] {
    return (locations ?? []).map((location) => (location.line ? `${location.path}:${location.line}` : location.path));
}

export function summarizeOptions(options: PermissionOption[]): PermissionOptionSummary[] {
    return options.map((option) => ({ option_id: option.optionId, name: option.name, kind: option.kind }));
}

export function stringifyInput(rawInput: unknown): string | undefined {
    if (rawInput === undefined || rawInput === null) {
        return undefined;
    }
    try {
        return truncate(JSON.stringify(rawInput), 2000).text;
    } catch {
        return undefined;
    }
}

export type SessionStatus = "idle" | "running" | "awaiting_permission" | "closed";
export type PermissionDecision = "allow" | "allow_always" | "deny" | "deny_always";

/** Everything the session view (MCP App) shows; reading it never moves the host's cursor. */
export interface ViewState {
    session_id: string;
    agent: string;
    cwd: string;
    status: SessionStatus;
    current_mode: string | null;
    turns: number;
    events: SessionEvent[];
    pending_permissions: PendingPermissionSummary[];
    /** Pass as after_seq on the next call to get only newer events. */
    last_seq: number;
}

const DECISION_FOR_KIND: Readonly<Record<string, PermissionDecision>> = {
    allow_once: "allow",
    allow_always: "allow_always",
    reject_once: "deny",
    reject_always: "deny_always",
};

export const DECISION_LABEL: Readonly<Record<PermissionDecision, string>> = {
    allow: "Allow once",
    allow_always: "Always allow",
    deny: "Deny",
    deny_always: "Always deny",
};

/** The decisions a permission request offers, in the agent's order, without duplicates. */
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
