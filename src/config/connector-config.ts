import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readEnv } from "./env.js";

/** Wie der Connector einen Claude-Agent anmeldet. */
export type AuthMode = "api_key" | "subscription";

/**
 * Ein ACP-Agent, analog zu Zeds `agent_servers`-Eintrag
 * (`type`, `command`, `args`, `env`).
 */
export interface AgentServerConfig {
  type: "custom";
  command: string;
  args: string[];
  env: Record<string, string>;
  /**
   * `claude`: der Agent ist der Claude-Code-Adapter. Dann setzt der Connector
   * die Auth-Regeln aus `auth_mode` durch (Env bereinigen, `--hide-claude-auth`).
   * `none`: Env und Args werden unverändert durchgereicht.
   */
  auth_profile: "claude" | "none";
}

export interface ConnectorConfig {
  default_agent: string;
  auth_mode: AuthMode;
  agent_servers: Record<string, AgentServerConfig>;
}

interface RawAgentServerConfig {
  type?: string;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  auth_profile?: unknown;
}

interface RawConnectorConfig {
  default_agent?: unknown;
  auth_mode?: unknown;
  agent_servers?: Record<string, RawAgentServerConfig>;
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

function parseAuthMode(value: unknown, source: string): AuthMode {
  if (value === "api_key" || value === "subscription") {
    return value;
  }
  throw new Error(`${source}: auth_mode muss "api_key" oder "subscription" sein`);
}

function parseStringRecord(value: unknown, source: string): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} muss ein Objekt sein`);
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") {
      throw new Error(`${source}.${key} muss ein String sein`);
    }
    result[key] = entry;
  }
  return result;
}

function parseAgentServer(name: string, raw: RawAgentServerConfig): AgentServerConfig {
  const source = `agent_servers.${name}`;
  if (raw.type !== undefined && raw.type !== "custom") {
    throw new Error(`${source}.type: nur "custom" wird unterstützt`);
  }
  if (typeof raw.command !== "string" || raw.command.length === 0) {
    throw new Error(`${source}.command fehlt`);
  }
  const args = raw.args ?? [];
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string")) {
    throw new Error(`${source}.args muss ein String-Array sein`);
  }
  const authProfile = raw.auth_profile ?? (name === "claude" ? "claude" : "none");
  if (authProfile !== "claude" && authProfile !== "none") {
    throw new Error(`${source}.auth_profile muss "claude" oder "none" sein`);
  }
  return {
    type: "custom",
    command: raw.command,
    args,
    env: parseStringRecord(raw.env, `${source}.env`),
    auth_profile: authProfile,
  };
}

/**
 * Lädt die Konfiguration aus der JSON-Datei in `ACP_CONNECTOR_CONFIG`
 * (optional) und wendet die Env-Overrides an. Leere Werte und nicht ersetzte
 * Platzhalter (`${X}`) zählen dabei als nicht gesetzt. Ohne Datei gibt es genau den
 * eingebauten Agent `claude`. Default-Auth ist immer `api_key`.
 */
export function loadConnectorConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  let raw: RawConnectorConfig = {};
  const configPath = readEnv(env, CONFIG_ENV_VAR);
  if (configPath) {
    raw = JSON.parse(readFileSync(configPath, "utf8")) as RawConnectorConfig;
  }

  const agentServers: Record<string, AgentServerConfig> = { claude: builtinClaudeAgent() };
  for (const [name, server] of Object.entries(raw.agent_servers ?? {})) {
    agentServers[name] = parseAgentServer(name, server);
  }

  const authModeOverride = readEnv(env, AUTH_MODE_ENV_VAR);
  const authMode = authModeOverride
    ? parseAuthMode(authModeOverride, AUTH_MODE_ENV_VAR)
    : raw.auth_mode !== undefined
      ? parseAuthMode(raw.auth_mode, "config")
      : "api_key";

  const defaultAgent = readEnv(env, DEFAULT_AGENT_ENV_VAR) ?? (typeof raw.default_agent === "string" ? raw.default_agent : "claude");
  if (!agentServers[defaultAgent]) {
    throw new Error(`default_agent "${defaultAgent}" ist nicht in agent_servers definiert`);
  }

  return { default_agent: defaultAgent, auth_mode: authMode, agent_servers: agentServers };
}
