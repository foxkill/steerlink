import { describe, expect, it } from "vitest";

import { sanitizeAuthStatus } from "../src/acp/agent-process.js";
import {
    AuthConfigError,
    buildAgentLaunch,
    describeCredentials,
    HIDE_CLAUDE_AUTH_FLAG,
    PARENT_SESSION_VARS,
} from "../src/auth/agent-launch.js";
import type { AgentServerConfig } from "../src/config/connector-config.js";

const claude: AgentServerConfig = {
    type: "custom",
    command: "node",
    args: ["claude-agent-acp.js"],
    env: {},
    auth_profile: "claude",
};
const other: AgentServerConfig = {
    type: "custom",
    command: "codex-acp",
    args: [],
    env: { X: "1" },
    auth_profile: "none",
};

describe("buildAgentLaunch", () => {
    const base = {
        PATH: "/bin",
        ANTHROPIC_API_KEY: "sk-test",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-test",
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "abc",
    };

    it("api_key: key stays, OAuth token is removed, subscription blocked", () => {
        const launch = buildAgentLaunch(claude, "api_key", base);
        expect(launch.env.ANTHROPIC_API_KEY).toBe("sk-test");
        expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
        expect(launch.args).toContain(HIDE_CLAUDE_AUTH_FLAG);
    });

    it("api_key without a key is a configuration error", () => {
        expect(() => buildAgentLaunch(claude, "api_key", { PATH: "/bin" })).toThrow(AuthConfigError);
    });

    it("api_key from the env block of the agent configuration counts", () => {
        const launch = buildAgentLaunch({ ...claude, env: { ANTHROPIC_API_KEY: "sk-config" } }, "api_key", {
            PATH: "/bin",
        });
        expect(launch.env.ANTHROPIC_API_KEY).toBe("sk-config");
    });

    it("subscription: API keys removed, OAuth token only passed through, no flag", () => {
        const launch = buildAgentLaunch({ ...claude, args: ["x.js", HIDE_CLAUDE_AUTH_FLAG] }, "subscription", base);
        expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-test");
        expect(launch.args).not.toContain(HIDE_CLAUDE_AUTH_FLAG);
    });

    it("variables of an enclosing Claude Code session are not inherited", () => {
        const launch = buildAgentLaunch(claude, "api_key", base);
        expect(launch.env.CLAUDECODE).toBeUndefined();
        expect(launch.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
        expect(launch.env.PATH).toBe("/bin");
    });

    it("api_key: unexpanded plugin placeholder does not count as a key", () => {
        const env = { PATH: "/bin", ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" };
        expect(() => buildAgentLaunch(claude, "api_key", env)).toThrow(
            /unexpanded placeholder \$\{ANTHROPIC_API_KEY\}/,
        );
        expect(describeCredentials(claude, env).anthropic_api_key_set).toBe(false);
    });

    it("placeholders from the env block never reach the agent", () => {
        const launch = buildAgentLaunch({ ...other, env: { TOKEN: "${TOKEN}", KEEP: "x ${TOKEN}" } }, "api_key", {
            PATH: "/bin",
        });
        expect(launch.env).not.toHaveProperty("TOKEN");
        expect(launch.env.KEEP).toBe("x ${TOKEN}");
    });

    it("user settings such as CLAUDE_CODE_GIT_BASH_PATH reach the agent", () => {
        const launch = buildAgentLaunch(claude, "api_key", {
            ANTHROPIC_API_KEY: "k",
            CLAUDE_CODE_GIT_BASH_PATH: "C:Program FilesGit\bin\bash.exe",
            CLAUDE_CODE_USE_BEDROCK: "1",
            CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
        });
        expect(launch.env.CLAUDE_CODE_GIT_BASH_PATH).toBe("C:Program FilesGit\bin\bash.exe");
        expect(launch.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
        expect(launch.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("8000");
    });

    it("every session variable of an enclosing Claude Code session is removed, even for other agents", () => {
        const parent = Object.fromEntries([...PARENT_SESSION_VARS].map((name) => [name, "parent"]));
        expect(PARENT_SESSION_VARS.has("CLAUDE_CODE_MESSAGING_TOKEN")).toBe(true);
        for (const server of [claude, other]) {
            const launch = buildAgentLaunch(server, "api_key", { ...parent, ANTHROPIC_API_KEY: "k" });
            for (const name of PARENT_SESSION_VARS) {
                expect(launch.env, name).not.toHaveProperty(name);
            }
        }
    });

    it("api_key also removes refresh token and scopes, subscription passes them through", () => {
        const env = { ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "r", CLAUDE_CODE_OAUTH_SCOPES: "s" };
        const apiKey = buildAgentLaunch(claude, "api_key", env);
        expect(apiKey.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBeUndefined();
        expect(apiKey.env.CLAUDE_CODE_OAUTH_SCOPES).toBeUndefined();
        const subscription = buildAgentLaunch(claude, "subscription", env);
        expect(subscription.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBe("r");
        expect(subscription.env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it("the agent's env block may set variables deliberately", () => {
        const launch = buildAgentLaunch({ ...claude, env: { CLAUDE_CODE_USE_BEDROCK: "1" } }, "api_key", {
            ANTHROPIC_API_KEY: "k",
        });
        expect(launch.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    });

    it("other agents get env and args unchanged", () => {
        const launch = buildAgentLaunch(other, "api_key", { PATH: "/bin", ANTHROPIC_API_KEY: "k" });
        expect(launch.args).toEqual([]);
        expect(launch.env.X).toBe("1");
        expect(launch.env.ANTHROPIC_API_KEY).toBe("k");
    });
});

describe("sanitizeAuthStatus", () => {
    it("removes email and organization", () => {
        const result = sanitizeAuthStatus({
            authStatus: { kind: "account", label: "Claude Max", detail: "a@b.c", account: { plan: "max" } },
        });
        expect(result).toEqual({ kind: "account", label: "Claude Max", plan: "max" });
    });

    it("keeps harmless details for an API key", () => {
        expect(
            sanitizeAuthStatus({
                authStatus: { kind: "api_key", label: "Anthropic API key", detail: "ANTHROPIC_API_KEY" },
            }),
        ).toEqual({
            kind: "api_key",
            label: "Anthropic API key",
            detail: "ANTHROPIC_API_KEY",
        });
    });
});
