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
}

export type SessionEvent =
    | { seq: number; type: "message"; text: string }
    | { seq: number; type: "thought"; text: string }
    | { seq: number; type: "tool_call"; tool_call: ToolCallSummary }
    | { seq: number; type: "plan"; entries: Array<{ content: string; status: string; priority: string }> }
    | { seq: number; type: "mode"; mode_id: string }
    | { seq: number; type: "permission_request"; permission: PendingPermissionSummary }
    | { seq: number; type: "permission_resolved"; permission_id: string; outcome: string }
    | { seq: number; type: "turn_end"; stop_reason: string }
    | { seq: number; type: "error"; message: string };

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
