import type { AgentServerConfig, AuthMode } from "../config/connector-config.js";
import { isUnexpandedPlaceholder, readEnv } from "../config/env.js";

export interface AgentLaunch {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
}

/** Claude adapter flag that refuses any billing through a claude.ai subscription. */
export const HIDE_CLAUDE_AUTH_FLAG = "--hide-claude-auth";

const API_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
const OAUTH_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";
/** Subscription credentials that must never reach the agent in api_key mode. */
const SUBSCRIPTION_CREDENTIAL_VARS = [
    OAUTH_TOKEN_VAR,
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_SCOPES",
] as const;

/**
 * Variables that an enclosing Claude Code session sets in its own
 * subprocesses (per https://code.claude.com/docs/en/env-vars: "set
 * automatically" or "set by Claude Code"), plus undocumented internal
 * markers. If they were inherited, the launched Claude process would think it
 * is a nested session or would talk to the other session's socket.
 *
 * Deliberately a fixed list instead of all `CLAUDE_CODE_*`: most of those
 * variables are user settings (e.g. CLAUDE_CODE_GIT_BASH_PATH, without which
 * Claude Code cannot find Git Bash on Windows, or CLAUDE_CODE_USE_BEDROCK)
 * and must reach the agent.
 */
export const PARENT_SESSION_VARS: ReadonlySet<string> = new Set([
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "CLAUDE_JOB_DIR",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_REMOTE",
    "CLAUDE_CODE_REMOTE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SESSION_ATTENDED",
]);

function isParentSessionVar(name: string): boolean {
    return PARENT_SESSION_VARS.has(name);
}

function hasValue(env: NodeJS.ProcessEnv, name: string): boolean {
    return readEnv(env, name) !== undefined;
}

function missingApiKeyMessage(env: NodeJS.ProcessEnv): string {
    const raw = env.ANTHROPIC_API_KEY;
    if (typeof raw === "string" && isUnexpandedPlaceholder(raw)) {
        return (
            `auth_mode=api_key, but ANTHROPIC_API_KEY is the unexpanded placeholder ${raw.trim()}. ` +
            "Enter your own Anthropic API key in the plugin settings (variable ANTHROPIC_API_KEY)."
        );
    }
    return (
        "auth_mode=api_key, but ANTHROPIC_API_KEY is not set. Set the key in the env block of the MCP configuration, " +
        "or deliberately choose ACP_CONNECTOR_AUTH_MODE=subscription."
    );
}

export class AuthConfigError extends Error {}

/**
 * Builds the command, arguments and environment for an agent process.
 *
 * For `auth_profile: "claude"`:
 * - `api_key` (default): ANTHROPIC_API_KEY is required, the OAuth token and
 *   refresh token are removed, and the adapter runs with `--hide-claude-auth`
 *   so that a subscription never pays.
 * - `subscription`: API keys are removed so that the existing Claude Code
 *   login (or an inherited CLAUDE_CODE_OAUTH_TOKEN) takes effect. The
 *   connector never reads, stores or logs this token.
 */
export function buildAgentLaunch(
    server: AgentServerConfig,
    authMode: AuthMode,
    baseEnv: NodeJS.ProcessEnv = process.env,
): AgentLaunch {
    const merged: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(baseEnv)) {
        if (!isParentSessionVar(name)) {
            merged[name] = value;
        }
    }
    Object.assign(merged, server.env);

    // Unexpanded plugin placeholders like `${X}` are not values and must not
    // reach the agent (it would otherwise take them for e.g. an API key).
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(merged)) {
        if (!(typeof value === "string" && isUnexpandedPlaceholder(value))) {
            env[name] = value;
        }
    }

    const args = [...server.args];
    if (server.auth_profile !== "claude") {
        return { command: server.command, args, env };
    }

    if (authMode === "api_key") {
        if (!hasValue(env, "ANTHROPIC_API_KEY")) {
            throw new AuthConfigError(missingApiKeyMessage(merged));
        }
        for (const name of SUBSCRIPTION_CREDENTIAL_VARS) {
            delete env[name];
        }
        if (!args.includes(HIDE_CLAUDE_AUTH_FLAG)) {
            args.push(HIDE_CLAUDE_AUTH_FLAG);
        }
    } else {
        for (const name of API_KEY_VARS) {
            delete env[name];
        }
        const flagIndex = args.indexOf(HIDE_CLAUDE_AUTH_FLAG);
        if (flagIndex >= 0) {
            args.splice(flagIndex, 1);
        }
    }
    return { command: server.command, args, env };
}

/** Visible, secret-free description of the credential sources. */
export interface CredentialPresence {
    anthropic_api_key_set: boolean;
    claude_code_oauth_token_set: boolean;
}

export function describeCredentials(
    server: AgentServerConfig,
    baseEnv: NodeJS.ProcessEnv = process.env,
): CredentialPresence {
    const merged: NodeJS.ProcessEnv = { ...baseEnv, ...server.env };
    return {
        anthropic_api_key_set: hasValue(merged, "ANTHROPIC_API_KEY"),
        claude_code_oauth_token_set: hasValue(merged, OAUTH_TOKEN_VAR),
    };
}
