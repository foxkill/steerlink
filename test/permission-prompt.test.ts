import { describe, expect, it } from "vitest";

import { describePermission, supportsFormDialogs } from "../src/mcp/permission-prompt.js";
import { decisionsFor } from "../src/sessions/session-events.js";

describe("permission-prompt helpers", () => {
    const permission = {
        permission_id: "perm-1",
        session_id: "s",
        tool_call_id: "t",
        title: "Run npm test",
        kind: "execute",
        input: '{"command":"npm test"}',
        diffs: [],
        options: [
            { option_id: "a", name: "Yes", kind: "allow_once" },
            { option_id: "b", name: "No", kind: "reject_once" },
            { option_id: "c", name: "No, never", kind: "reject_always" },
        ],
        asked_user: false,
    };

    it("only form-capable hosts get dialogs", () => {
        expect(supportsFormDialogs({ elicitation: { form: {} } })).toBe(true);
        expect(supportsFormDialogs({ elicitation: { url: {} } })).toBe(false);
        expect(supportsFormDialogs({})).toBe(false);
        expect(supportsFormDialogs()).toBe(false);
    });

    it("offers exactly the agent's choices", () => {
        expect(decisionsFor(permission)).toEqual(["allow", "deny", "deny_always"]);
        expect(decisionsFor({ ...permission, options: [] })).toEqual([]);
    });

    it("shows the command when there is no diff", () => {
        const text = describePermission({ permission, agent: "claude", cwd: "/work" });
        expect(text).toBe('claude wants to: Run npm test\nProject: /work\n\n{"command":"npm test"}');
    });
});
