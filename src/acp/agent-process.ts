import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
    client,
    methods,
    ndJsonStream,
    PROTOCOL_VERSION,
    type ClientConnection,
    type ClientContext,
    type InitializeResponse,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification,
} from "@agentclientprotocol/sdk";

import type { AgentLaunch } from "../auth/agent-launch.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../package-info.js";
import { killOrphanedDescendants, killProcessTree, SPAWN_IN_OWN_PROCESS_GROUP } from "./process-tree.js";

/** Identity reported by the agent, without email, organization or other details. */
export interface AgentReportedAuth {
    kind: string;
    label: string;
    plan?: string;
    detail?: string;
}

interface AuthStatusPayload {
    authStatus?: {
        kind?: unknown;
        label?: unknown;
        detail?: unknown;
        account?: { plan?: unknown };
    };
}

/** Method the Claude adapter uses to push its identity (`_meta` extension). */
export const AUTH_STATUS_UPDATE_METHOD = "_auth/status_update";

/** `detail` is only safe for these kinds (e.g. "ANTHROPIC_API_KEY", gateway host). */
const KINDS_WITH_SAFE_DETAIL = new Set(["api_key", "gateway", "external"]);

export function sanitizeAuthStatus(payload: AuthStatusPayload): AgentReportedAuth | undefined {
    const status = payload.authStatus;
    if (!status || typeof status.kind !== "string") {
        return undefined;
    }
    const result: AgentReportedAuth = {
        kind: status.kind,
        label: typeof status.label === "string" ? status.label : status.kind,
    };
    if (typeof status.account?.plan === "string") {
        result.plan = status.account.plan;
    }
    if (KINDS_WITH_SAFE_DETAIL.has(status.kind) && typeof status.detail === "string") {
        result.detail = status.detail;
    }
    return result;
}

export interface AgentEventSink {
    onSessionUpdate(agentName: string, notification: SessionNotification): void;
    onPermissionRequest(agentName: string, request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
    onAgentExit(agentName: string, reason: string): void;
}

const STDERR_TAIL_LINES = 40;

/**
 * How long an agent has to exit on its own after stdin is closed before its
 * process tree is killed. MCP hosts themselves give the connector only about
 * 2 s after closing its stdin (the official SDK: 2 s, then SIGTERM, which
 * terminates immediately on Windows). Shutdown must therefore stay safely
 * below that, or agents are left behind orphaned.
 */
export const STOP_GRACE_MS = 1500;

/**
 * A running ACP agent process (e.g. claude-agent-acp) with its client-side
 * ACP connection. Several sessions share one process.
 */
export class AgentProcess {
    readonly name: string;
    initializeResponse: InitializeResponse | undefined;
    reportedAuth: AgentReportedAuth | undefined;
    readonly stderrTail: string[] = [];
    private child: ChildProcessWithoutNullStreams | undefined;
    private connection: ClientConnection | undefined;
    private exited = false;
    private authListeners: Array<() => void> = [];

    constructor(
        name: string,
        private readonly launch: AgentLaunch,
        private readonly sink: AgentEventSink,
        private readonly debug: boolean,
    ) {
        this.name = name;
    }

    get running(): boolean {
        return this.child !== undefined && !this.exited;
    }

    get agent(): ClientContext {
        if (!this.connection || this.exited) {
            throw new Error(`Agent "${this.name}" is not running`);
        }
        return this.connection.agent;
    }

    async start(): Promise<InitializeResponse> {
        const child = spawn(this.launch.command, this.launch.args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: this.launch.env,
            detached: SPAWN_IN_OWN_PROCESS_GROUP,
            windowsHide: true,
        });
        this.child = child;

        const spawned = new Promise<void>((resolve, reject) => {
            child.once("spawn", () => {
                resolve();
            });
            child.once("error", (error: Error) => {
                reject(new Error(`Agent "${this.name}" could not be started: ${error.message}`));
            });
        });

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            this.captureStderr(chunk);
        });
        child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
            this.exited = true;
            this.connection?.close();
            const tail = this.stderrTail.slice(-5).join("\n");
            this.sink.onAgentExit(
                this.name,
                `Agent process exited (code=${code ?? "-"}, signal=${signal ?? "-"})${tail ? `\n${tail}` : ""}`,
            );
        });

        await spawned;

        // @types/node types Readable.toWeb only as ReadableStream<any>. stdout without
        // setEncoding yields Buffer, i.e. Uint8Array, so the assertion is correct.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
        const stream = ndJsonStream(Writable.toWeb(child.stdin), input);
        this.connection = client({ name: PACKAGE_NAME })
            .onRequest(methods.client.session.requestPermission, (context) =>
                this.sink.onPermissionRequest(this.name, context.params),
            )
            .onNotification(methods.client.session.update, (context) => {
                this.sink.onSessionUpdate(this.name, context.params);
            })
            .onNotification(
                AUTH_STATUS_UPDATE_METHOD,
                (params: unknown): AuthStatusPayload =>
                    typeof params === "object" && params !== null ? (params as AuthStatusPayload) : {},
                (context) => {
                    const sanitized = sanitizeAuthStatus(context.params);
                    if (sanitized) {
                        this.reportedAuth = sanitized;
                        const listeners = this.authListeners;
                        this.authListeners = [];
                        listeners.forEach((listener) => {
                            listener();
                        });
                    }
                },
            )
            .connect(stream);

        this.initializeResponse = await this.connection.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {
                // Only so the agent lists its terminal login methods. The connector
                // never runs them itself; it only shows them as instructions.
                auth: { terminal: true },
            },
            clientInfo: { name: PACKAGE_NAME, version: PACKAGE_VERSION },
        });
        return this.initializeResponse;
    }

    /** Waits up to `timeoutMs` for the agent's first auth report. */
    async waitForReportedAuth(timeoutMs: number): Promise<AgentReportedAuth | undefined> {
        if (this.reportedAuth) {
            return this.reportedAuth;
        }
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, timeoutMs);
            this.authListeners.push(() => {
                clearTimeout(timer);
                resolve();
            });
        });
        return this.reportedAuth;
    }

    /**
     * Stops the agent: gently first (closing stdin), because a hard kill in
     * the middle of an OAuth refresh can leave an orphaned lock behind. If it
     * is still running after `STOP_GRACE_MS`, it is killed along with its
     * child processes.
     */
    async stop(): Promise<void> {
        const child = this.child;
        if (!child || this.exited) {
            return;
        }
        const exited = new Promise<void>((resolve) => {
            child.once("exit", () => {
                resolve();
            });
        });
        child.stdin.end();
        const timer = setTimeout(() => {
            killProcessTree(child);
        }, STOP_GRACE_MS);
        await exited;
        clearTimeout(timer);
        // Even if the adapter exited on its own: don't leave its children (e.g. the Claude binary) behind.
        killOrphanedDescendants(child);
    }

    /** Immediate, synchronous kill including child processes, e.g. from an `exit` handler. */
    kill(): void {
        if (this.child && !this.exited) {
            killProcessTree(this.child);
        }
    }

    private captureStderr(chunk: string): void {
        for (const line of chunk.split("\n")) {
            if (line.trim().length === 0) {
                continue;
            }
            this.stderrTail.push(line);
            if (this.debug) {
                process.stderr.write(`[${this.name}] ${line}\n`);
            }
        }
        if (this.stderrTail.length > STDERR_TAIL_LINES) {
            this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LINES);
        }
    }
}
