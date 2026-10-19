import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };
import { loadConnectorConfig } from "../src/config/connector-config.js";
import { isUnexpandedPlaceholder, readEnv } from "../src/config/env.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/package-info.js";

describe("readEnv / isUnexpandedPlaceholder", () => {
    it.each(["${X}", "${ANTHROPIC_API_KEY}", " ${_a1} ", "${env:ANTHROPIC_API_KEY}", "${userHome}", "${1X}"])(
        "%s is a placeholder",
        (value) => {
            expect(isUnexpandedPlaceholder(value)).toBe(true);
        },
    );

    it.each(["", "x", "$X", "${}", "${ X}", "prefix ${X}", "${X}${Y}", "sk-ant-${X}", "${X} suffix"])(
        "%j is not a placeholder",
        (value) => {
            expect(isUnexpandedPlaceholder(value)).toBe(false);
        },
    );

    it("empty values and placeholders count as unset", () => {
        expect(readEnv({ A: "", B: "${B}", C: "value" }, "A")).toBeUndefined();
        expect(readEnv({ A: "", B: "${B}", C: "value" }, "B")).toBeUndefined();
        expect(readEnv({ A: "", B: "${B}", C: "value" }, "C")).toBe("value");
        expect(readEnv({}, "D")).toBeUndefined();
    });
});

describe("loadConnectorConfig", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-config-test-"));
    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("default: only claude, api_key", () => {
        const config = loadConnectorConfig({});
        expect(Object.keys(config.agent_servers)).toEqual(["claude"]);
        expect(config.default_agent).toBe("claude");
        expect(config.auth_mode).toBe("api_key");
    });

    it("unexpanded placeholders in ACP_CONNECTOR_* are ignored", () => {
        const config = loadConnectorConfig({
            ACP_CONNECTOR_AUTH_MODE: "${ACP_CONNECTOR_AUTH_MODE}",
            ACP_CONNECTOR_DEFAULT_AGENT: "${AGENT}",
            ACP_CONNECTOR_CONFIG: "${CONFIG}",
        });
        expect(config.auth_mode).toBe("api_key");
        expect(config.default_agent).toBe("claude");
    });

    it("env override beats the file, an invalid mode is an error", () => {
        const path = join(dir, "config.json");
        writeFileSync(
            path,
            JSON.stringify({ auth_mode: "subscription", agent_servers: { codex: { command: "codex-acp" } } }),
        );
        expect(loadConnectorConfig({ ACP_CONNECTOR_CONFIG: path }).auth_mode).toBe("subscription");
        expect(loadConnectorConfig({ ACP_CONNECTOR_CONFIG: path, ACP_CONNECTOR_AUTH_MODE: "api_key" }).auth_mode).toBe(
            "api_key",
        );
        expect(() => loadConnectorConfig({ ACP_CONNECTOR_AUTH_MODE: "abo" })).toThrow(/auth_mode/);
    });

    it("additional agents get auth_profile none, an unknown default_agent is an error", () => {
        const path = join(dir, "agents.json");
        writeFileSync(
            path,
            JSON.stringify({
                default_agent: "codex",
                agent_servers: { codex: { command: "codex-acp", args: ["-v"] } },
            }),
        );
        const config = loadConnectorConfig({ ACP_CONNECTOR_CONFIG: path });
        expect(config.default_agent).toBe("codex");
        expect(config.agent_servers.codex).toEqual({
            type: "custom",
            command: "codex-acp",
            args: ["-v"],
            env: {},
            auth_profile: "none",
        });
        expect(() =>
            loadConnectorConfig({ ACP_CONNECTOR_CONFIG: path, ACP_CONNECTOR_DEFAULT_AGENT: "doesnotexist" }),
        ).toThrow(/default_agent/);
    });

    it.each([
        [{ agent_servers: { x: { type: "stdio", command: "c" } } }, 'agent_servers.x.type: only "custom" is supported'],
        [{ agent_servers: { x: {} } }, "agent_servers.x.command: missing"],
        [{ agent_servers: { x: { command: "" } } }, "agent_servers.x.command: missing"],
        [{ agent_servers: { x: { command: "c", args: [1] } } }, "agent_servers.x.args.0:"],
        [{ agent_servers: { x: { command: "c", env: { A: 1 } } } }, "agent_servers.x.env.A: must be a string"],
        [
            { agent_servers: { x: { command: "c", auth_profile: "openai" } } },
            'agent_servers.x.auth_profile: must be "claude" or "none"',
        ],
        [{ auth_mode: "abo" }, 'auth_mode: auth_mode must be "api_key" or "subscription"'],
    ])("rejects invalid configuration with the exact path: %j", (raw, message) => {
        const path = join(dir, "invalid.json");
        writeFileSync(path, JSON.stringify(raw));
        expect(() => loadConnectorConfig({ ACP_CONNECTOR_CONFIG: path })).toThrow(message);
    });

    it("reports broken JSON and missing files with their path", () => {
        const path = join(dir, "broken.json");
        writeFileSync(path, "{ not json");
        expect(() => loadConnectorConfig({ ACP_CONNECTOR_CONFIG: path })).toThrow(
            /broken\.json is not readable or not JSON/,
        );
        expect(() => loadConnectorConfig({ ACP_CONNECTOR_CONFIG: join(dir, "missing.json") })).toThrow(
            /missing\.json is not readable/,
        );
    });

    it("unknown fields in the file are ignored", () => {
        const path = join(dir, "extra.json");
        writeFileSync(
            path,
            JSON.stringify({ comment: "x", agent_servers: { codex: { command: "codex-acp", note: "y" } } }),
        );
        expect(loadConnectorConfig({ ACP_CONNECTOR_CONFIG: path }).agent_servers.codex?.command).toBe("codex-acp");
    });
});

describe("package-info", () => {
    it("reads name and version from package.json", () => {
        expect(PACKAGE_NAME).toBe(packageJson.name);
        expect(PACKAGE_VERSION).toBe(packageJson.version);
    });
});
