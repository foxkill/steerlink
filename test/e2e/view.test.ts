import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startViewHost, type ViewHost } from "../../scripts/view-host.js";

/**
 * The session view in a real browser: headless Chrome loads the local view
 * host, which renders the view with the official AppBridge like an MCP Apps
 * host. Runs with the fake agent, so it needs no sign-in. Skipped without
 * Chrome; set CHROME_PATH to use a specific browser. STEERLINK_VIEW_SCREENSHOT=<file.png>
 * keeps the screenshot of the approval request.
 */

const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
    String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const chromePath = CHROME_CANDIDATES.find((candidate) => candidate !== undefined && existsSync(candidate));

/** Just enough of the Chrome DevTools Protocol to drive one page. */
class Devtools {
    private nextId = 0;
    private readonly waiting = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();

    private constructor(private readonly socket: WebSocket) {
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data)) as {
                id?: number;
                result?: unknown;
                error?: { message: string };
            };
            if (message.id !== undefined) {
                this.waiting.get(message.id)?.(message);
                this.waiting.delete(message.id);
            }
        });
    }

    static async connect(url: string): Promise<Devtools> {
        const socket = new WebSocket(url);
        await new Promise((resolve, reject) => {
            socket.addEventListener("open", resolve, { once: true });
            socket.addEventListener("error", reject, { once: true });
        });
        return new Devtools(socket);
    }

    async send<T>(method: string, params: object = {}): Promise<T> {
        this.nextId += 1;
        const id = this.nextId;
        const reply = await new Promise<{ result?: unknown; error?: { message: string } }>((resolve) => {
            this.waiting.set(id, resolve);
            this.socket.send(JSON.stringify({ id, method, params }));
        });
        if (reply.error) {
            throw new Error(`${method}: ${reply.error.message}`);
        }
        return reply.result as T;
    }

    /** Evaluates an expression in the page (awaiting promises) and returns its JSON value. */
    async evaluate<T>(expression: string): Promise<T> {
        const result = await this.send<{ result: { value?: unknown }; exceptionDetails?: { text: string } }>(
            "Runtime.evaluate",
            { expression, awaitPromise: true, returnByValue: true },
        );
        if (result.exceptionDetails) {
            throw new Error(`Page error: ${result.exceptionDetails.text}`);
        }
        return result.result.value as T;
    }

    close(): void {
        this.socket.close();
    }
}

/** Reads inside the view's frame (the local host gives it the same origin for this check). */
const IN_VIEW = `document.querySelector("#view")?.contentDocument`;

/** The DevTools client uses the global WebSocket, which Node has from version 22. */
const hasWebSocket = typeof globalThis.WebSocket === "function";

describe.skipIf(!chromePath || !hasWebSocket)("Session view in a browser", () => {
    let host: ViewHost;
    let chrome: ChildProcess;
    let profile: string;
    let page: Devtools;
    let screenshotPath: string;

    beforeAll(async () => {
        host = await startViewHost();
        profile = mkdtempSync(join(tmpdir(), "steerlink-chrome-"));
        screenshotPath = process.env.STEERLINK_VIEW_SCREENSHOT ?? join(profile, "view.png");
        chrome = spawn(
            chromePath ?? "",
            [
                "--headless=new",
                "--remote-debugging-port=0",
                `--user-data-dir=${profile}`,
                "--no-first-run",
                "--no-default-browser-check",
                "--window-size=1280,900",
                // CI containers on Linux lack the user namespaces Chrome's sandbox needs.
                ...(process.platform === "linux" ? ["--no-sandbox"] : []),
                "about:blank",
            ],
            { stdio: "ignore" },
        );
        const port = await vi.waitFor(
            () => {
                const [line] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n");
                if (line === undefined || !/^\d+$/.test(line)) {
                    throw new Error("Chrome has not opened its debugging port yet");
                }
                return line;
            },
            { timeout: 60000, interval: 200 },
        );
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
            type: string;
            webSocketDebuggerUrl: string;
        }>;
        const target = targets.find((entry) => entry.type === "page");
        page = await Devtools.connect(String(target?.webSocketDebuggerUrl));
        await page.send("Page.enable");
        await page.send("Page.navigate", { url: host.url });
        await vi.waitFor(
            async () => {
                if (!(await page.evaluate<boolean>("typeof globalThis.steerlink === 'object'"))) {
                    throw new Error("The view host page has not loaded yet");
                }
            },
            { timeout: 60000, interval: 200 },
        );
    });

    afterAll(async () => {
        page.close();
        chrome.kill();
        await host.close();
        await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    });

    it("shows the request, the user approves it with a click, the file is written", async () => {
        const cwd = JSON.stringify(host.workDir);
        await page.evaluate(`(async () => {
            const started = await steerlink.call("start_session", { cwd: ${cwd} });
            const id = JSON.parse(steerlink.textOf(started)).session_id;
            await steerlink.call("send_prompt", { session_id: id, text: "write browser.txt hello", wait: false });
            await steerlink.mountView(await steerlink.call("show_session", { session_id: id }));
        })()`);

        const buttons = await vi.waitFor(
            async () => {
                const labels = await page.evaluate<string[] | null>(
                    `[...(${IN_VIEW}?.querySelectorAll(".pending button") ?? [])].map((button) => button.textContent)`,
                );
                expect(labels).toEqual(["Allow once", "Always allow", "Deny"]);
                return labels;
            },
            { timeout: 30000, interval: 250 },
        );
        expect(buttons).toHaveLength(3);
        expect(await page.evaluate<string>(`${IN_VIEW}.querySelector("section.pending").textContent`)).toContain(
            "+ hello",
        );
        expect(await page.evaluate<string>(`${IN_VIEW}.querySelector("#status").textContent`)).toContain(
            "Waiting for your approval",
        );

        const frame = await page.evaluate<{ x: number; y: number; width: number; height: number }>(
            `(() => { const r = document.querySelector("#view").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
        );
        const shot = await page.send<{ data: string }>("Page.captureScreenshot", {
            format: "png",
            clip: { ...frame, scale: 1 },
        });
        writeFileSync(screenshotPath, Buffer.from(shot.data, "base64"));

        await page.evaluate(`${IN_VIEW}.querySelector(".pending button.allow").click()`);

        await vi.waitFor(
            () => {
                expect(existsSync(join(host.workDir, "browser.txt"))).toBe(true);
            },
            { timeout: 30000, interval: 250 },
        );
        await vi.waitFor(
            async () => {
                const timeline = await page.evaluate<string>(`${IN_VIEW}.querySelector("#timeline").textContent`);
                expect(timeline).toContain("Allowed once by you");
                expect(timeline).toContain("Done");
            },
            { timeout: 30000, interval: 250 },
        );
        expect(readFileSync(join(host.workDir, "browser.txt"), "utf8")).toBe("hello");
    });
});
