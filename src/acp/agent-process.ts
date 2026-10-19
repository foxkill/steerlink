import { spawn, type ChildProcess } from "node:child_process";
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

/** Vom Agent gemeldete Identität, ohne E-Mail, Organisation oder sonstige Details. */
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

/** Methode, über die der Claude-Adapter seine Identität pusht (`_meta`-Erweiterung). */
export const AUTH_STATUS_UPDATE_METHOD = "_auth/status_update";

/** Nur bei diesen Arten ist `detail` sicher (z. B. "ANTHROPIC_API_KEY", Gateway-Host). */
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
const STOP_GRACE_MS = 5000;

/**
 * Ein laufender ACP-Agent-Prozess (z. B. claude-agent-acp) mit seiner
 * Client-seitigen ACP-Verbindung. Mehrere Sessions teilen sich einen Prozess.
 */
export class AgentProcess {
  readonly name: string;
  initializeResponse: InitializeResponse | undefined;
  reportedAuth: AgentReportedAuth | undefined;
  readonly stderrTail: string[] = [];
  private child: ChildProcess | undefined;
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
      throw new Error(`Agent "${this.name}" läuft nicht`);
    }
    return this.connection.agent;
  }

  async start(): Promise<InitializeResponse> {
    const child = spawn(this.launch.command, this.launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.launch.env,
    });
    this.child = child;

    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error: Error) => reject(new Error(`Agent "${this.name}" konnte nicht gestartet werden: ${error.message}`)));
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.captureStderr(chunk));
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.exited = true;
      this.connection?.close();
      const tail = this.stderrTail.slice(-5).join("\n");
      this.sink.onAgentExit(this.name, `Agent-Prozess beendet (code=${code ?? "-"}, signal=${signal ?? "-"})${tail ? `\n${tail}` : ""}`);
    });

    await spawned;
    if (!child.stdin || !child.stdout) {
      throw new Error(`Agent "${this.name}": stdio nicht verfügbar`);
    }

    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    this.connection = client({ name: PACKAGE_NAME })
      .onRequest(methods.client.session.requestPermission, (context) => this.sink.onPermissionRequest(this.name, context.params))
      .onNotification(methods.client.session.update, (context) => {
        this.sink.onSessionUpdate(this.name, context.params);
      })
      .onNotification(
        AUTH_STATUS_UPDATE_METHOD,
        (params: unknown): AuthStatusPayload => (typeof params === "object" && params !== null ? (params as AuthStatusPayload) : {}),
        (context) => {
          const sanitized = sanitizeAuthStatus(context.params);
          if (sanitized) {
            this.reportedAuth = sanitized;
            const listeners = this.authListeners;
            this.authListeners = [];
            listeners.forEach((listener) => listener());
          }
        },
      )
      .connect(stream);

    this.initializeResponse = await this.connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        // Nur damit der Agent seine Terminal-Login-Methoden auflistet. Der
        // Connector führt sie nie selbst aus, sondern zeigt sie als Anleitung an.
        auth: { terminal: true },
      },
      clientInfo: { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    });
    return this.initializeResponse;
  }

  /** Wartet bis zu `timeoutMs` auf die erste Auth-Meldung des Agents. */
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
   * Beendet den Agent sanft: stdin schließen und auf das Ende warten. Ein hartes
   * Kill mitten in einem OAuth-Refresh kann ein verwaistes Lock hinterlassen.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) {
      return;
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin?.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
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
