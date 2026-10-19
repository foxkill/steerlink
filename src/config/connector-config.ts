import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { z } from "zod";

import { readEnv } from "./env.js";

const authModeSchema = z.enum(["api_key", "subscription"], {
    error: 'auth_mode must be "api_key" or "subscription"',
});

/** How the connector signs in a Claude agent. */
export type AuthMode = z.infer<typeof authModeSchema>;

/**
 * An ACP agent, analogous to Zed's `agent_servers` entry (`type`, `command`,
 * `args`, `env`).
 */
const agentServerSchema = z.object({
    type: z.literal("custom", { error: 'only "custom" is supported' }).default("custom"),
    command: z.string({ error: "missing" }).min(1, { error: "missing" }),
    args: z.array(z.string(), { error: "must be an array of strings" }).default([]),
    env: z.record(z.string(), z.string({ error: "must be a string" }), { error: "must be an object" }).default({}),
    /**
     * `claude`: the agent is the Claude Code adapter. The connector then
     * enforces the auth rules from `auth_mode` (cleaning the env, `--hide-claude-auth`).
     * `none`: env and args are passed through unchanged. If omitted, `claude`
     * applies to the name `claude`, otherwise `none`.
     */
    auth_profile: z.enum(["claude", "none"], { error: 'must be "claude" or "none"' }).optional(),
});

/** Contents of the optional JSON file from `ACP_CONNECTOR_CONFIG`. */
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

/** Path to the `claude-agent-acp` binary from our own node_modules. */
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

/** Error message with a path per issue, e.g. `agent_servers.codex.command: missing`. */
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
        throw new Error(`${CONFIG_ENV_VAR}: ${path} is not readable or not JSON (${reason})`, { cause: error });
    }
    const parsed = configFileSchema.safeParse(json);
    if (!parsed.success) {
        throw new Error(`${CONFIG_ENV_VAR}: ${path} is invalid: ${describeIssues(parsed.error)}`);
    }
    return parsed.data;
}

/**
 * Loads the configuration from the JSON file in `ACP_CONNECTOR_CONFIG`
 * (optional) and applies the env overrides. Empty values and unexpanded
 * placeholders (`${X}`) count as unset. Without a file there is exactly the
 * built-in agent `claude`. The default auth is always `api_key`.
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
        throw new Error(`default_agent "${defaultAgent}" is not defined in agent_servers`);
    }

    return { default_agent: defaultAgent, auth_mode: authMode, agent_servers: agentServers };
}
