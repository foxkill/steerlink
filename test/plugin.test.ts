import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isSafeRelativePath, parseFrontmatter, parsePackageSpec, validatePlugin } from "../scripts/validate-plugin.js";
import type { AuthStatusResult } from "../src/sessions/session-manager.js";
import { ConnectorClient } from "./helpers/connector-client.js";
import { defined } from "./helpers/defined.js";

const repoRoot = join(import.meta.dirname, "..");

type Files = Record<string, string | object>;

const LOGO =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#000"/><circle cx="32" cy="32" r="8" fill="#fff"/></svg>';

function manifestWith(changes: Record<string, unknown>): object {
    return { ...(validPlugin()[".cursor-plugin/plugin.json"] as object), ...changes };
}

function mcpWith(server: Record<string, unknown>): object {
    return { mcpServers: { demo: server } };
}

/** Lowest version a range allows (across all `||` alternatives), as a number for comparison. */
function minVersion(range: string): number {
    return Math.min(
        ...range.split("||").map((alternative) => {
            // Missing parts (e.g. in ">=22") count as 0.
            const [, major = "0", minor = "0", patch = "0"] = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(alternative) ?? [];
            return Number(major) * 1e6 + Number(minor) * 1e3 + Number(patch);
        }),
    );
}

/** Tool names from a skill's Markdown table `| \`tool\` | … |`. */
function toolsInSkillTable(markdown: string): string[] {
    return [...markdown.matchAll(/^\| `([a-z_]+)` \|/gm)].flatMap(([, name]) => (name === undefined ? [] : [name]));
}

function byCodePoint(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/** A minimal, valid plugin; tests override individual files. */
function validPlugin(): Files {
    return {
        "package.json": { name: "demo-bridge", version: "1.2.3", license: "MIT" },
        ".cursor-plugin/plugin.json": {
            name: "demo-bridge",
            version: "1.2.3",
            description: "Demo",
            author: { name: "Tester" },
            license: "MIT",
            logo: "assets/logo.svg",
            variables: {
                type: "object",
                properties: { API_KEY: { type: "string", title: "Key", description: "Your own key" } },
                required: ["API_KEY"],
            },
        },
        "mcp.json": {
            mcpServers: { demo: { command: "npx", args: ["-y", "demo-bridge@1.2.3"], env: { API_KEY: "${API_KEY}" } } },
        },
        "assets/logo.svg": LOGO,
        "skills/do-things/SKILL.md": "---\nname: do-things\ndescription: Does things.\n---\n\n# Do things\n",
        "README.md": "# Demo\n",
    };
}

describe("validatePlugin", () => {
    const dirs: string[] = [];
    afterAll(() => {
        dirs.forEach((dir) => {
            rmSync(dir, { recursive: true, force: true });
        });
    });

    function check(overrides: Files = {}, remove: string[] = []): { errors: string[]; warnings: string[] } {
        const dir = mkdtempSync(join(tmpdir(), "plugin-validate-"));
        dirs.push(dir);
        const files = { ...validPlugin(), ...overrides };
        for (const path of remove) {
            delete files[path];
        }
        for (const [path, content] of Object.entries(files)) {
            mkdirSync(dirname(join(dir, path)), { recursive: true });
            writeFileSync(join(dir, path), typeof content === "string" ? content : JSON.stringify(content, null, 2));
        }
        return validatePlugin(dir);
    }

    it("this repo's plugin is valid without errors or warnings", () => {
        expect(validatePlugin(repoRoot)).toEqual({ errors: [], warnings: [] });
    });

    it("warns when the plugin has no open-source license", () => {
        const result = check({
            "package.json": { name: "demo-bridge", version: "1.2.3", license: "UNLICENSED" },
            ".cursor-plugin/plugin.json": manifestWith({ license: "UNLICENSED" }),
        });
        expect(result.errors).toEqual([]);
        expect(result.warnings).toEqual([expect.stringContaining("no open-source license")]);
    });

    it("the minimal fixture has no errors and no warnings", () => {
        expect(check()).toEqual({ errors: [], warnings: [] });
    });

    describe("no false alarms for valid variants", () => {
        it.each([
            ["end of sentence after the version", "# Demo\n\nRun demo-bridge@1.2.3.\n"],
            ["comma and parenthesis after the version", "# Demo\n\n(demo-bridge@1.2.3), demo-bridge@1.2.3, done\n"],
        ])("README: %s", (_label, readme) => {
            expect(check({ "README.md": readme }).errors).toEqual([]);
        });

        it.each([
            ["stroke-width before width", '<rect stroke-width="2" width="64" height="64" fill="#000"/>'],
            ["100% width and height", '<rect width="100%" height="100%" fill="#000"/>'],
        ])("logo background: %s", (_label, rect) => {
            const svg = LOGO.replace('<rect width="64" height="64" fill="#000"/>', rect);
            expect(check({ "assets/logo.svg": svg }).errors).toEqual([]);
        });

        it("skill with a YAML block scalar as description", () => {
            const skill = "---\nname: do-things\ndescription: >-\n  Does things\n  in two lines.\n---\n";
            expect(check({ "skills/do-things/SKILL.md": skill }).errors).toEqual([]);
        });

        it("a command without frontmatter is allowed, a rule without description is only a warning", () => {
            const result = check({
                "commands/deploy.md": "# Deploy\n",
                "rules/style.mdc": "---\nalwaysApply: true\n---\nUse const.\n",
            });
            expect(result.errors).toEqual([]);
            expect(result.warnings).toEqual([
                expect.stringMatching(/Rule rules\/style\.mdc: "description" is missing/),
            ]);
        });

        it("a lowercase variable name is only a warning", () => {
            const result = check({
                ".cursor-plugin/plugin.json": manifestWith({
                    variables: { type: "object", properties: { apiKey: { type: "string", description: "x" } } },
                }),
                "mcp.json": mcpWith({
                    command: "npx",
                    args: ["-y", "demo-bridge@1.2.3"],
                    env: { API_KEY: "${apiKey}" },
                }),
            });
            expect(result.errors).toEqual([]);
            expect(result.warnings).toEqual([
                expect.stringMatching(/"apiKey" should be named like an environment variable/),
            ]);
        });

        it("absolute logo URL on GitHub user content", () => {
            const result = check({
                ".cursor-plugin/plugin.json": manifestWith({
                    logo: "https://raw.githubusercontent.com/o/r/main/logo.svg",
                }),
            });
            expect(result.errors).toEqual([]);
        });
    });

    it("parseFrontmatter: `---more` does not close the block", () => {
        expect(parseFrontmatter("---\nname: x\n---more\n")).toBeUndefined();
        expect(parseFrontmatter("---\nname: x\n---  \nText")?.fields).toEqual({ name: "x" });
    });

    it.each([
        [
            "invalid name",
            { ".cursor-plugin/plugin.json": manifestWith({ name: "Demo_Bridge" }) },
            /"name" must be lowercase/,
        ],
        ["unknown field", { ".cursor-plugin/plugin.json": manifestWith({ mcp: "mcp.json" }) }, /unknown field "mcp"/],
        ["not SemVer", { ".cursor-plugin/plugin.json": manifestWith({ version: "1.2" }) }, /SemVer/],
        [
            "empty description",
            { ".cursor-plugin/plugin.json": manifestWith({ description: " " }) },
            /"description" is missing/,
        ],
        [
            "homepage without https",
            { ".cursor-plugin/plugin.json": manifestWith({ homepage: "http://example.com" }) },
            /"homepage" must be an https URL/,
        ],
        [
            "path with ..",
            { ".cursor-plugin/plugin.json": manifestWith({ logo: "../logo.svg" }) },
            /invalid path "\.\.\/logo\.svg"/,
        ],
        [
            "absolute path",
            { ".cursor-plugin/plugin.json": manifestWith({ skills: "/skills" }) },
            /invalid path "\/skills"/,
        ],
        [
            "missing path",
            { ".cursor-plugin/plugin.json": manifestWith({ logo: "assets/missing.svg" }) },
            /missing path "assets\/missing\.svg"/,
        ],
        [
            "logo URL outside GitHub",
            { ".cursor-plugin/plugin.json": manifestWith({ logo: "https://cdn.example.com/logo.svg" }) },
            /GitHub user content/,
        ],
        [
            "disallowed schema keyword",
            {
                ".cursor-plugin/plugin.json": manifestWith({
                    variables: {
                        type: "object",
                        properties: { API_KEY: { type: "string", description: "x", pattern: ".*" } },
                    },
                }),
            },
            /pattern is not an allowed keyword/,
        ],
        [
            "required names an unknown variable",
            {
                ".cursor-plugin/plugin.json": manifestWith({
                    variables: {
                        type: "object",
                        properties: { API_KEY: { type: "string", description: "x" } },
                        required: ["TOKEN"],
                    },
                }),
            },
            /unknown variable "TOKEN"/,
        ],
        [
            "variable without description",
            {
                ".cursor-plugin/plugin.json": manifestWith({
                    variables: { type: "object", properties: { API_KEY: { type: "string" } } },
                }),
            },
            /needs a "description"/,
        ],
        [
            "version differs from package.json",
            { "package.json": { name: "demo-bridge", version: "1.2.4", license: "MIT" } },
            /but package\.json has 1\.2\.4/,
        ],
        [
            "license differs from package.json",
            { "package.json": { name: "demo-bridge", version: "1.2.3", license: "ISC" } },
            /license MIT, but package\.json has ISC/,
        ],
    ])("manifest: %s", (_label, overrides, message) => {
        expect(check(overrides as Files).errors).toEqual(expect.arrayContaining([expect.stringMatching(message)]));
    });

    it.each([
        ["not square", LOGO.replace('viewBox="0 0 64 64"', 'viewBox="0 0 64 32"'), /square/],
        ["without background", LOGO.replace('<rect width="64" height="64" fill="#000"/>', ""), /filled background/],
        ["background without fill", LOGO.replace('fill="#000"', 'fill="none"'), /filled background/],
        ["with script", LOGO.replace("</svg>", "<script>alert(1)</script></svg>"), /must not contain scripts/],
        [
            "with external resource",
            LOGO.replace("</svg>", '<image href="https://x.test/a.png"/></svg>'),
            /external resources/,
        ],
    ])("logo: %s", (_label, svg, message) => {
        expect(check({ "assets/logo.svg": svg }).errors).toEqual(
            expect.arrayContaining([expect.stringMatching(message)]),
        );
    });

    it.each([
        [
            "undeclared placeholder",
            mcpWith({ command: "npx", args: ["-y", "demo-bridge@1.2.3"], env: { TOKEN: "${TOKEN}" } }),
            /\$\{TOKEN\} is not declared in plugin\.json/,
        ],
        ["npx without version", mcpWith({ command: "npx", args: ["-y", "demo-bridge"] }), /exact version/],
        ["npx with latest", mcpWith({ command: "npx", args: ["-y", "demo-bridge@latest"] }), /exact version/],
        ["npx with range", mcpWith({ command: "npx", args: ["-y", "demo-bridge@^1.2.3"] }), /exact version/],
        ["npx without -y", mcpWith({ command: "npx", args: ["demo-bridge@1.2.3"] }), /npx needs "-y"/],
        [
            "npx with old version",
            mcpWith({ command: "npx", args: ["-y", "demo-bridge@1.2.2"] }),
            /package\.json has version 1\.2\.3/,
        ],
        ["npx with foreign package", mcpWith({ command: "npx", args: ["-y", "other@1.2.3"] }), /starts "other"/],
        ["command and url", mcpWith({ command: "x", url: "https://x.test/mcp" }), /exactly one of "command"/],
        ["HTTP without https", mcpWith({ url: "http://x.test/mcp" }), /https URL/],
        ["stdio with headers", mcpWith({ command: "x", headers: { A: "b" } }), /field "headers" does not fit/],
        ["env with number", mcpWith({ command: "x", env: { A: 1 } }), /"env" must be an object with string values/],
        ["args not an array", mcpWith({ command: "x", args: "-y" }), /"args" must be a string array/],
        ["absolute command", mcpWith({ command: "/usr/bin/x" }), /absolute path/],
        ["absolute Windows command", mcpWith({ command: "C:\\tools\\x.exe" }), /absolute path/],
    ])("mcp.json: %s", (_label, mcp, message) => {
        expect(check({ "mcp.json": mcp }).errors).toEqual(expect.arrayContaining([expect.stringMatching(message)]));
    });

    it("mcp.json: a server name with __ is invalid for Grok Bot", () => {
        const result = check({ "mcp.json": { mcpServers: { a__b: { command: "x" } } } });
        expect(result.errors).toEqual(expect.arrayContaining([expect.stringMatching(/must not contain "__"/)]));
    });

    it("mcp.json: host placeholders need no declaration, unused variables are a warning", () => {
        const result = check({ "mcp.json": mcpWith({ command: "${CURSOR_PLUGIN_ROOT}/bin/server" }) });
        expect(result.errors).toEqual([]);
        expect(result.warnings).toEqual([expect.stringMatching(/"API_KEY" is not used in mcp\.json/)]);
    });

    it.each([
        ["without frontmatter", "# Just text\n", /YAML frontmatter is missing/],
        ["without description", "---\nname: do-things\n---\n", /"description" is missing/],
        ["name does not match the folder", "---\nname: other\ndescription: x\n---\n", /folder name/],
        ["name not kebab-case", "---\nname: Do_Things\ndescription: x\n---\n", /kebab-case/],
        ["broken line", "---\nname: do-things\ndescription: x\nno colon here\n---\n", /invalid frontmatter line/],
        ["description too long", `---\nname: do-things\ndescription: ${"x".repeat(1025)}\n---\n`, /1024/],
    ])("skill: %s", (_label, content, message) => {
        expect(check({ "skills/do-things/SKILL.md": content }).errors).toEqual(
            expect.arrayContaining([expect.stringMatching(message)]),
        );
    });

    it("a skill folder without SKILL.md is an error", () => {
        expect(check({ "skills/empty/notes.md": "x" }).errors).toEqual(
            expect.arrayContaining([expect.stringMatching(/SKILL\.md is missing/)]),
        );
    });

    it("README with an outdated package version or a different prerelease", () => {
        const result = check({
            "README.md":
                "# Demo\n\n`npx -y demo-bridge@1.2.3` or old: demo-bridge@1.0.0. Beta: demo-bridge@1.2.3-beta.1\n",
        });
        expect(result.errors).toEqual([
            expect.stringMatching(/README\.md mentions demo-bridge@1\.0\.0,/),
            expect.stringMatching(/README\.md mentions demo-bridge@1\.2\.3-beta\.1,/),
        ]);
    });

    it("secrets are also found in docs/", () => {
        const result = check({ "docs/setup.md": `token ghp_${"c".repeat(36)}\n` });
        expect(result.errors).toEqual([
            expect.stringContaining("docs/setup.md: probably contains a secret (GitHub token)"),
        ]);
    });

    it("README is missing", () => {
        expect(check({}, ["README.md"]).errors).toEqual(
            expect.arrayContaining([expect.stringMatching(/README\.md is missing/)]),
        );
    });

    it("manifest is missing or broken", () => {
        expect(check({}, [".cursor-plugin/plugin.json"]).errors).toEqual([
            expect.stringMatching(/plugin\.json is missing/),
        ]);
        expect(check({ ".cursor-plugin/plugin.json": "{not json" }).errors).toEqual([
            expect.stringMatching(/is not valid JSON/),
        ]);
    });

    it.each([
        ["Anthropic key", `sk-ant-api03-${"a".repeat(40)}`],
        ["GitHub token", `ghp_${"b".repeat(36)}`],
        ["private key", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    ])("a secret in the plugin is detected: %s", (label, secret) => {
        const result = check({ "README.md": `# Demo\n\nkey: ${secret}\n` });
        expect(result.errors).toEqual(
            expect.arrayContaining([expect.stringContaining(`README.md: probably contains a secret (${label})`)]),
        );
    });
});

describe("package metadata", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
        engines: { node: string };
        dependencies: Record<string, string>;
    };
    /** Dependencies that themselves require a Node version. */
    const nodeRequirements = Object.keys(pkg.dependencies).flatMap((name) => {
        const dependency = JSON.parse(
            readFileSync(join(repoRoot, "node_modules", ...name.split("/"), "package.json"), "utf8"),
        ) as { engines?: { node?: string } };
        const required = dependency.engines?.node;
        return required === undefined ? [] : [[name, required] as const];
    });

    it("minVersion understands alternatives and partial versions", () => {
        expect(minVersion(">=22")).toBe(22e6);
        expect(minVersion("^20.19 || >=22")).toBe(20e6 + 19e3);
        expect(minVersion("^20.0.0 || ^22.0.0 || >=24.0.0")).toBe(20e6);
    });

    it.each(nodeRequirements)("engines.node requires at least what %s requires (%s)", (_name, required) => {
        expect(minVersion(pkg.engines.node)).toBeGreaterThanOrEqual(minVersion(required));
    });

    it("checks at least claude-agent-acp", () => {
        expect(nodeRequirements.map(([name]) => name)).toContain("@agentclientprotocol/claude-agent-acp");
    });
});

describe("marketplace search", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, ".cursor-plugin", "plugin.json"), "utf8")) as {
        name: string;
        displayName: string;
        description: string;
        keywords: string[];
    };
    const searchable = [manifest.name, manifest.displayName, manifest.description, ...manifest.keywords]
        .join(" | ")
        .toLowerCase();

    // What people type into "Connect apps" when they look for this plugin (English and German).
    it.each([
        "claude code",
        "steer claude code",
        "control claude code",
        "remote control claude code",
        "remote-control claude code",
        "claude code steuern",
        "claude code fernsteuern",
        "codex",
        "coding agent",
        "grok bot",
    ])("is found for %j", (query) => {
        expect(searchable).toContain(query);
    });

    it("keeps Claude Code out of the product name (Anthropic trademark guidelines)", () => {
        expect(`${manifest.name} ${manifest.displayName}`.toLowerCase()).not.toContain("claude");
    });
});

describe("validator helpers", () => {
    it("parseFrontmatter: folded lines, quotes, CRLF and BOM", () => {
        const parsed = parseFrontmatter(
            '\uFEFF---\r\nname: "x"\r\ndescription: first\r\n  second line\r\n# Comment\r\n---\r\nText',
        );
        expect(parsed).toEqual({ fields: { name: "x", description: "first second line" }, invalidLines: [] });
        expect(parseFrontmatter("no frontmatter")).toBeUndefined();
        expect(parseFrontmatter("---\nname: x\n")).toBeUndefined();
    });

    it.each([
        ["skills", true],
        ["./assets/logo.svg", true],
        ["a/../b", true],
        ["../x", false],
        ["a/../../x", false],
        ["..", false],
        ["/abs", false],
        ["\\abs", false],
        ["C:/x", false],
        ["", false],
    ])("isSafeRelativePath(%j) = %s", (path, expected) => {
        expect(isSafeRelativePath(path)).toBe(expected);
    });

    it("parsePackageSpec understands scopes", () => {
        expect(parsePackageSpec("agent-steer@0.1.0-rc.0")).toEqual({ name: "agent-steer", version: "0.1.0-rc.0" });
        expect(parsePackageSpec("@scope/pkg@1.0.0")).toEqual({ name: "@scope/pkg", version: "1.0.0" });
        expect(parsePackageSpec("@scope/pkg")).toEqual({ name: "@scope/pkg", version: undefined });
        expect(parsePackageSpec("pkg")).toEqual({ name: "pkg", version: undefined });
    });
});

describe("plugin against the real connector", () => {
    const skill = readFileSync(join(repoRoot, "skills", "delegate-to-coding-agent", "SKILL.md"), "utf8");
    const mcp = JSON.parse(readFileSync(join(repoRoot, "mcp.json"), "utf8")) as {
        mcpServers: Record<string, { env: Record<string, string> }>;
    };
    const pluginEnv = defined(Object.values(mcp.mcpServers)[0], "server in mcp.json").env;
    const clients: ConnectorClient[] = [];

    async function connect(env: Record<string, string>): Promise<ConnectorClient> {
        const client = new ConnectorClient();
        clients.push(client);
        // Like the host: only the values from mcp.json, without the connector's own configuration.
        await client.connect(env, false, true);
        return client;
    }

    let unset: ConnectorClient;
    beforeAll(async () => {
        // Variable not set: the host passes the placeholder through unchanged.
        unset = await connect(pluginEnv);
    });

    afterAll(async () => {
        await Promise.all(clients.map((client) => client.close()));
    });

    it("the tool table in the skill matches tools/list exactly", async () => {
        const documented = toolsInSkillTable(skill).toSorted(byCodePoint);
        const offered = (await unset.listToolNames()).toSorted(byCodePoint);
        expect(documented).toEqual(offered);
    });

    it("mcp.json sets the API key mode and only declared variables", () => {
        expect(pluginEnv.ACP_CONNECTOR_AUTH_MODE).toBe("api_key");
        expect(pluginEnv.ANTHROPIC_API_KEY).toBe("${ANTHROPIC_API_KEY}");
    });

    it("unset plugin variable: a clear hint instead of a failed start", async () => {
        const status = await unset.call<AuthStatusResult>("auth_status", {});
        expect(status.data.auth_mode).toBe("api_key");
        expect(status.data.credentials.anthropic_api_key_set).toBe(false);
        expect(status.data.problem).toMatch(/plugin settings/);

        const session = await unset.call("start_session", { cwd: repoRoot });
        expect(session.isError).toBe(true);
        expect(session.text).toMatch(/plugin settings \(variable ANTHROPIC_API_KEY\)/);
    });

    it("a set plugin variable is detected without being printed", async () => {
        const key = "sk-test-not-a-real-key-123456";
        const client = await connect({ ...pluginEnv, ANTHROPIC_API_KEY: key });
        const status = await client.call<AuthStatusResult>("auth_status", { probe: false });
        expect(status.data.credentials.anthropic_api_key_set).toBe(true);
        expect(status.data.hide_claude_auth).toBe(true);
        expect(status.data.problem).toBeNull();
        expect(status.text).not.toContain(key);
    });
});
