import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isSafeRelativePath, parseFrontmatter, parsePackageSpec, validatePlugin } from "../scripts/validate-plugin.js";
import { ConnectorClient } from "./helpers/connector-client.js";
import type { AuthStatusResult } from "../src/sessions/session-manager.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type Files = Record<string, string | object>;

const LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#000"/><circle cx="32" cy="32" r="8" fill="#fff"/></svg>';

/** Ein minimales, gültiges Plugin; Tests überschreiben einzelne Dateien. */
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
        properties: { API_KEY: { type: "string", title: "Key", description: "Eigener Key" } },
        required: ["API_KEY"],
      },
    },
    "mcp.json": { mcpServers: { demo: { command: "npx", args: ["-y", "demo-bridge@1.2.3"], env: { API_KEY: "${API_KEY}" } } } },
    "assets/logo.svg": LOGO,
    "skills/do-things/SKILL.md": "---\nname: do-things\ndescription: Does things.\n---\n\n# Do things\n",
    "README.md": "# Demo\n",
  };
}

describe("validatePlugin", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

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

  function manifestWith(changes: Record<string, unknown>): object {
    return { ...(validPlugin()[".cursor-plugin/plugin.json"] as object), ...changes };
  }

  function mcpWith(server: Record<string, unknown>): object {
    return { mcpServers: { demo: server } };
  }

  it("das Plugin dieses Repos ist gültig; offen ist nur die Lizenzwahl", () => {
    const result = validatePlugin(repoRoot);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("keine offene Lizenz")]);
  });

  it("das minimale Fixture ist fehler- und warnungsfrei", () => {
    expect(check()).toEqual({ errors: [], warnings: [] });
  });

  it.each([
    ["ungültiger Name", { ".cursor-plugin/plugin.json": manifestWith({ name: "Demo_Bridge" }) }, /"name" muss kleingeschrieben/],
    ["unbekanntes Feld", { ".cursor-plugin/plugin.json": manifestWith({ mcp: "mcp.json" }) }, /unbekanntes Feld "mcp"/],
    ["keine SemVer", { ".cursor-plugin/plugin.json": manifestWith({ version: "1.2" }) }, /SemVer/],
    ["leere Beschreibung", { ".cursor-plugin/plugin.json": manifestWith({ description: " " }) }, /"description" fehlt/],
    ["Homepage ohne https", { ".cursor-plugin/plugin.json": manifestWith({ homepage: "http://example.com" }) }, /"homepage" muss eine https-URL/],
    ["Pfad mit ..", { ".cursor-plugin/plugin.json": manifestWith({ logo: "../logo.svg" }) }, /unzulässigen Pfad "\.\.\/logo\.svg"/],
    ["absoluter Pfad", { ".cursor-plugin/plugin.json": manifestWith({ skills: "/skills" }) }, /unzulässigen Pfad "\/skills"/],
    ["fehlender Pfad", { ".cursor-plugin/plugin.json": manifestWith({ logo: "assets/fehlt.svg" }) }, /fehlenden Pfad "assets\/fehlt\.svg"/],
    [
      "unerlaubtes Schema-Schlüsselwort",
      { ".cursor-plugin/plugin.json": manifestWith({ variables: { type: "object", properties: { API_KEY: { type: "string", description: "x", pattern: ".*" } } } }) },
      /pattern ist kein zulässiges Schlüsselwort/,
    ],
    [
      "required nennt unbekannte Variable",
      { ".cursor-plugin/plugin.json": manifestWith({ variables: { type: "object", properties: { API_KEY: { type: "string", description: "x" } }, required: ["TOKEN"] } }) },
      /unbekannte Variable "TOKEN"/,
    ],
    [
      "Variable ohne Beschreibung",
      { ".cursor-plugin/plugin.json": manifestWith({ variables: { type: "object", properties: { API_KEY: { type: "string" } } } }) },
      /braucht eine "description"/,
    ],
    ["Version weicht von package.json ab", { "package.json": { name: "demo-bridge", version: "1.2.4", license: "MIT" } }, /package\.json aber 1\.2\.4/],
    ["Lizenz weicht von package.json ab", { "package.json": { name: "demo-bridge", version: "1.2.3", license: "ISC" } }, /Lizenz MIT, package\.json aber ISC/],
  ])("Manifest: %s", (_label, overrides, message) => {
    expect(check(overrides as Files).errors).toEqual(expect.arrayContaining([expect.stringMatching(message)]));
  });

  it.each([
    ["nicht quadratisch", LOGO.replace('viewBox="0 0 64 64"', 'viewBox="0 0 64 32"'), /quadratisch/],
    ["ohne Hintergrundfläche", LOGO.replace('<rect width="64" height="64" fill="#000"/>', ""), /Hintergrundfläche/],
    ["Hintergrund ohne Füllung", LOGO.replace('fill="#000"', 'fill="none"'), /Hintergrundfläche/],
    ["mit Skript", LOGO.replace("</svg>", "<script>alert(1)</script></svg>"), /kein Skript/],
    ["mit externer Ressource", LOGO.replace("</svg>", '<image href="https://x.test/a.png"/></svg>'), /externen Ressourcen/],
  ])("Logo: %s", (_label, svg, message) => {
    expect(check({ "assets/logo.svg": svg }).errors).toEqual(expect.arrayContaining([expect.stringMatching(message)]));
  });

  it.each([
    ["nicht deklarierter Platzhalter", mcpWith({ command: "npx", args: ["-y", "demo-bridge@1.2.3"], env: { TOKEN: "${TOKEN}" } }), /\$\{TOKEN\} ist nicht in plugin\.json/],
    ["npx ohne Version", mcpWith({ command: "npx", args: ["-y", "demo-bridge"] }), /exakte Version/],
    ["npx mit latest", mcpWith({ command: "npx", args: ["-y", "demo-bridge@latest"] }), /exakte Version/],
    ["npx mit Range", mcpWith({ command: "npx", args: ["-y", "demo-bridge@^1.2.3"] }), /exakte Version/],
    ["npx ohne -y", mcpWith({ command: "npx", args: ["demo-bridge@1.2.3"] }), /npx braucht "-y"/],
    ["npx mit alter Version", mcpWith({ command: "npx", args: ["-y", "demo-bridge@1.2.2"] }), /package\.json hat aber Version 1\.2\.3/],
    ["npx mit fremdem Paket", mcpWith({ command: "npx", args: ["-y", "other@1.2.3"] }), /startet "other"/],
    ["command und url", mcpWith({ command: "x", url: "https://x.test/mcp" }), /genau eines von "command"/],
    ["HTTP ohne https", mcpWith({ url: "http://x.test/mcp" }), /https-URL/],
    ["stdio mit headers", mcpWith({ command: "x", headers: { A: "b" } }), /Feld "headers" passt nicht/],
    ["env mit Zahl", mcpWith({ command: "x", env: { A: 1 } }), /"env" muss ein Objekt mit String-Werten/],
    ["args kein Array", mcpWith({ command: "x", args: "-y" }), /"args" muss ein String-Array/],
    ["absoluter command", mcpWith({ command: "/usr/bin/x" }), /absoluter Pfad/],
  ])("mcp.json: %s", (_label, mcp, message) => {
    expect(check({ "mcp.json": mcp }).errors).toEqual(expect.arrayContaining([expect.stringMatching(message)]));
  });

  it("mcp.json: Servername mit __ ist für Grok Bot ungültig", () => {
    const result = check({ "mcp.json": { mcpServers: { "a__b": { command: "x" } } } });
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringMatching(/ohne "__"/)]));
  });

  it("mcp.json: Host-Platzhalter brauchen keine Deklaration, unbenutzte Variablen sind eine Warnung", () => {
    const result = check({ "mcp.json": mcpWith({ command: "${CURSOR_PLUGIN_ROOT}/bin/server" }) });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([expect.stringMatching(/"API_KEY" wird in mcp\.json nicht verwendet/)]);
  });

  it.each([
    ["ohne Frontmatter", "# Nur Text\n", /YAML-Frontmatter fehlt/],
    ["ohne description", "---\nname: do-things\n---\n", /"description" fehlt/],
    ["Name passt nicht zum Ordner", "---\nname: other\ndescription: x\n---\n", /Ordnernamen/],
    ["Name nicht kebab-case", "---\nname: Do_Things\ndescription: x\n---\n", /kebab-case/],
    ["kaputte Zeile", "---\nname: do-things\ndescription: x\nkein doppelpunkt\n---\n", /ungültige Frontmatter-Zeile/],
    ["zu lange Beschreibung", `---\nname: do-things\ndescription: ${"x".repeat(1025)}\n---\n`, /1024/],
  ])("Skill: %s", (_label, content, message) => {
    expect(check({ "skills/do-things/SKILL.md": content }).errors).toEqual(expect.arrayContaining([expect.stringMatching(message)]));
  });

  it("Skill-Ordner ohne SKILL.md ist ein Fehler", () => {
    expect(check({ "skills/leer/notes.md": "x" }).errors).toEqual(expect.arrayContaining([expect.stringMatching(/SKILL\.md fehlt/)]));
  });

  it("README mit veralteter Paketversion", () => {
    const result = check({ "README.md": "# Demo\n\n`npx -y demo-bridge@1.2.3` oder alt: demo-bridge@1.0.0\n" });
    expect(result.errors).toEqual([expect.stringMatching(/README\.md nennt demo-bridge@1\.0\.0/)]);
  });

  it("README fehlt", () => {
    expect(check({}, ["README.md"]).errors).toEqual(expect.arrayContaining([expect.stringMatching(/README\.md fehlt/)]));
  });

  it("Manifest fehlt oder ist kaputt", () => {
    expect(check({}, [".cursor-plugin/plugin.json"]).errors).toEqual([expect.stringMatching(/plugin\.json fehlt/)]);
    expect(check({ ".cursor-plugin/plugin.json": "{kein json" }).errors).toEqual([expect.stringMatching(/kein gültiges JSON/)]);
  });

  it.each([
    ["Anthropic-Key", `sk-ant-api03-${"a".repeat(40)}`],
    ["GitHub-Token", `ghp_${"b".repeat(36)}`],
    ["privater Schlüssel", "-----BEGIN OPENSSH PRIVATE KEY-----"],
  ])("Secret im Plugin wird erkannt: %s", (label, secret) => {
    const result = check({ "README.md": `# Demo\n\nkey: ${secret}\n` });
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining(`README.md: enthält vermutlich ein Secret (${label})`)]));
  });
});

describe("Paket-Metadaten", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    engines: { node: string };
    dependencies: Record<string, string>;
  };
  const minMajor = (range: string): number => Number(/(\d+)/.exec(range)?.[1] ?? 0);

  it.each(Object.keys(pkg.dependencies))("engines.node deckt die Mindestversion von %s ab", (name) => {
    const dependency = JSON.parse(readFileSync(join(repoRoot, "node_modules", ...name.split("/"), "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    const required = dependency.engines?.node;
    if (required) {
      expect(minMajor(pkg.engines.node)).toBeGreaterThanOrEqual(minMajor(required));
    }
  });

  it("die laufende Node-Version erfüllt engines.node", () => {
    expect(minMajor(process.versions.node)).toBeGreaterThanOrEqual(minMajor(pkg.engines.node));
  });
});

describe("Validator-Hilfsfunktionen", () => {
  it("parseFrontmatter: gefaltete Zeilen, Anführungszeichen, CRLF und BOM", () => {
    const parsed = parseFrontmatter('\uFEFF---\r\nname: "x"\r\ndescription: erste\r\n  zweite Zeile\r\n# Kommentar\r\n---\r\nText');
    expect(parsed).toEqual({ fields: { name: "x", description: "erste zweite Zeile" }, invalidLines: [] });
    expect(parseFrontmatter("kein frontmatter")).toBeUndefined();
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

  it("parsePackageSpec versteht Scopes", () => {
    expect(parsePackageSpec("acp-agent-bridge@0.1.0")).toEqual({ name: "acp-agent-bridge", version: "0.1.0" });
    expect(parsePackageSpec("@scope/pkg@1.0.0")).toEqual({ name: "@scope/pkg", version: "1.0.0" });
    expect(parsePackageSpec("@scope/pkg")).toEqual({ name: "@scope/pkg", version: undefined });
    expect(parsePackageSpec("pkg")).toEqual({ name: "pkg", version: undefined });
  });
});

describe("Plugin gegen den echten Connector", () => {
  const skill = readFileSync(join(repoRoot, "skills", "delegate-to-coding-agent", "SKILL.md"), "utf8");
  const mcp = JSON.parse(readFileSync(join(repoRoot, "mcp.json"), "utf8")) as {
    mcpServers: Record<string, { env: Record<string, string> }>;
  };
  const pluginEnv = Object.values(mcp.mcpServers)[0].env;
  const clients: ConnectorClient[] = [];

  async function connect(env: Record<string, string>): Promise<ConnectorClient> {
    const client = new ConnectorClient();
    clients.push(client);
    // Wie der Host: nur die Werte aus mcp.json, ohne eigene Connector-Konfiguration.
    await client.connect({ ACP_CONNECTOR_CONFIG: "", ACP_CONNECTOR_DEFAULT_AGENT: "", ...env });
    return client;
  }

  let unset: ConnectorClient;
  beforeAll(async () => {
    // Variable nicht gesetzt: Der Host reicht den Platzhalter unverändert durch.
    unset = await connect(pluginEnv);
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
  });

  it("die Tool-Tabelle im Skill entspricht genau tools/list", async () => {
    const documented = [...skill.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]).sort();
    const offered = (await unset.listToolNames()).sort();
    expect(documented).toEqual(offered);
  });

  it("mcp.json setzt den API-Key-Modus und nur deklarierte Variablen", () => {
    expect(pluginEnv.ACP_CONNECTOR_AUTH_MODE).toBe("api_key");
    expect(pluginEnv.ANTHROPIC_API_KEY).toBe("${ANTHROPIC_API_KEY}");
  });

  it("nicht gesetzte Plugin-Variable: verständlicher Hinweis statt Fehlstart", async () => {
    const status = await unset.call<AuthStatusResult>("auth_status", {});
    expect(status.data.auth_mode).toBe("api_key");
    expect(status.data.credentials.anthropic_api_key_set).toBe(false);
    expect(status.data.problem).toMatch(/Plugin-Einstellungen/);

    const session = await unset.call("start_session", { cwd: repoRoot });
    expect(session.isError).toBe(true);
    expect(session.text).toMatch(/Plugin-Einstellungen \(Variable ANTHROPIC_API_KEY\)/);
  });

  it("gesetzte Plugin-Variable wird erkannt, ohne sie auszugeben", async () => {
    const key = "sk-test-not-a-real-key-123456";
    const client = await connect({ ...pluginEnv, ANTHROPIC_API_KEY: key });
    const status = await client.call<AuthStatusResult>("auth_status", { probe: false });
    expect(status.data.credentials.anthropic_api_key_set).toBe(true);
    expect(status.data.hide_claude_auth).toBe(true);
    expect(status.data.problem).toBeNull();
    expect(status.text).not.toContain(key);
  });
});
