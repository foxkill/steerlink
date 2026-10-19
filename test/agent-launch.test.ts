import { describe, expect, it } from "vitest";
import { AuthConfigError, buildAgentLaunch, describeCredentials, HIDE_CLAUDE_AUTH_FLAG } from "../src/auth/agent-launch.js";
import { sanitizeAuthStatus } from "../src/acp/agent-process.js";
import type { AgentServerConfig } from "../src/config/connector-config.js";

const claude: AgentServerConfig = { type: "custom", command: "node", args: ["claude-agent-acp.js"], env: {}, auth_profile: "claude" };
const other: AgentServerConfig = { type: "custom", command: "codex-acp", args: [], env: { X: "1" }, auth_profile: "none" };

describe("buildAgentLaunch", () => {
  const base = {
    PATH: "/bin",
    ANTHROPIC_API_KEY: "sk-test",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-test",
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "abc",
  };

  it("api_key: Key bleibt, OAuth-Token fliegt raus, Abo gesperrt", () => {
    const launch = buildAgentLaunch(claude, "api_key", base);
    expect(launch.env.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(launch.args).toContain(HIDE_CLAUDE_AUTH_FLAG);
  });

  it("api_key ohne Key ist ein Konfigurationsfehler", () => {
    expect(() => buildAgentLaunch(claude, "api_key", { PATH: "/bin" })).toThrow(AuthConfigError);
  });

  it("api_key aus dem env-Block der Agent-Konfiguration zählt", () => {
    const launch = buildAgentLaunch({ ...claude, env: { ANTHROPIC_API_KEY: "sk-config" } }, "api_key", { PATH: "/bin" });
    expect(launch.env.ANTHROPIC_API_KEY).toBe("sk-config");
  });

  it("subscription: API-Keys raus, OAuth-Token wird nur durchgereicht, kein Flag", () => {
    const launch = buildAgentLaunch({ ...claude, args: ["x.js", HIDE_CLAUDE_AUTH_FLAG] }, "subscription", base);
    expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-test");
    expect(launch.args).not.toContain(HIDE_CLAUDE_AUTH_FLAG);
  });

  it("Variablen einer umgebenden Claude-Code-Sitzung werden nicht vererbt", () => {
    const launch = buildAgentLaunch(claude, "api_key", base);
    expect(launch.env.CLAUDECODE).toBeUndefined();
    expect(launch.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(launch.env.PATH).toBe("/bin");
  });

  it("api_key: nicht ersetzter Plugin-Platzhalter zählt nicht als Key", () => {
    const env = { PATH: "/bin", ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" };
    expect(() => buildAgentLaunch(claude, "api_key", env)).toThrow(/nicht ersetzte Platzhalter \$\{ANTHROPIC_API_KEY\}/);
    expect(describeCredentials(claude, env).anthropic_api_key_set).toBe(false);
  });

  it("Platzhalter aus dem env-Block erreichen den Agent nie", () => {
    const launch = buildAgentLaunch({ ...other, env: { TOKEN: "${TOKEN}", KEEP: "x ${TOKEN}" } }, "api_key", { PATH: "/bin" });
    expect(launch.env).not.toHaveProperty("TOKEN");
    expect(launch.env.KEEP).toBe("x ${TOKEN}");
  });

  it("env-Block des Agents darf CLAUDE_CODE_*-Variablen bewusst setzen", () => {
    const launch = buildAgentLaunch({ ...claude, env: { CLAUDE_CODE_USE_BEDROCK: "1" } }, "api_key", { ANTHROPIC_API_KEY: "k", CLAUDE_CODE_X: "parent" });
    expect(launch.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(launch.env.CLAUDE_CODE_X).toBeUndefined();
  });

  it("andere Agents bekommen Env und Args unverändert", () => {
    const launch = buildAgentLaunch(other, "api_key", { PATH: "/bin", ANTHROPIC_API_KEY: "k" });
    expect(launch.args).toEqual([]);
    expect(launch.env.X).toBe("1");
    expect(launch.env.ANTHROPIC_API_KEY).toBe("k");
  });
});

describe("sanitizeAuthStatus", () => {
  it("entfernt E-Mail und Organisation", () => {
    const result = sanitizeAuthStatus({
      authStatus: { kind: "account", label: "Claude Max", detail: "a@b.c", account: { plan: "max" } },
    });
    expect(result).toEqual({ kind: "account", label: "Claude Max", plan: "max" });
  });

  it("behält unkritische Details beim API-Key", () => {
    expect(sanitizeAuthStatus({ authStatus: { kind: "api_key", label: "Anthropic API key", detail: "ANTHROPIC_API_KEY" } })).toEqual({
      kind: "api_key",
      label: "Anthropic API key",
      detail: "ANTHROPIC_API_KEY",
    });
  });
});
