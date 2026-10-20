// Browser side of the local view host: renders the session view like an MCP
// Apps host would, using the official AppBridge. Tool calls go to the local
// Node server, which forwards them to SteerLink.

import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const response = await fetch("/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, arguments: args }),
    });
    return CallToolResultSchema.parse(await response.json());
}

function textOf(result: CallToolResult): string {
    return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

function byId(id: string): HTMLElement {
    const node = document.querySelector<HTMLElement>(`#${id}`);
    if (!node) {
        throw new Error(`Missing element #${id}`);
    }
    return node;
}

/** Value of an input or textarea. */
function valueOf(id: string): string {
    const node = byId(id);
    return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node.value : "";
}

/** Shows the view for a show_session result, as a host does after the model called the tool. */
async function mountView(toolResult: CallToolResult): Promise<void> {
    const old = document.querySelector("#view");
    const iframe = document.createElement("iframe");
    iframe.id = "view";
    // Real hosts use an opaque origin. Same origin here lets the automated check look inside.
    iframe.sandbox.add("allow-scripts", "allow-same-origin");
    if (old) {
        old.replaceWith(iframe);
    } else {
        byId("stage").append(iframe);
    }
    const target = iframe.contentWindow;
    if (!target) {
        throw new Error("The view frame has no window");
    }
    const bridge = new AppBridge(null, { name: "SteerLink view host", version: "1.0.0" }, { serverTools: {} });
    bridge.oncalltool = (params) => call(params.name, params.arguments ?? {});
    bridge.addEventListener("initialized", () => {
        void bridge.sendToolResult(toolResult);
    });
    bridge.addEventListener("sizechange", ({ height }) => {
        if (height !== undefined) {
            iframe.style.height = `${height}px`;
        }
    });
    bridge.setHostContext({ theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" });
    // Connect before the document loads, so the view's first message is not missed.
    await bridge.connect(new PostMessageTransport(target, target));
    iframe.srcdoc = await (await fetch("/view")).text();
}

let sessionId: string | undefined;

function log(text: string): void {
    byId("log").textContent = text;
}

byId("start").addEventListener("click", () => {
    void (async () => {
        const result = await call("start_session", { cwd: valueOf("cwd") });
        log(textOf(result));
        if (!result.isError) {
            sessionId = z.object({ session_id: z.string() }).parse(JSON.parse(textOf(result))).session_id;
            await mountView(await call("show_session", { session_id: sessionId }));
        }
    })();
});

byId("prompt").addEventListener("click", () => {
    void (async () => {
        if (!sessionId) {
            log("Start a session first.");
            return;
        }
        const text = valueOf("text");
        log(textOf(await call("send_prompt", { session_id: sessionId, text, wait: false })));
    })();
});

Object.assign(globalThis, { steerlink: { call, mountView, textOf } });
