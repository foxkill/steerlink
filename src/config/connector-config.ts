import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { z } from "zod";

import { readEnv } from "./env.js";

const authModeSchema = z.enum(["api_key", "subscription"], {
    error: 'auth_mode muss "api_key" oder "subscription" sein',
});

/** Wie der Connector einen Claude-Agent anmeldet. */
export type AuthMode = z.infer<typeof authModeSchema>;

/**
 * Ein ACP-Agent, analog zu Zeds `agent_servers`-Eintrag (`type`, `command`,
 * `args`, `env`).
 */
const agentServerSchema = z.object({
    type: z.literal("custom", { error: 'nur "custom" wird unterstützt' }).default("custom"),
    command: z.string({ error: "fehlt" }).min(1, { error: "fehlt" }),
    args: z.array(z.string(), { error: "muss ein String-Array sein" }).default([]),
    env: z
        .record(z.string(), z.string({ error: "muss ein String sein" }), { error: "muss ein Objekt sein" })
        .default({}),
    /**
     * `claude`: der Agent ist der Claude-Code-Adapter. Dann setzt der Connector
     * die Auth-Regeln aus `auth_mode` durch (Env bereinigen, `--hide-claude-auth`).
     * `none`: Env und Args werden unverändert durchgereicht. Ohne Angabe gilt
     * `claude` für den Namen `claude`, sonst `none`.
     */
    auth_profile: z.enum(["claude", "none"], { error: 'muss "claude" oder "none" sein' }).optional(),
});

/** Inhalt der optionalen JSON-Datei aus `ACP_CONNECTOR_CONFIG`. */
const configFileSchema = z.object({
    default_agent: z.string().min(1).optional(),
    auth_mode: authModeSchema.optional(),
    agent_servers: z.record(z.string(), agentServerSchema).default({}),
});

export interface AgentServerConfig {
    type: "custom";
    command: string;
    args: string[];
    env: Record<string, string>;
    auth_profile: "claude" | "none";
}

export interface ConnectorConfig {
    default_agent: string;
    auth_mode: AuthMode;
    agent_servers: Record<string, AgentServerConfig>;
}

export const CONFIG_ENV_VAR = "ACP_CONNECTOR_CONFIG";
export const AUTH_MODE_ENV_VAR = "ACP_CONNECTOR_AUTH_MODE";
export const DEFAULT_AGENT_ENV_VAR = "ACP_CONNECTOR_DEFAULT_AGENT";

/** Pfad zur `claude-agent-acp`-Binary aus den eigenen node_modules. */
export function resolveClaudeAgentAcpBin(): string {
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve("@agentclientprotocol/claude-agent-acp/package.json");
    return join(dirname(packageJsonPath), "dist", "index.js");
}

export function builtinClaudeAgent(): AgentServerConfig {
    return {
        type: "custom",
        command: process.execPath,
        args: [resolveClaudeAgentAcpBin()],
        env: {},
        auth_profile: "claude",
    };
}

/** Fehlermeldung mit Pfad je Problem, z. B. `agent_servers.codex.command: fehlt`. */
function describeIssues(error: z.ZodError): string {
    return error.issues
        .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
        .join("; ");
}

function readConfigFile(path: string): z.infer<typeof configFileSchema> {
    let json: unknown;
    try {
        json = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${CONFIG_ENV_VAR}: ${path} ist nicht lesbar oder kein JSON (${reason})`, { cause: error });
    }
    const parsed = configFileSchema.safeParse(json);
    if (!parsed.success) {
        throw new Error(`${CONFIG_ENV_VAR}: ${path} ist ungültig: ${describeIssues(parsed.error)}`);
    }
    return parsed.data;
}

/**
 * Lädt die Konfiguration aus der JSON-Datei in `ACP_CONNECTOR_CONFIG`
 * (optional) und wendet die Env-Overrides an. Leere Werte und nicht ersetzte
 * Platzhalter (`${X}`) zählen dabei als nicht gesetzt. Ohne Datei gibt es genau den
 * eingebauten Agent `claude`. Default-Auth ist immer `api_key`.
 */
export function loadConnectorConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
    const configPath = readEnv(env, CONFIG_ENV_VAR);
    const file = configPath === undefined ? configFileSchema.parse({}) : readConfigFile(configPath);

    const agentServers: Record<string, AgentServerConfig> = { claude: builtinClaudeAgent() };
    for (const [name, server] of Object.entries(file.agent_servers)) {
        agentServers[name] = {
            ...server,
            auth_profile: server.auth_profile ?? (name === "claude" ? "claude" : "none"),
        };
    }

    const authModeOverride = readEnv(env, AUTH_MODE_ENV_VAR);
    let authMode: AuthMode = file.auth_mode ?? "api_key";
    if (authModeOverride !== undefined) {
        const parsed = authModeSchema.safeParse(authModeOverride);
        if (!parsed.success) {
            throw new Error(`${AUTH_MODE_ENV_VAR}: ${describeIssues(parsed.error)}`);
        }
        authMode = parsed.data;
    }

    const defaultAgent = readEnv(env, DEFAULT_AGENT_ENV_VAR) ?? file.default_agent ?? "claude";
    if (!(defaultAgent in agentServers)) {
        throw new Error(`default_agent "${defaultAgent}" ist nicht in agent_servers definiert`);
    }

    return { default_agent: defaultAgent, auth_mode: authMode, agent_servers: agentServers };
}
