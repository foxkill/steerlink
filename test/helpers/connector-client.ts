import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
    ElicitRequestSchema,
    type ClientCapabilities,
    type ElicitRequest,
    type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";

const root = join(import.meta.dirname, "..", "..");

export const REPO_ROOT = root;
export const FAKE_AGENT_PATH = join(root, "test", "fixtures", "fake-agent.ts");

const SYSTEM_VARIABLES = new Set(
    [
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "SYSTEMDRIVE",
        "WINDIR",
        "COMSPEC",
        "TEMP",
        "TMP",
        "TMPDIR",
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMDATA",
        "PROGRAMFILES",
        "LANG",
        "LC_ALL",
        "USER",
        "USERNAME",
    ].map((name) => name.toUpperCase()),
);

function isSystemVariable(name: string): boolean {
    const upper = name.toUpperCase();
    return SYSTEM_VARIABLES.has(upper) || upper.startsWith("NPM_CONFIG_");
}

export interface ToolCallOutcome<T> {
    isError: boolean;
    text: string;
    data: T;
}

/** Answers the connector's permission dialogs (MCP elicitation) like a user would. */
export type DialogHandler = (request: ElicitRequest["params"], signal: AbortSignal) => Promise<ElicitResult>;

/** MCP client that starts the connector as a stdio subprocess, just like Grok Bot. */
export class ConnectorClient {
    private readonly client: Client;
    private transport: StdioClientTransport | undefined;

    /**
     * With `dialogs`, the client declares form elicitation support and answers
     * with the handler. `capabilities` adds more, e.g. the MCP Apps extension.
     */
    constructor(dialogs?: DialogHandler, capabilities: ClientCapabilities = {}) {
        this.client = new Client(
            { name: "connector-test", version: "1.0.0" },
            { capabilities: { ...capabilities, ...(dialogs ? { elicitation: { form: {} } } : {}) } },
        );
        if (dialogs) {
            this.client.setRequestHandler(ElicitRequestSchema, (request, extra) =>
                dialogs(request.params, extra.signal),
            );
        }
    }

    /**
     * `isolated`: inherit only system variables (paths, temp, user profile, npm)
     * so that results don't depend on random variables in the developer's
     * environment (e.g. ANTHROPIC_BASE_URL or a Claude Code login token).
     */
    async connect(env: Record<string, string>, useDist: boolean = false, isolated: boolean = false): Promise<void> {
        const args = useDist ? [join(root, "dist", "main.js")] : ["--import", "tsx", join(root, "src", "main.ts")];
        await this.connectCommand({ command: process.execPath, args, env, cwd: root, isolated });
    }

    /** Starts any command as the connector, e.g. `npx steerlink` from an installation. */
    async connectCommand(params: {
        command: string;
        args: string[];
        env: Record<string, string>;
        cwd: string;
        isolated?: boolean;
    }): Promise<void> {
        const baseEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined && (!params.isolated || isSystemVariable(key))) {
                baseEnv[key] = value;
            }
        }
        this.transport = new StdioClientTransport({
            command: params.command,
            args: params.args,
            env: { ...baseEnv, ...params.env },
            cwd: params.cwd,
            stderr: "pipe",
        });
        await this.client.connect(this.transport);
    }

    /** Name and version the connector reports during MCP `initialize`. */
    serverVersion(): { name: string; version: string } | undefined {
        return this.client.getServerVersion();
    }

    async listTools(): Promise<Array<{ name: string; _meta?: Record<string, unknown> | undefined }>> {
        return (await this.client.listTools()).tools;
    }

    async readResource(uri: string): Promise<Array<{ uri: string; mimeType?: string | undefined; text?: unknown }>> {
        return (await this.client.readResource({ uri })).contents;
    }

    /** structuredContent of a tool call, for tools that return one. */
    async callStructured(
        name: string,
        args: Record<string, unknown> = {},
    ): Promise<Record<string, unknown> | undefined> {
        const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
        const structured: unknown = result.structuredContent;
        return typeof structured === "object" && structured !== null
            ? (structured as Record<string, unknown>)
            : undefined;
    }

    async listToolNames(): Promise<string[]> {
        const result = await this.client.listTools();
        return result.tools.map((tool) => tool.name);
    }

    async call<T>(name: string, args: Record<string, unknown> = {}): Promise<ToolCallOutcome<T>> {
        const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
        const content = result.content as Array<{ type: string; text?: string }>;
        const text = content.map((item) => item.text ?? "").join("\n");
        const isError = result.isError === true;
        let data = {} as T;
        if (!isError) {
            data = JSON.parse(text) as T;
        }
        return { isError, text, data };
    }

    async close(): Promise<void> {
        await this.client.close();
    }
}
