import type { AgentServerConfig, AuthMode } from "../config/connector-config.js";
import { isUnexpandedPlaceholder, readEnv } from "../config/env.js";

export interface AgentLaunch {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
}

/** Flag des Claude-Adapters, das jede Abrechnung über ein claude.ai-Abo verweigert. */
export const HIDE_CLAUDE_AUTH_FLAG = "--hide-claude-auth";

const API_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
const OAUTH_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";
/** Abo-Zugangsdaten, die im api_key-Modus nie beim Agent ankommen dürfen. */
const SUBSCRIPTION_CREDENTIAL_VARS = [
    OAUTH_TOKEN_VAR,
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_SCOPES",
] as const;

/**
 * Variablen, die eine umgebende Claude-Code-Sitzung selbst in ihre
 * Unterprozesse setzt (laut https://code.claude.com/docs/en/env-vars:
 * "set automatically" bzw. "set by Claude Code"), plus interne Marker ohne
 * Doku. Würden sie vererbt, hielte sich der gestartete Claude-Prozess für eine
 * verschachtelte Sitzung oder spräche mit dem Socket der fremden Sitzung.
 *
 * Bewusst eine feste Liste statt aller `CLAUDE_CODE_*`: Die meisten dieser
 * Variablen sind Einstellungen des Nutzers (z. B. CLAUDE_CODE_GIT_BASH_PATH,
 * ohne den Claude Code unter Windows kein Git Bash findet, oder
 * CLAUDE_CODE_USE_BEDROCK) und müssen beim Agent ankommen.
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
            `auth_mode=api_key, aber ANTHROPIC_API_KEY ist der nicht ersetzte Platzhalter ${raw.trim()}. ` +
            "Den eigenen Anthropic API Key in den Plugin-Einstellungen (Variable ANTHROPIC_API_KEY) eintragen."
        );
    }
    return (
        "auth_mode=api_key, aber ANTHROPIC_API_KEY ist nicht gesetzt. Key im env-Block der MCP-Konfiguration setzen " +
        "oder bewusst ACP_CONNECTOR_AUTH_MODE=subscription wählen."
    );
}

export class AuthConfigError extends Error {}

/**
 * Baut Kommando, Argumente und Umgebung für einen Agent-Prozess.
 *
 * Für `auth_profile: "claude"` gilt:
 * - `api_key` (Default): ANTHROPIC_API_KEY ist Pflicht, OAuth-Token und
 *   Refresh-Token werden entfernt und der Adapter läuft mit `--hide-claude-auth`, damit nie ein Abo
 *   bezahlt.
 * - `subscription`: API-Keys werden entfernt, damit der vorhandene
 *   Claude-Code-Login (bzw. ein geerbtes CLAUDE_CODE_OAUTH_TOKEN) greift. Der
 *   Connector liest, speichert oder loggt dieses Token nie.
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

    // Nicht ersetzte Plugin-Platzhalter wie `${X}` sind keine Werte und dürfen
    // den Agent nicht erreichen (er hielte sie sonst z. B. für einen API-Key).
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

/** Sichtbare, geheimnisfreie Beschreibung der Anmeldequellen. */
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
