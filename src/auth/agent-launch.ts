import type { AgentServerConfig, AuthMode } from "../config/connector-config.js";

export interface AgentLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Flag des Claude-Adapters, das jede Abrechnung über ein claude.ai-Abo verweigert. */
export const HIDE_CLAUDE_AUTH_FLAG = "--hide-claude-auth";

const API_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
const OAUTH_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * Variablen einer umgebenden Claude-Code-Sitzung. Würden sie vererbt, hielte
 * sich der gestartete Claude-Prozess für eine verschachtelte Sitzung.
 */
function isParentSessionVar(name: string): boolean {
  if (name === OAUTH_TOKEN_VAR) {
    return false;
  }
  return name === "CLAUDECODE" || name === "CLAUDE_PID" || name === "CLAUDE_EFFORT" || name.startsWith("CLAUDE_CODE_");
}

function hasValue(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.length > 0;
}

export class AuthConfigError extends Error {}

/**
 * Baut Kommando, Argumente und Umgebung für einen Agent-Prozess.
 *
 * Für `auth_profile: "claude"` gilt:
 * - `api_key` (Default): ANTHROPIC_API_KEY ist Pflicht, ein OAuth-Token wird
 *   entfernt und der Adapter läuft mit `--hide-claude-auth`, damit nie ein Abo
 *   bezahlt.
 * - `subscription`: API-Keys werden entfernt, damit der vorhandene
 *   Claude-Code-Login (bzw. ein geerbtes CLAUDE_CODE_OAUTH_TOKEN) greift. Der
 *   Connector liest, speichert oder loggt dieses Token nie.
 */
export function buildAgentLaunch(server: AgentServerConfig, authMode: AuthMode, baseEnv: NodeJS.ProcessEnv = process.env): AgentLaunch {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (!isParentSessionVar(name)) {
      env[name] = value;
    }
  }
  Object.assign(env, server.env);

  const args = [...server.args];
  if (server.auth_profile !== "claude") {
    return { command: server.command, args, env };
  }

  if (authMode === "api_key") {
    if (!hasValue(env, "ANTHROPIC_API_KEY")) {
      throw new AuthConfigError(
        "auth_mode=api_key, aber ANTHROPIC_API_KEY ist nicht gesetzt. Key im env-Block der MCP-Konfiguration setzen " +
          "oder bewusst ACP_CONNECTOR_AUTH_MODE=subscription wählen.",
      );
    }
    delete env[OAUTH_TOKEN_VAR];
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

export function describeCredentials(server: AgentServerConfig, baseEnv: NodeJS.ProcessEnv = process.env): CredentialPresence {
  const merged: NodeJS.ProcessEnv = { ...baseEnv, ...server.env };
  return {
    anthropic_api_key_set: hasValue(merged, "ANTHROPIC_API_KEY"),
    claude_code_oauth_token_set: hasValue(merged, OAUTH_TOKEN_VAR),
  };
}
