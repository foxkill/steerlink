// A local MCP Apps host for the session view, for development and the
// automated browser check. It starts SteerLink like a host would (declaring
// MCP Apps support), serves a small page that renders the view with the
// official AppBridge, and forwards the view's tool calls to SteerLink.
//
//   npm run view:host               fake agent, nothing is billed
//   npm run view:host -- --claude   real Claude Code (your own sign-in)

import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";
import { z } from "zod";

import { MCP_APP_MIME_TYPE, MCP_APPS_EXTENSION, SESSION_VIEW_URI } from "../src/mcp/session-view.js";
import { buildUi } from "./build-ui.js";

const ROOT = join(import.meta.dirname, "..");
const FAKE_AGENT = join(ROOT, "test", "fixtures", "fake-agent.ts");

const callSchema = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() });

export interface ViewHost {
    url: string;
    /** A project folder the agent may write to (the fake agent's temp folder, or the given one). */
    workDir: string;
    close: () => Promise<void>;
}

const PAGE = (script: string, workDir: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>SteerLink view host</title>
<style>
    body { margin: 0; font: 14px system-ui, sans-serif; background: #eef0f5; color: #111522; }
    header { padding: 12px 16px; background: #0f1a35; color: #f1f2f7; }
    main { display: grid; grid-template-columns: minmax(260px, 1fr) 2fr; gap: 16px; padding: 16px; }
    section { background: #fff; border-radius: 12px; padding: 12px; }
    input, textarea { width: 100%; box-sizing: border-box; margin: 4px 0 8px; font: inherit; }
    pre { white-space: pre-wrap; font-size: 12px; }
    iframe { width: 100%; height: 520px; border: 1px solid #d9dce5; border-radius: 12px; background: #fff; }
</style>
</head>
<body>
<header>SteerLink view host: renders the session view like an MCP Apps host</header>
<main>
    <section>
        <label>Project folder <input id="cwd" value="${escapeAttribute(workDir)}" /></label>
        <button id="start" type="button">Start session and show it</button>
        <label>Prompt, sent like the assistant would <textarea id="text">write hello.txt hi</textarea></label>
        <button id="prompt" type="button">Send prompt</button>
        <pre id="log"></pre>
    </section>
    <section id="stage"></section>
</main>
<script type="module">${script}</script>
</body>
</html>`;

function escapeAttribute(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

async function bundleHostScript(): Promise<string> {
    const result = await build({
        entryPoints: [join(ROOT, "ui", "view-host", "host.ts")],
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "es2022",
        write: false,
        logLevel: "silent",
    });
    const script = result.outputFiles[0]?.text;
    if (script === undefined) {
        throw new Error("esbuild produced no output for the view host");
    }
    return script.replaceAll("</script", String.raw`<\/script`);
}

async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
    response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    response.end(body);
}

export async function startViewHost(
    options: { claude?: boolean; port?: number; cwd?: string } = {},
): Promise<ViewHost> {
    await buildUi();
    const script = await bundleHostScript();

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
            env[key] = value;
        }
    }
    let workDir = options.cwd ?? process.cwd();
    if (!options.claude) {
        const configDir = mkdtempSync(join(tmpdir(), "steerlink-view-host-"));
        workDir = options.cwd ?? mkdtempSync(join(tmpdir(), "steerlink-demo-"));
        const configPath = join(configDir, "config.json");
        writeFileSync(
            configPath,
            JSON.stringify({
                default_agent: "demo",
                agent_servers: { demo: { command: process.execPath, args: ["--import", "tsx", FAKE_AGENT] } },
            }),
        );
        env.ACP_CONNECTOR_CONFIG = configPath;
    } else if (!env.ANTHROPIC_API_KEY) {
        env.ACP_CONNECTOR_AUTH_MODE = "subscription";
    }

    const client = new Client(
        { name: "steerlink-view-host", version: "1.0.0" },
        { capabilities: { extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } } } },
    );
    await client.connect(
        new StdioClientTransport({
            command: process.execPath,
            args: ["--import", "tsx", join(ROOT, "src", "main.ts")],
            env,
            cwd: ROOT,
            stderr: "inherit",
        }),
    );

    const server = createServer((request, response) => {
        void (async () => {
            try {
                if (request.method === "GET" && request.url === "/") {
                    send(response, 200, "text/html; charset=utf-8", PAGE(script, workDir));
                } else if (request.method === "GET" && request.url === "/view") {
                    const [content] = (await client.readResource({ uri: SESSION_VIEW_URI })).contents;
                    send(response, 200, "text/html; charset=utf-8", content && "text" in content ? content.text : "");
                } else if (request.method === "POST" && request.url === "/call") {
                    const body = callSchema.parse(JSON.parse(await readBody(request)));
                    const result = await client.callTool({ name: body.name, arguments: body.arguments ?? {} });
                    send(response, 200, "application/json", JSON.stringify(result));
                } else {
                    send(response, 404, "text/plain", "Not found");
                }
            } catch (error) {
                send(response, 500, "text/plain", error instanceof Error ? error.message : String(error));
            }
        })();
    });
    await new Promise<void>((resolve) => {
        server.listen(options.port ?? 0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    return {
        url: `http://127.0.0.1:${port}/`,
        workDir,
        close: async () => {
            await new Promise<void>((resolve) => {
                server.close(() => {
                    resolve();
                });
            });
            await client.close();
        },
    };
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
    const host = await startViewHost({ claude: process.argv.includes("--claude"), port: 5173 });
    console.error(`View host running at ${host.url} (project folder: ${host.workDir}). Ctrl+C to stop.`);
    process.on("SIGINT", () => {
        void host.close().then(() => process.exit(0));
    });
}
