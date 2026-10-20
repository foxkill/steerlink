import { describe, expect, it } from "vitest";

import type { PendingPermissionSummary, ViewState } from "../src/sessions/session-events.js";
import {
    addOwnMessage,
    applyState,
    closedModel,
    emptyModel,
    isViewState,
    statusText,
} from "../ui/session-view/view-model.js";
import { defined } from "./helpers/defined.js";

function viewState(overrides: Partial<ViewState>): ViewState {
    return {
        session_id: "s1",
        agent: "claude",
        cwd: "/work",
        status: "running",
        current_mode: "default",
        turns: 1,
        events: [],
        pending_permissions: [],
        last_seq: 0,
        ...overrides,
    };
}

const permission: PendingPermissionSummary = {
    permission_id: "perm-1",
    session_id: "s1",
    tool_call_id: "t1",
    title: "Write a.txt",
    kind: "edit",
    diffs: [
        { path: "/work/a.txt", old_text: null, new_text: "one\ntwo", old_lines: 0, new_lines: 2, truncated: false },
    ],
    options: [
        { option_id: "y", name: "Yes", kind: "allow_once" },
        { option_id: "n", name: "No", kind: "reject_once" },
    ],
    asked_user: false,
};

describe("session view model", () => {
    it("turns events into cards and replaces a card when its event is updated", () => {
        let model = applyState(
            emptyModel("s1"),
            viewState({ events: [{ id: 1, seq: 1, type: "message", text: "Hel" }], last_seq: 1 }),
        );
        model = applyState(
            model,
            viewState({
                events: [
                    { id: 1, seq: 2, type: "message", text: "Hello" },
                    { id: 3, seq: 3, type: "turn_end", stop_reason: "end_turn" },
                ],
                status: "idle",
                last_seq: 3,
            }),
        );

        expect(model.cards).toEqual([
            { id: 1, type: "message", text: "Hello" },
            { id: 3, type: "note", text: "Done", tone: "success" },
        ]);
        expect(model.status).toBe("idle");
        expect(model.last_seq).toBe(3);
    });

    it("says who answered a permission request", () => {
        const model = applyState(
            emptyModel("s1"),
            viewState({
                events: [
                    {
                        id: 1,
                        seq: 1,
                        type: "permission_resolved",
                        permission_id: "p",
                        outcome: "allow_once",
                        answered_by: "user",
                    },
                    {
                        id: 2,
                        seq: 2,
                        type: "permission_resolved",
                        permission_id: "q",
                        outcome: "reject_once",
                        answered_by: "host",
                    },
                ],
            }),
        );
        expect(model.cards).toEqual([
            { id: 1, type: "note", text: "Allowed once by you", tone: "success" },
            { id: 2, type: "note", text: "Denied by the assistant", tone: "info" },
        ]);
    });

    it("shows open requests with a preview and exactly the offered choices", () => {
        const model = applyState(emptyModel("s1"), viewState({ pending_permissions: [permission] }));
        expect(model.pending).toEqual([
            {
                permission_id: "perm-1",
                title: "Write a.txt",
                preview: "/work/a.txt\n+ one\n+ two",
                choices: [
                    { decision: "allow", label: "Allow once" },
                    { decision: "deny", label: "Deny" },
                ],
                asked_in_dialog: false,
            },
        ]);
    });

    it("previews long files only in part, and commands as they are", () => {
        const long = Array.from({ length: 45 }, (_, index) => `line ${index}`).join("\n");
        const diff = defined(permission.diffs[0], "diff");
        const model = applyState(
            emptyModel("s1"),
            viewState({
                pending_permissions: [
                    { ...permission, diffs: [{ ...diff, new_text: long }] },
                    { ...permission, permission_id: "perm-2", diffs: [], input: '{"command":"npm test"}' },
                ],
            }),
        );
        expect(model.pending[0]?.preview.split("\n")).toHaveLength(42);
        expect(model.pending[0]?.preview).toContain("… 5 more lines");
        expect(model.pending[1]?.preview).toBe('{"command":"npm test"}');
    });

    it("keeps the user's own messages next to agent cards", () => {
        const model = addOwnMessage(emptyModel("s1"), "Please add tests");
        const updated = applyState(model, viewState({ events: [{ id: 1, seq: 1, type: "message", text: "On it" }] }));
        expect(updated.cards).toEqual([
            { id: -1, type: "you", text: "Please add tests" },
            { id: 1, type: "message", text: "On it" },
        ]);
    });

    it("a closed session has no open requests", () => {
        const model = closedModel(applyState(emptyModel("s1"), viewState({ pending_permissions: [permission] })));
        expect(model.status).toBe("closed");
        expect(model.pending).toEqual([]);
        expect(statusText("closed")).toBe("Session closed");
    });

    it("recognises a view state and rejects anything else", () => {
        expect(isViewState(viewState({}))).toBe(true);
        expect(isViewState({ session_id: "s1" })).toBe(false);
        expect(isViewState(null)).toBe(false);
    });
});
