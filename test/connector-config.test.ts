import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConnectorConfig } from "../src/config/connector-config.js";
import { isUnexpandedPlaceholder, readEnv } from "../src/config/env.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/package-info.js";
import packageJson from "../package.json" with { type: "json" };

describe("readEnv / isUnexpandedPlaceholder", () => {
  it.each(["${X}", "${ANTHROPIC_API_KEY}", " ${_a1} "])("%s ist ein Platzhalter", (value) => {
    expect(isUnexpandedPlaceholder(value)).toBe(true);
  });

  it.each(["", "x", "$X", "${}", "${1X}", "prefix ${X}", "${X}${Y}", "sk-ant-${X}"])("%j ist kein Platzhalter", (value) => {
    expect(isUnexpandedPlaceholder(value)).toBe(false);
  });

  it("leer und Platzhalter gelten als nicht gesetzt", () => {
    expect(readEnv({ A: "", B: "${B}", C: "wert" }, "A")).toBeUndefined();
    expect(readEnv({ A: "", B: "${B}", C: "wert" }, "B")).toBeUndefined();
    expect(readEnv({ A: "", B: "${B}", C: "wert" }, "C")).toBe("wert");
    expect(readEnv({}, "D")).toBeUndefined();
  });
});

describe("loadConnectorConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-config-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("Default: nur claude, api_key", () => {
    const config = loadConnectorConfig({});
    expect(Object.keys(config.agent_servers)).toEqual(["claude"]);
    expect(config.default_agent).toBe("claude");
    expect(config.auth_mode).toBe("api_key");
  });

  it("nicht ersetzte Platzhalter in ACP_CONNECTOR_* werden ignoriert", () => {
    const config = loadConnectorConfig({
      ACP_CONNECTOR_AUTH_MODE: "${ACP_CONNECTOR_AUTH_MODE}",
      ACP_CONNECTOR_DEFAULT_AGENT: "${AGENT}",
      ACP_CONNECTOR_CONFIG: "${CONFIG}",
    });
    expect(config.auth_mode).toBe("api_key");
    expect(config.default_agent).toBe("claude");
  });

  it("Env-Override schlägt Datei, ungültiger Modus ist ein Fehler", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ auth_mode: "subscription", agent_servers: { codex: { command: "codex-acp" } } }));
    expect(loadConnectorConfig({ ACP_CONNECTOR_CONFIG: path }).auth_mode).toBe("subscription");
    expect(loadConnectorConfig({ ACP_CONNECTOR_CONFIG: path, ACP_CONNECTOR_AUTH_MODE: "api_key" }).auth_mode).toBe("api_key");
    expect(() => loadConnectorConfig({ ACP_CONNECTOR_AUTH_MODE: "abo" })).toThrow(/auth_mode/);
  });

  it("weitere Agents bekommen auth_profile none, unbekannter default_agent ist ein Fehler", () => {
    const path = join(dir, "agents.json");
    writeFileSync(path, JSON.stringify({ default_agent: "codex", agent_servers: { codex: { command: "codex-acp", args: ["-v"] } } }));
    const config = loadConnectorConfig({ ACP_CONNECTOR_CONFIG: path });
    expect(config.default_agent).toBe("codex");
    expect(config.agent_servers.codex).toEqual({ type: "custom", command: "codex-acp", args: ["-v"], env: {}, auth_profile: "none" });
    expect(() => loadConnectorConfig({ ACP_CONNECTOR_CONFIG: path, ACP_CONNECTOR_DEFAULT_AGENT: "gibtsnicht" })).toThrow(/default_agent/);
  });

  it.each([
    [{ agent_servers: { x: { type: "stdio", command: "c" } } }, /type/],
    [{ agent_servers: { x: {} } }, /command fehlt/],
    [{ agent_servers: { x: { command: "c", args: [1] } } }, /args/],
    [{ agent_servers: { x: { command: "c", env: { A: 1 } } } }, /env\.A/],
    [{ agent_servers: { x: { command: "c", auth_profile: "openai" } } }, /auth_profile/],
  ])("lehnt ungültige agent_servers ab: %j", (raw, message) => {
    const path = join(dir, "invalid.json");
    writeFileSync(path, JSON.stringify(raw));
    expect(() => loadConnectorConfig({ ACP_CONNECTOR_CONFIG: path })).toThrow(message);
  });
});

describe("package-info", () => {
  it("liest Name und Version aus package.json", () => {
    expect(PACKAGE_NAME).toBe(packageJson.name);
    expect(PACKAGE_VERSION).toBe(packageJson.version);
  });
});
