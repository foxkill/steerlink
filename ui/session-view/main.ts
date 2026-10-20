// The session view: an MCP App the host renders in the chat. It follows a
// session live and lets the user answer permission requests, send messages
// and stop the agent. Everything from the agent is inserted as text, never as HTML.

import {
    App,
    applyDocumentTheme,
    applyHostFonts,
    applyHostStyleVariables,
    type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-with-deps";

import type { PermissionDecision } from "../../src/sessions/session-events.js";
import {
    addOwnMessage,
    applyState,
    closedModel,
    emptyModel,
    isViewState,
    statusText,
    type Card,
    type PendingCard,
    type ViewModel,
} from "./view-model.js";

const LONG_POLL_SECONDS = 20;
const RETRY_DELAY_MS = 2000;

const app = new App({ name: "SteerLink session", version: "1.0.0" }, {}, { autoResize: true });
let model: ViewModel | undefined;
let polling = false;
let stopped = false;

function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

function byId(id: string): HTMLElement {
    const node = document.querySelector<HTMLElement>(`#${id}`);
    if (!node) {
        throw new Error(`Missing element #${id}`);
    }
    return node;
}

function renderCard(card: Card): HTMLElement {
    switch (card.type) {
        case "message":
            return element("div", "card message", card.text);
        case "you":
            return element("div", "card you", card.text);
        case "note":
            return element("div", `note ${card.tone}`, card.text);
        case "plan": {
            const list = element("ul", "card plan");
            for (const entry of card.entries) {
                list.append(element("li", `plan-${entry.status}`, entry.content));
            }
            return list;
        }
        case "tool": {
            const box = element("details", "card tool");
            const summary = element("summary");
            summary.append(
                element("span", `badge status-${card.status}`, card.status),
                element("span", "", ` ${card.title}`),
            );
            box.append(summary);
            for (const diff of card.diffs) {
                box.append(element("div", "path", diff.path), element("pre", "diff", diff.new_text));
            }
            if (card.diffs.length === 0 && card.files.length > 0) {
                box.append(element("div", "path", card.files.join("\n")));
            }
            if (card.output) {
                box.append(element("pre", "output", card.output));
            }
            return box;
        }
        default: {
            const unhandled: never = card;
            return unhandled;
        }
    }
}

/**
 * Reuses the element of an unchanged card, so expanded tool calls stay
 * expanded while the view refreshes. A changed card keeps its open state.
 */
const rendered = new Map<number, { signature: string; node: HTMLElement }>();

function cardElement(card: Card): HTMLElement {
    const signature = JSON.stringify(card);
    const cached = rendered.get(card.id);
    if (cached?.signature === signature) {
        return cached.node;
    }
    const node = renderCard(card);
    if (cached?.node instanceof HTMLDetailsElement && node instanceof HTMLDetailsElement) {
        node.open = cached.node.open;
    }
    rendered.set(card.id, { signature, node });
    return node;
}

function renderPending(pending: PendingCard): HTMLElement {
    const box = element("section", "pending");
    box.append(element("div", "pending-title", pending.title));
    if (pending.preview) {
        box.append(element("pre", "diff", pending.preview));
    }
    const buttons = element("div", "buttons");
    for (const choice of pending.choices) {
        // Only "Allow once" is the primary action; standing approvals should take a deliberate click.
        const style =
            choice.decision === "allow" ? "allow" : choice.decision === "allow_always" ? "allow-always" : "deny";
        const button = element("button", style, choice.label);
        button.addEventListener("click", () => {
            void answer(pending.permission_id, choice.decision, buttons);
        });
        buttons.append(button);
    }
    box.append(buttons);
    return box;
}

function render(current: ViewModel): void {
    byId("agent").textContent = current.agent || "Agent";
    byId("cwd").textContent = current.cwd;
    const status = byId("status");
    status.textContent = statusText(current.status) + (current.mode ? ` · ${current.mode}` : "");
    status.dataset.status = current.status;

    const timeline = byId("timeline");
    const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 40;
    const count = timeline.childElementCount;
    timeline.replaceChildren(...current.cards.map((card) => cardElement(card)));
    if (atBottom && timeline.childElementCount !== count) {
        timeline.scrollTop = timeline.scrollHeight;
    }

    const pending = byId("pending");
    pending.replaceChildren(...current.pending.map((entry) => renderPending(entry)));

    const closed = current.status === "closed";
    byId("stop").toggleAttribute("disabled", current.status === "idle" || closed);
    byId("send").toggleAttribute("disabled", current.status !== "idle");
    byId("message").toggleAttribute("disabled", closed);
}

function showError(text: string): void {
    const banner = byId("error");
    banner.textContent = text;
    banner.hidden = text.length === 0;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/** The view keeps polling until the host tears it down or the session is closed. */
function isActive(): boolean {
    return model !== undefined && !stopped && model.status !== "closed";
}

/** One long-poll round for the session in `current`. */
async function refresh(current: ViewModel): Promise<ViewModel> {
    const result = await app.callServerTool({
        name: "view_session_state",
        arguments: { session_id: current.session_id, after_seq: current.last_seq, wait_seconds: LONG_POLL_SECONDS },
    });
    if (result.isError) {
        // The session was closed (it is gone from the server) or never existed.
        return closedModel(current);
    }
    if (!isViewState(result.structuredContent)) {
        throw new Error("Unexpected answer from the server");
    }
    return applyState(current, result.structuredContent);
}

async function poll(): Promise<void> {
    if (polling) {
        return;
    }
    polling = true;
    try {
        while (isActive()) {
            const current = model;
            if (!current) {
                break;
            }
            try {
                const next = await refresh(current);
                // Ignore the answer if the view switched to another session meanwhile.
                if (model?.session_id === next.session_id) {
                    model = next;
                    showError("");
                    render(next);
                }
            } catch (error) {
                showError(error instanceof Error ? error.message : String(error));
                await sleep(RETRY_DELAY_MS);
            }
        }
    } finally {
        polling = false;
    }
}

async function answer(permissionId: string, decision: PermissionDecision, buttons: HTMLElement): Promise<void> {
    for (const button of buttons.querySelectorAll("button")) {
        button.disabled = true;
    }
    const result = await app.callServerTool({
        name: "view_answer_permission",
        arguments: { permission_id: permissionId, decision },
    });
    if (result.isError) {
        showError("This request was already answered or withdrawn.");
    }
}

async function send(): Promise<void> {
    const input = byId("message");
    if (!(input instanceof HTMLTextAreaElement) || !model) {
        return;
    }
    const text = input.value.trim();
    if (!text) {
        return;
    }
    const result = await app.callServerTool({
        name: "view_send_prompt",
        arguments: { session_id: model.session_id, text },
    });
    if (result.isError) {
        showError("The agent is still working. Wait until it is ready, or stop it.");
        return;
    }
    input.value = "";
    model = addOwnMessage({ ...model, status: "running" }, text);
    render(model);
}

async function stop(): Promise<void> {
    if (model) {
        await app.callServerTool({ name: "view_cancel", arguments: { session_id: model.session_id } });
    }
}

function applyHostContext(context: McpUiHostContext | undefined): void {
    if (context?.theme) {
        applyDocumentTheme(context.theme);
    }
    if (context?.styles?.variables) {
        applyHostStyleVariables(context.styles.variables);
    }
    if (context?.styles?.css?.fonts) {
        applyHostFonts(context.styles.css.fonts);
    }
}

app.addEventListener("toolresult", (params) => {
    const sessionId: unknown = params.structuredContent
        ? Reflect.get(params.structuredContent, "session_id")
        : undefined;
    if (typeof sessionId !== "string") {
        showError(params.isError ? "No session to show." : "The server did not name a session.");
        return;
    }
    if (model?.session_id !== sessionId) {
        model = emptyModel(sessionId);
        render(model);
    }
    void poll();
});

app.addEventListener("hostcontextchanged", (context) => {
    applyHostContext(context);
});

app.onteardown = () => {
    stopped = true;
    return {};
};

byId("send").addEventListener("click", () => {
    void send();
});
byId("message").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void send();
    }
});
byId("stop").addEventListener("click", () => {
    void stop();
});

await app.connect();
applyHostContext(app.getHostContext());
