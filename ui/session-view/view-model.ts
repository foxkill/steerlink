// What the session view shows, derived from view_session_state results.
// No DOM access here, so it runs (and is tested) in Node as well.

import {
    DECISION_LABEL,
    decisionsFor,
    type DiffSummary,
    type PendingPermissionSummary,
    type PermissionDecision,
    type SessionEvent,
    type SessionStatus,
    type ViewState,
} from "../../src/sessions/session-events.js";

export type Card =
    | { id: number; type: "message"; text: string }
    | {
          id: number;
          type: "tool";
          title: string;
          status: string;
          files: string[];
          diffs: DiffSummary[];
          output: string | null;
      }
    | { id: number; type: "plan"; entries: Array<{ content: string; status: string }> }
    | { id: number; type: "note"; text: string; tone: "info" | "success" | "error" }
    | { id: number; type: "you"; text: string };

export interface PendingCard {
    permission_id: string;
    title: string;
    preview: string;
    choices: Array<{ decision: PermissionDecision; label: string }>;
    /** The user's dialog in the host is open for it as well. */
    asked_in_dialog: boolean;
}

export interface ViewModel {
    session_id: string;
    agent: string;
    cwd: string;
    status: SessionStatus;
    mode: string | null;
    cards: Card[];
    pending: PendingCard[];
    last_seq: number;
}

const OUTCOME_TEXT: Record<string, string> = {
    allow_once: "Allowed once",
    allow_always: "Always allowed",
    reject_once: "Denied",
    reject_always: "Always denied",
    cancelled: "Cancelled",
};

const PREVIEW_LINES = 40;

export function emptyModel(sessionId: string): ViewModel {
    return {
        session_id: sessionId,
        agent: "",
        cwd: "",
        status: "idle",
        mode: null,
        cards: [],
        pending: [],
        last_seq: 0,
    };
}

function previewOf(permission: PendingPermissionSummary): string {
    const parts: string[] = [];
    for (const diff of permission.diffs) {
        const lines = diff.new_text.split("\n");
        const shown = lines.slice(0, PREVIEW_LINES).map((line) => `+ ${line}`);
        if (lines.length > PREVIEW_LINES) {
            shown.push(`… ${lines.length - PREVIEW_LINES} more lines`);
        }
        parts.push([diff.path, ...shown].join("\n"));
    }
    if (parts.length === 0 && permission.input) {
        parts.push(permission.input);
    }
    return parts.join("\n\n");
}

function pendingCard(permission: PendingPermissionSummary): PendingCard {
    return {
        permission_id: permission.permission_id,
        title: permission.title,
        preview: previewOf(permission),
        choices: decisionsFor(permission).map((decision) => ({ decision, label: DECISION_LABEL[decision] })),
        asked_in_dialog: permission.asked_user,
    };
}

/** The card for an event, or null for events the view does not show as a card. */
function cardFor(event: SessionEvent): Card | null {
    const id = event.id ?? event.seq;
    switch (event.type) {
        case "message":
            return { id, type: "message", text: event.text };
        case "thought":
            return null;
        case "tool_call":
            return {
                id,
                type: "tool",
                title: event.tool_call.title,
                status: event.tool_call.status,
                files: event.tool_call.locations,
                diffs: event.tool_call.diffs,
                output: event.tool_call.output ?? null,
            };
        case "plan":
            return { id, type: "plan", entries: event.entries.map(({ content, status }) => ({ content, status })) };
        case "mode":
            return { id, type: "note", text: `Mode: ${event.mode_id}`, tone: "info" };
        case "permission_request":
            return { id, type: "note", text: `Approval needed: ${event.permission.title}`, tone: "info" };
        case "permission_resolved": {
            const outcome = OUTCOME_TEXT[event.outcome] ?? event.outcome;
            const by =
                event.answered_by === "user" ? " by you" : event.answered_by === "host" ? " by the assistant" : "";
            return {
                id,
                type: "note",
                text: `${outcome}${by}`,
                tone: event.outcome.startsWith("allow") ? "success" : "info",
            };
        }
        case "turn_end":
            return { id, type: "note", text: "Done", tone: "success" };
        case "error":
            return { id, type: "note", text: event.message, tone: "error" };
        default: {
            const unhandled: never = event;
            void unhandled;
            return null;
        }
    }
}

/** Merges a view_session_state result into the model; events with a known id replace their card. */
export function applyState(model: ViewModel, state: ViewState): ViewModel {
    const cards = [...model.cards];
    for (const event of state.events) {
        const card = cardFor(event);
        if (!card) {
            continue;
        }
        const index = cards.findIndex((existing) => existing.id === card.id && existing.type !== "you");
        if (index === -1) {
            cards.push(card);
        } else {
            cards[index] = card;
        }
    }
    return {
        session_id: state.session_id,
        agent: state.agent,
        cwd: state.cwd,
        status: state.status,
        mode: state.current_mode,
        cards,
        pending: state.pending_permissions.map((permission) => pendingCard(permission)),
        last_seq: Math.max(model.last_seq, state.last_seq),
    };
}

/** The session is gone (closed by the host or the user). */
export function closedModel(model: ViewModel): ViewModel {
    return { ...model, status: "closed", pending: [] };
}

/** A message the user sent from the view, shown right away. Its id never collides with event ids. */
export function addOwnMessage(model: ViewModel, text: string): ViewModel {
    return { ...model, cards: [...model.cards, { id: -(model.cards.length + 1), type: "you", text }] };
}

const STATUS_TEXT: Record<SessionStatus, string> = {
    idle: "Ready",
    running: "Working…",
    awaiting_permission: "Waiting for your approval",
    closed: "Session closed",
};

export function statusText(status: SessionStatus): string {
    return STATUS_TEXT[status];
}

/** Minimal runtime check of a tool result before the view trusts its shape. */
export function isViewState(value: unknown): value is ViewState {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    return (
        typeof Reflect.get(value, "session_id") === "string" &&
        typeof Reflect.get(value, "status") === "string" &&
        typeof Reflect.get(value, "last_seq") === "number" &&
        Array.isArray(Reflect.get(value, "events")) &&
        Array.isArray(Reflect.get(value, "pending_permissions"))
    );
}
