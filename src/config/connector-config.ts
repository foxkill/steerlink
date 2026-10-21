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

const permissionPromptSchema = z.enum(["auto", "off", "required"], {
    error: 'permission_prompt must be "auto", "off" or "required"',
});

/**
 * Who answers the agent's permission requests:
 * - `auto` (default): the user in a dialog of the MCP host (elicitation) if the
 *   host supports it; the host's model may answer as well.
 * - `off`: never show a dialog; only the host answers via respond_permission.
 * - `required`: only the user's dialog may allow anything; the host's model can
 *   still deny. Sessions refuse to start if the host has no dialogs.
 */
export type PermissionPromptMode = z.infer<typeof permissionPromptSchema>;

const sessionViewSchema = z.enum(["auto", "on", "off"], {
    error: 'session_view must be "auto", "on" or "off"',
});

/**
 * When to offer the session view (MCP App, `show_session`):
 * - `auto` (default): only if the host declares MCP Apps support.
 * - `on`: always, for hosts that render MCP Apps without declaring it. Such a
 *   host may also show the view's tools to its model, so a click in the view
 *   counts as the host's answer, not the user's.
 * - `off`: never.
 */
export type SessionViewMode = z.infer<typeof sessionViewSchema>;

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
     * enforces the auth rules from `auth_mode` (which credentials reach the agent).
     * `none`: env and args are passed through unchanged. If omitted, `claude`
     * applies to the name `claude`, otherwise `none`.
     */
    auth_profile: z.enum(["claude", "none"], { error: 'must be "claude" or "none"' }).optional(),
});

/** Contents of the optional JSON file from `ACP_CONNECTOR_CONFIG`. */
const configFileSchema = z.object({
    default_agent: z.string().min(1).optional(),
    auth_mode: authModeSchema.optional(),
    permission_prompt: permissionPromptSchema.optional(),
    session_view: sessionViewSchema.optional(),
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
    permission_prompt: PermissionPromptMode;
    session_view: SessionViewMode;
    agent_servers: Record<string, AgentServerConfig>;
}

export const CONFIG_ENV_VAR = "ACP_CONNECTOR_CONFIG";
export const AUTH_MODE_ENV_VAR = "ACP_CONNECTOR_AUTH_MODE";
export const DEFAULT_AGENT_ENV_VAR = "ACP_CONNECTOR_DEFAULT_AGENT";
export const PERMISSION_PROMPT_ENV_VAR = "ACP_CONNECTOR_PERMISSION_PROMPT";
export const SESSION_VIEW_ENV_VAR = "ACP_CONNECTOR_SESSION_VIEW";

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

/** An env override for one of the enum settings; undefined if unset, an error if invalid. */
function readEnumEnv<T extends string>(
    env: NodeJS.ProcessEnv,
    name: string,
    schema: z.ZodEnum<{ [K in T]: K }>,
): T | undefined {
    const raw = readEnv(env, name);
    if (raw === undefined) {
        return undefined;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(`${name}: ${describeIssues(parsed.error)}`);
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

    const authMode = readEnumEnv(env, AUTH_MODE_ENV_VAR, authModeSchema) ?? file.auth_mode ?? "api_key";
    const permissionPrompt =
        readEnumEnv(env, PERMISSION_PROMPT_ENV_VAR, permissionPromptSchema) ?? file.permission_prompt ?? "auto";
    const sessionView = readEnumEnv(env, SESSION_VIEW_ENV_VAR, sessionViewSchema) ?? file.session_view ?? "auto";

    const defaultAgent = readEnv(env, DEFAULT_AGENT_ENV_VAR) ?? file.default_agent ?? "claude";
    if (!(defaultAgent in agentServers)) {
        throw new Error(`default_agent "${defaultAgent}" is not defined in agent_servers`);
    }

    return {
        default_agent: defaultAgent,
        auth_mode: authMode,
        permission_prompt: permissionPrompt,
        session_view: sessionView,
        agent_servers: agentServers,
    };
}
