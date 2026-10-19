import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

import {
    methods,
    type AuthMethod,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionModeState,
    type SessionNotification,
    type StopReason,
} from "@agentclientprotocol/sdk";

import { AgentProcess, type AgentEventSink, type AgentReportedAuth } from "../acp/agent-process.js";
import { buildAgentLaunch, describeCredentials, type CredentialPresence } from "../auth/agent-launch.js";
import type { AgentServerConfig, ConnectorConfig } from "../config/connector-config.js";
import {
    stringifyInput,
    summarizeDiffs,
    summarizeLocations,
    summarizeOptions,
    summarizeTextContent,
    truncate,
    type PendingPermissionSummary,
    type SessionEvent,
    type ToolCallSummary,
} from "./session-events.js";

export type SessionStatus = "idle" | "running" | "awaiting_permission" | "closed";
export type PermissionDecision = "allow" | "allow_always" | "deny" | "deny_always";

interface PendingPermission {
    summary: PendingPermissionSummary;
    options: RequestPermissionRequest["options"];
    resolve: (response: RequestPermissionResponse) => void;
}

interface Turn {
    number: number;
    text: string;
    toolCallIds: string[];
    stopReason?: StopReason;
    error?: string;
    finished: boolean;
}

interface SessionState {
    id: string;
    agentName: string;
    cwd: string;
    modes: SessionModeState | null;
    events: SessionEvent[];
    cursor: number;
    toolCalls: Map<string, ToolCallSummary>;
    pendingPermissions: Map<string, PendingPermission>;
    turn: Turn | undefined;
    turnCount: number;
    closedReason?: string;
    waiters: Array<() => void>;
}

export interface TurnResult {
    session_id: string;
    status: SessionStatus;
    turn: number | null;
    stop_reason: string | null;
    error: string | null;
    response_text: string;
    tool_calls: ToolCallSummary[];
    pending_permissions: PendingPermissionSummary[];
    hint: string;
}

export interface UpdatesResult {
    session_id: string;
    status: SessionStatus;
    events: SessionEvent[];
    pending_permissions: PendingPermissionSummary[];
    last_turn: TurnResult | null;
}

export interface AgentInfo {
    name: string;
    default: boolean;
    command: string;
    args: string[];
    env_keys: string[];
    auth_profile: string;
    running: boolean;
    agent_info: { name: string; title?: string | null | undefined; version: string } | null;
    auth_methods: Array<{ id: string; name: string; type: string }>;
}

export interface AuthStatusResult {
    agent: string;
    auth_mode: string;
    auth_profile: string;
    credentials: CredentialPresence;
    effective_method: string;
    hide_claude_auth: boolean;
    agent_reported: AgentReportedAuth | null;
    auth_methods: Array<{ id: string; name: string; type: string }>;
    problem: string | null;
}

const MAX_EVENTS = 2000;

type TerminalAuthMethod = Extract<AuthMethod, { type: "terminal" }>;

/**
 * Laut Schema tragen nur Terminal-Methoden ein `type`. Auf dem Draht kann ein
 * Agent aber auch andere Werte schicken; deshalb zählt allein `"terminal"`.
 */
function isTerminalMethod(method: AuthMethod): method is TerminalAuthMethod {
    return Reflect.get(method, "type") === "terminal";
}

function describeAuthMethod(method: AuthMethod): { id: string; name: string; type: string } {
    return { id: method.id, name: method.name, type: isTerminalMethod(method) ? "terminal" : "agent" };
}

export class SessionManager implements AgentEventSink {
    private readonly agents = new Map<string, AgentProcess>();
    private readonly starting = new Map<string, Promise<AgentProcess>>();
    private readonly sessions = new Map<string, SessionState>();
    private permissionCounter = 0;
    private seqCounter = 0;

    constructor(
        private readonly config: ConnectorConfig,
        private readonly debug: boolean = false,
    ) {}

    // ---------------------------------------------------------------- Agents

    listAgents(): AgentInfo[] {
        return Object.entries(this.config.agent_servers).map(([name, server]) => {
            const process = this.agents.get(name);
            const init = process?.running ? process.initializeResponse : undefined;
            return {
                name,
                default: name === this.config.default_agent,
                command: server.command,
                args: server.args,
                env_keys: Object.keys(server.env),
                auth_profile: server.auth_profile,
                running: process?.running ?? false,
                agent_info: init?.agentInfo
                    ? { name: init.agentInfo.name, title: init.agentInfo.title, version: init.agentInfo.version }
                    : null,
                auth_methods: (init?.authMethods ?? []).map((method) => describeAuthMethod(method)),
            };
        });
    }

    private resolveAgent(agent: string | undefined): { name: string; server: AgentServerConfig } {
        const name = agent ?? this.config.default_agent;
        const server = this.config.agent_servers[name];
        if (!server) {
            throw new Error(
                `Unbekannter Agent "${name}". Verfügbar: ${Object.keys(this.config.agent_servers).join(", ")}`,
            );
        }
        return { name, server };
    }

    private resolveAgentName(agent: string | undefined): string {
        return this.resolveAgent(agent).name;
    }

    private async ensureAgent(name: string): Promise<AgentProcess> {
        const existing = this.agents.get(name);
        if (existing?.running) {
            return existing;
        }
        const pending = this.starting.get(name);
        if (pending) {
            return pending;
        }
        const startPromise = (async (): Promise<AgentProcess> => {
            const { server } = this.resolveAgent(name);
            const launch = buildAgentLaunch(server, this.config.auth_mode);
            const agentProcess = new AgentProcess(name, launch, this, this.debug);
            try {
                await agentProcess.start();
            } catch (error) {
                await agentProcess.stop();
                const tail = agentProcess.stderrTail.slice(-5).join("\n");
                throw new Error(`${error instanceof Error ? error.message : String(error)}${tail ? `\n${tail}` : ""}`, {
                    cause: error,
                });
            }
            this.agents.set(name, agentProcess);
            return agentProcess;
        })();
        this.starting.set(name, startPromise);
        try {
            return await startPromise;
        } finally {
            this.starting.delete(name);
        }
    }

    private async restartAgent(name: string): Promise<void> {
        const agentProcess = this.agents.get(name);
        if (!agentProcess) {
            return;
        }
        const openSessions = [...this.sessions.values()].filter(
            (session) => session.agentName === name && !session.closedReason,
        );
        if (openSessions.length > 0) {
            throw new Error(
                `Agent "${name}" hat noch ${openSessions.length} offene Session(s). Erst close_session aufrufen.`,
            );
        }
        this.agents.delete(name);
        await agentProcess.stop();
    }

    // -------------------------------------------------------------- Sessions

    async startSession(params: { cwd: string; agent?: string | undefined; mode?: string | undefined }): Promise<{
        session_id: string;
        agent: string;
        cwd: string;
        current_mode: string | null;
        available_modes: Array<{ id: string; name: string }>;
    }> {
        if (!isAbsolute(params.cwd)) {
            throw new Error("cwd muss ein absoluter Pfad sein");
        }
        if (!statSync(params.cwd, { throwIfNoEntry: false })?.isDirectory()) {
            throw new Error(`cwd "${params.cwd}" ist kein existierendes Verzeichnis`);
        }
        const agentName = this.resolveAgentName(params.agent);
        const agentProcess = await this.ensureAgent(agentName);
        const response = await agentProcess.agent.request(methods.agent.session.new, {
            cwd: params.cwd,
            mcpServers: [],
        });

        const session: SessionState = {
            id: response.sessionId,
            agentName,
            cwd: params.cwd,
            modes: response.modes ?? null,
            events: [],
            cursor: 0,
            toolCalls: new Map(),
            pendingPermissions: new Map(),
            turn: undefined,
            turnCount: 0,
            waiters: [],
        };
        this.sessions.set(session.id, session);

        if (params.mode && session.modes && session.modes.currentModeId !== params.mode) {
            await this.setMode(session.id, params.mode);
        }

        return {
            session_id: session.id,
            agent: agentName,
            cwd: params.cwd,
            current_mode: session.modes?.currentModeId ?? null,
            available_modes: (session.modes?.availableModes ?? []).map((mode) => ({ id: mode.id, name: mode.name })),
        };
    }

    private getSession(sessionId: string): SessionState {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Unbekannte Session "${sessionId}"`);
        }
        return session;
    }

    private getOpenSession(sessionId: string): SessionState {
        const session = this.getSession(sessionId);
        if (session.closedReason) {
            throw new Error(`Session "${sessionId}" ist geschlossen: ${session.closedReason}`);
        }
        return session;
    }

    async setMode(sessionId: string, modeId: string): Promise<{ session_id: string; current_mode: string }> {
        const session = this.getOpenSession(sessionId);
        const available = session.modes?.availableModes ?? [];
        if (!available.some((mode) => mode.id === modeId)) {
            throw new Error(
                `Modus "${modeId}" nicht verfügbar. Verfügbar: ${available.map((mode) => mode.id).join(", ") || "keine"}`,
            );
        }
        const agentProcess = await this.ensureAgent(session.agentName);
        await agentProcess.agent.request(methods.agent.session.setMode, { sessionId, modeId });
        if (session.modes) {
            session.modes.currentModeId = modeId;
        }
        return { session_id: sessionId, current_mode: modeId };
    }

    private status(session: SessionState): SessionStatus {
        if (session.closedReason) {
            return "closed";
        }
        if (session.turn && !session.turn.finished) {
            return session.pendingPermissions.size > 0 ? "awaiting_permission" : "running";
        }
        return "idle";
    }

    async sendPrompt(params: {
        session_id: string;
        text: string;
        wait: boolean;
        timeout_seconds: number;
    }): Promise<TurnResult> {
        const session = this.getOpenSession(params.session_id);
        if (session.turn && !session.turn.finished) {
            throw new Error(
                "In dieser Session läuft bereits ein Prompt. Mit get_session_updates warten oder cancel aufrufen.",
            );
        }
        const agentProcess = await this.ensureAgent(session.agentName);
        session.turnCount += 1;
        const turn: Turn = { number: session.turnCount, text: "", toolCallIds: [], finished: false };
        session.turn = turn;

        // Läuft bewusst im Hintergrund weiter; Ergebnis und Fehler landen im Ereignis-Puffer.
        void this.runTurn(agentProcess, session, turn, params.text);

        if (params.wait) {
            await this.waitFor(session, () => this.status(session) !== "running", params.timeout_seconds * 1000);
            // Was der Aufrufer hier bekommt, gilt als gelesen.
            session.cursor = this.seqCounter;
        }
        return this.turnResult(session);
    }

    private async runTurn(agentProcess: AgentProcess, session: SessionState, turn: Turn, text: string): Promise<void> {
        try {
            const response = await agentProcess.agent.request(methods.agent.session.prompt, {
                sessionId: session.id,
                prompt: [{ type: "text", text }],
            });
            // Erst abschließen, dann melden: wer turn_end sieht, sieht auch status=idle.
            turn.stopReason = response.stopReason;
            turn.finished = true;
            this.pushEvent(session, { seq: 0, type: "turn_end", stop_reason: response.stopReason });
        } catch (error) {
            turn.error = error instanceof Error ? error.message : JSON.stringify(error);
            turn.finished = true;
            this.pushEvent(session, { seq: 0, type: "error", message: turn.error });
        }
    }

    async getUpdates(params: {
        session_id: string;
        wait_seconds: number;
        include_thoughts: boolean;
    }): Promise<UpdatesResult> {
        const session = this.getSession(params.session_id);
        const hasNew = (): boolean => session.events.some((event) => event.seq > session.cursor);
        if (!hasNew() && params.wait_seconds > 0 && this.status(session) !== "closed") {
            await this.waitFor(session, hasNew, params.wait_seconds * 1000);
        }
        const events = session.events.filter(
            (event) => event.seq > session.cursor && (params.include_thoughts || event.type !== "thought"),
        );
        session.cursor = this.seqCounter;
        return {
            session_id: session.id,
            status: this.status(session),
            events,
            pending_permissions: [...session.pendingPermissions.values()].map((pending) => pending.summary),
            last_turn: session.turn ? this.turnResult(session) : null,
        };
    }

    listPendingPermissions(sessionId?: string): PendingPermissionSummary[] {
        const sessions = sessionId ? [this.getSession(sessionId)] : [...this.sessions.values()];
        return sessions.flatMap((session) =>
            [...session.pendingPermissions.values()].map((pending) => pending.summary),
        );
    }

    respondPermission(params: {
        permission_id: string;
        decision?: PermissionDecision | undefined;
        option_id?: string | undefined;
    }): {
        permission_id: string;
        selected_option: { option_id: string; name: string; kind: string };
        session_status: SessionStatus;
    } {
        for (const session of this.sessions.values()) {
            const pending = session.pendingPermissions.get(params.permission_id);
            if (!pending) {
                continue;
            }
            const option = params.option_id
                ? pending.options.find((candidate) => candidate.optionId === params.option_id)
                : this.optionForDecision(pending.options, params.decision ?? "deny");
            if (!option) {
                throw new Error(
                    `Keine passende Option. Verfügbar: ${pending.options.map((candidate) => `${candidate.optionId} (${candidate.kind})`).join(", ")}`,
                );
            }
            session.pendingPermissions.delete(params.permission_id);
            pending.resolve({ outcome: { outcome: "selected", optionId: option.optionId } });
            this.pushEvent(session, {
                seq: 0,
                type: "permission_resolved",
                permission_id: params.permission_id,
                outcome: option.kind,
            });
            return {
                permission_id: params.permission_id,
                selected_option: { option_id: option.optionId, name: option.name, kind: option.kind },
                session_status: this.status(session),
            };
        }
        throw new Error(`Unbekannte oder bereits beantwortete Permission "${params.permission_id}"`);
    }

    private optionForDecision(
        options: RequestPermissionRequest["options"],
        decision: PermissionDecision,
    ): RequestPermissionRequest["options"][number] | undefined {
        const preference: Record<PermissionDecision, string[]> = {
            allow: ["allow_once", "allow_always"],
            allow_always: ["allow_always"],
            deny: ["reject_once", "reject_always"],
            deny_always: ["reject_always"],
        };
        for (const kind of preference[decision]) {
            const option = options.find((candidate) => candidate.kind === kind);
            if (option) {
                return option;
            }
        }
        return undefined;
    }

    async cancel(sessionId: string): Promise<TurnResult> {
        const session = this.getOpenSession(sessionId);
        this.cancelPendingPermissions(session);
        if (session.turn && !session.turn.finished) {
            const agentProcess = await this.ensureAgent(session.agentName);
            await agentProcess.agent.notify(methods.agent.session.cancel, { sessionId });
            await this.waitFor(session, () => session.turn?.finished ?? true, 15000);
        }
        return this.turnResult(session);
    }

    async closeSession(sessionId: string): Promise<{ session_id: string; closed: boolean }> {
        const session = this.getSession(sessionId);
        if (!session.closedReason) {
            if (session.turn && !session.turn.finished) {
                await this.cancel(sessionId);
            }
            const agentProcess = this.agents.get(session.agentName);
            if (
                agentProcess?.running &&
                agentProcess.initializeResponse?.agentCapabilities?.sessionCapabilities?.close
            ) {
                await agentProcess.agent.request(methods.agent.session.close, { sessionId });
            }
            session.closedReason = "vom Client geschlossen";
            this.notify(session);
        }
        this.sessions.delete(sessionId);
        return { session_id: sessionId, closed: true };
    }

    listSessions(): Array<{
        session_id: string;
        agent: string;
        cwd: string;
        status: SessionStatus;
        current_mode: string | null;
        turns: number;
    }> {
        return [...this.sessions.values()].map((session) => ({
            session_id: session.id,
            agent: session.agentName,
            cwd: session.cwd,
            status: this.status(session),
            current_mode: session.modes?.currentModeId ?? null,
            turns: session.turnCount,
        }));
    }

    // ------------------------------------------------------------------ Auth

    async authStatus(params: {
        agent?: string | undefined;
        probe: boolean;
        restart_agent: boolean;
    }): Promise<AuthStatusResult> {
        const { name, server } = this.resolveAgent(params.agent);
        const credentials = describeCredentials(server);
        const isClaude = server.auth_profile === "claude";
        let problem: string | null = null;

        if (params.restart_agent) {
            await this.restartAgent(name);
        }
        let agentProcess = this.agents.get(name);
        if (params.probe && !agentProcess?.running) {
            try {
                agentProcess = await this.ensureAgent(name);
            } catch (error) {
                problem = error instanceof Error ? error.message : String(error);
            }
        }
        const reported = agentProcess?.running
            ? await agentProcess.waitForReportedAuth(params.probe ? 8000 : 0)
            : undefined;

        let effective: string;
        if (!isClaude) {
            effective = "vom Agent selbst verwaltet (auth_profile=none)";
        } else if (this.config.auth_mode === "api_key") {
            effective = credentials.anthropic_api_key_set
                ? "Anthropic API key aus ANTHROPIC_API_KEY; claude.ai-Abo per --hide-claude-auth gesperrt"
                : "keine: auth_mode=api_key, aber ANTHROPIC_API_KEY fehlt";
        } else {
            effective = credentials.claude_code_oauth_token_set
                ? "Claude-Abo über CLAUDE_CODE_OAUTH_TOKEN aus der Umgebung (durchgereicht, nicht gespeichert)"
                : "Claude-Abo über den vorhandenen Claude-Code-Login (claude /login)";
        }

        return {
            agent: name,
            auth_mode: isClaude ? this.config.auth_mode : "n/a",
            auth_profile: server.auth_profile,
            credentials,
            effective_method: effective,
            hide_claude_auth: isClaude && this.config.auth_mode === "api_key",
            agent_reported: reported ?? null,
            auth_methods: (agentProcess?.initializeResponse?.authMethods ?? []).map((method) =>
                describeAuthMethod(method),
            ),
            problem,
        };
    }

    async authenticate(params: {
        agent?: string | undefined;
        method_id: string;
    }): Promise<{ agent: string; method_id: string; result: string; command?: string }> {
        const { name, server } = this.resolveAgent(params.agent);
        const agentProcess = await this.ensureAgent(name);
        const method = (agentProcess.initializeResponse?.authMethods ?? []).find(
            (candidate) => candidate.id === params.method_id,
        );
        if (!method) {
            const available = (agentProcess.initializeResponse?.authMethods ?? []).map((candidate) => candidate.id);
            throw new Error(
                `Auth-Methode "${params.method_id}" wird nicht angeboten. Verfügbar: ${available.join(", ") || "keine"}`,
            );
        }
        if (isTerminalMethod(method)) {
            // Laut ACP darf der Client für Terminal-Methoden kein `authenticate`
            // senden, sondern muss den Agent interaktiv starten. Das kann ein
            // MCP-Server nicht; deshalb gibt der Connector nur die Anleitung aus.
            const command = [server.command, ...server.args, ...(method.args ?? [])]
                .map((part) => (/\s/.test(part) ? `"${part}"` : part))
                .join(" ");
            return {
                agent: name,
                method_id: params.method_id,
                result:
                    "Interaktiver Login nötig. Den Befehl selbst in einem Terminal ausführen und danach auth_status mit restart_agent=true aufrufen. " +
                    "Der Connector sieht und speichert dabei keine Zugangsdaten.",
                command,
            };
        }
        await agentProcess.agent.request(methods.agent.authenticate, { methodId: params.method_id });
        return { agent: name, method_id: params.method_id, result: "authenticate erfolgreich" };
    }

    // -------------------------------------------------------- AgentEventSink

    onSessionUpdate(agentName: string, notification: SessionNotification): void {
        const session = this.sessions.get(notification.sessionId);
        if (!session || session.agentName !== agentName) {
            return;
        }
        const update = notification.update;
        switch (update.sessionUpdate) {
            case "agent_message_chunk":
                if (update.content.type === "text") {
                    if (session.turn && !session.turn.finished) {
                        session.turn.text += update.content.text;
                    }
                    this.appendText(session, "message", update.content.text);
                }
                break;
            case "agent_thought_chunk":
                if (update.content.type === "text") {
                    this.appendText(session, "thought", update.content.text);
                }
                break;
            case "tool_call": {
                const summary: ToolCallSummary = {
                    tool_call_id: update.toolCallId,
                    title: update.title,
                    kind: update.kind ?? "other",
                    status: update.status ?? "pending",
                    locations: summarizeLocations(update.locations),
                    diffs: summarizeDiffs(update.content),
                    output: summarizeTextContent(update.content),
                };
                session.toolCalls.set(update.toolCallId, summary);
                if (session.turn && !session.turn.toolCallIds.includes(update.toolCallId)) {
                    session.turn.toolCallIds.push(update.toolCallId);
                }
                this.upsertToolCallEvent(session, summary);
                break;
            }
            case "tool_call_update": {
                const summary = session.toolCalls.get(update.toolCallId) ?? {
                    tool_call_id: update.toolCallId,
                    title: update.title ?? "Tool",
                    kind: update.kind ?? "other",
                    status: "pending",
                    locations: [],
                    diffs: [],
                };
                if (update.title) summary.title = update.title;
                if (update.kind) summary.kind = update.kind;
                if (update.status) summary.status = update.status;
                if (update.locations) summary.locations = summarizeLocations(update.locations);
                if (update.content) {
                    const diffs = summarizeDiffs(update.content);
                    if (diffs.length > 0) summary.diffs = diffs;
                    const output = summarizeTextContent(update.content);
                    if (output) summary.output = output;
                }
                session.toolCalls.set(update.toolCallId, summary);
                if (session.turn && !session.turn.toolCallIds.includes(update.toolCallId)) {
                    session.turn.toolCallIds.push(update.toolCallId);
                }
                this.upsertToolCallEvent(session, summary);
                break;
            }
            case "plan":
                this.pushEvent(session, {
                    seq: 0,
                    type: "plan",
                    entries: update.entries.map((entry) => ({
                        content: entry.content,
                        status: entry.status,
                        priority: entry.priority,
                    })),
                });
                break;
            case "current_mode_update":
                if (session.modes) {
                    session.modes.currentModeId = update.currentModeId;
                }
                this.pushEvent(session, { seq: 0, type: "mode", mode_id: update.currentModeId });
                break;
            case "user_message_chunk":
            case "available_commands_update":
            case "config_option_update":
            case "session_info_update":
            case "usage_update":
            case "notice":
            case "plan_update":
            case "plan_removed":
            case "compaction_update":
            case "compaction_summary_chunk":
            case "subagent_update":
            case "session_message":
            case "session_message_chunk":
                // Für den MCP-Host Rauschen: Eingabe-Echo, Befehlslisten, Nutzungszahlen,
                // Metadaten und Varianten, die der Connector (noch) nicht zusammenfasst.
                break;
            default: {
                // Kommt mit einer neuen SDK-Version ein Update-Typ hinzu, schlägt das hier
                // beim Kompilieren fehl und erinnert daran, ihn bewusst einzuordnen. Zur
                // Laufzeit werden unbekannte Typen eines neueren Agents ignoriert.
                const unhandled: never = update;
                void unhandled;
                break;
            }
        }
    }

    onPermissionRequest(agentName: string, request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        const session = this.sessions.get(request.sessionId);
        if (!session || session.agentName !== agentName || session.closedReason) {
            return Promise.resolve({ outcome: { outcome: "cancelled" } });
        }
        this.permissionCounter += 1;
        const permissionId = `perm-${this.permissionCounter}`;
        const known = session.toolCalls.get(request.toolCall.toolCallId);
        const summary: PendingPermissionSummary = {
            permission_id: permissionId,
            session_id: session.id,
            tool_call_id: request.toolCall.toolCallId,
            title: request.toolCall.title ?? known?.title ?? "Tool",
            kind: request.toolCall.kind ?? known?.kind ?? "other",
            input: stringifyInput(request.toolCall.rawInput),
            diffs: request.toolCall.content ? summarizeDiffs(request.toolCall.content) : (known?.diffs ?? []),
            options: summarizeOptions(request.options),
        };
        return new Promise<RequestPermissionResponse>((resolve) => {
            session.pendingPermissions.set(permissionId, { summary, options: request.options, resolve });
            this.pushEvent(session, { seq: 0, type: "permission_request", permission: summary });
        });
    }

    onAgentExit(agentName: string, reason: string): void {
        if (this.agents.get(agentName)?.running === false) {
            this.agents.delete(agentName);
        }
        for (const session of this.sessions.values()) {
            if (session.agentName !== agentName || session.closedReason) {
                continue;
            }
            this.cancelPendingPermissions(session);
            session.closedReason = reason;
            if (session.turn && !session.turn.finished) {
                session.turn.finished = true;
                session.turn.error = reason;
            }
            this.pushEvent(session, { seq: 0, type: "error", message: reason });
        }
    }

    async shutdown(): Promise<void> {
        const processes = [...this.agents.values()];
        this.agents.clear();
        for (const session of this.sessions.values()) {
            this.cancelPendingPermissions(session);
        }
        await Promise.all(processes.map((agentProcess) => agentProcess.stop()));
    }

    /** Synchrones Notende aller Agents samt Kindprozessen (für `process.on("exit")`). */
    killAll(): void {
        for (const agentProcess of this.agents.values()) {
            agentProcess.kill();
        }
    }

    // --------------------------------------------------------------- Helpers

    private cancelPendingPermissions(session: SessionState): void {
        for (const [permissionId, pending] of session.pendingPermissions) {
            pending.resolve({ outcome: { outcome: "cancelled" } });
            this.pushEvent(session, {
                seq: 0,
                type: "permission_resolved",
                permission_id: permissionId,
                outcome: "cancelled",
            });
        }
        session.pendingPermissions.clear();
    }

    private turnResult(session: SessionState): TurnResult {
        const status = this.status(session);
        const turn = session.turn;
        const pending = [...session.pendingPermissions.values()].map((entry) => entry.summary);
        const hints: Record<SessionStatus, string> = {
            idle: "Turn beendet. Nächsten Prompt mit send_prompt senden.",
            running: "Agent arbeitet noch. Mit get_session_updates (wait_seconds) weiter abfragen.",
            awaiting_permission:
                "Agent wartet auf Freigabe. respond_permission mit permission_id und decision allow/deny aufrufen.",
            closed: "Session ist geschlossen.",
        };
        return {
            session_id: session.id,
            status,
            turn: turn?.number ?? null,
            stop_reason: turn?.stopReason ?? null,
            error: turn?.error ?? null,
            response_text: truncate(turn?.text ?? "", 12000).text,
            tool_calls: (turn?.toolCallIds ?? [])
                .map((id) => session.toolCalls.get(id))
                .filter((call): call is ToolCallSummary => call !== undefined),
            pending_permissions: pending,
            hint: hints[status],
        };
    }

    private appendText(session: SessionState, type: "message" | "thought", text: string): void {
        const last = session.events.at(-1);
        if (last?.type === type && last.seq > session.cursor) {
            last.text += text;
            this.notify(session);
            return;
        }
        this.pushEvent(session, { seq: 0, type, text });
    }

    private upsertToolCallEvent(session: SessionState, summary: ToolCallSummary): void {
        const snapshot: ToolCallSummary = { ...summary, locations: [...summary.locations], diffs: [...summary.diffs] };
        const last = session.events.at(-1);
        if (
            last?.type === "tool_call" &&
            last.tool_call.tool_call_id === summary.tool_call_id &&
            last.seq > session.cursor
        ) {
            last.tool_call = snapshot;
            this.notify(session);
            return;
        }
        this.pushEvent(session, { seq: 0, type: "tool_call", tool_call: snapshot });
    }

    private pushEvent(session: SessionState, event: SessionEvent): void {
        this.seqCounter += 1;
        event.seq = this.seqCounter;
        session.events.push(event);
        if (session.events.length > MAX_EVENTS) {
            session.events.splice(0, session.events.length - MAX_EVENTS);
        }
        this.notify(session);
    }

    private notify(session: SessionState): void {
        const waiters = session.waiters;
        session.waiters = [];
        waiters.forEach((waiter) => {
            waiter();
        });
    }

    private async waitFor(session: SessionState, condition: () => boolean, timeoutMs: number): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!condition() && Date.now() < deadline) {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, deadline - Date.now());
                session.waiters.push(() => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        }
    }
}
