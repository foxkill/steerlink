/**
 * Prüft das Plugin (Cursor-Plugin-Format, wie es der Grok-Bot-Marktplatz
 * übernimmt) vor einer Einreichung.
 *
 * Grundlage ist die Submission-Checkliste aus https://cursor.com/docs/reference/plugins
 * plus Regeln, die für dieses Repo gelten: mcp.json startet genau die Version
 * aus package.json, Manifest und Paket haben dieselbe Version und Lizenz, und in
 * den Plugin-Dateien steht kein Secret.
 *
 * Aufruf: npm run validate:plugin [-- <plugin-verzeichnis>]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const PLUGIN_NAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** Regel, nach der Grok Bot MCP-Servernamen zulässt (`server__tool`). */
const MCP_SERVER_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const PLACEHOLDER = /\$\{([^}]*)\}/g;
/** Platzhalter, die der Host selbst ersetzt (Installationspfad des Plugins). */
const HOST_PLACEHOLDERS = new Set(["CURSOR_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"]);

const MANIFEST_FIELDS = new Set([
  "name",
  "displayName",
  "description",
  "version",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "logo",
  "rules",
  "agents",
  "skills",
  "commands",
  "hooks",
  "mcpServers",
  "variables",
]);
const PATH_FIELDS = ["logo", "rules", "agents", "skills", "commands", "hooks", "mcpServers"] as const;

/** JSON-Schema-Schlüsselwörter, die Cursor in `variables` akzeptiert. */
const VARIABLE_SCHEMA_KEYWORDS = new Set([
  "type",
  "title",
  "description",
  "default",
  "enum",
  "const",
  "properties",
  "required",
  "items",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
]);

const MCP_STDIO_FIELDS = new Set(["type", "command", "args", "env", "cwd"]);
const MCP_REMOTE_FIELDS = new Set(["type", "url", "headers"]);

const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "Anthropic-Key", pattern: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  { label: "OpenAI-Key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { label: "xAI-Key", pattern: /\bxai-[A-Za-z0-9]{32,}/ },
  { label: "GitHub-Token", pattern: /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/ },
  { label: "AWS-Access-Key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "privater Schlüssel", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const TEXT_EXTENSIONS = new Set([".json", ".md", ".mdc", ".markdown", ".txt", ".svg", ".yml", ".yaml"]);

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: Json | undefined): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Relativ, ohne `..` und ohne absolute Präfixe (Checkliste von Cursor). */
export function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith("/") || value.startsWith("\\")) {
    return false;
  }
  const normalized = posix.normalize(value.replace(/\\/g, "/"));
  return normalized !== ".." && !normalized.startsWith("../");
}

function readJson(path: string, label: string, result: ValidationResult): Json | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    result.errors.push(`${label} fehlt: ${path}`);
    return undefined;
  }
  try {
    return JSON.parse(text) as Json;
  } catch (error) {
    result.errors.push(`${label} ist kein gültiges JSON: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Minimaler Parser für YAML-Frontmatter aus `schlüssel: wert`-Zeilen.
 * Eingerückte Folgezeilen hängen am vorigen Wert (gefaltete Beschreibung).
 * Gibt `undefined` zurück, wenn kein Frontmatter-Block vorhanden ist.
 */
export function parseFrontmatter(content: string): { fields: Record<string, string>; invalidLines: string[] } | undefined {
  const text = content.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    return undefined;
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return undefined;
  }
  const fields: Record<string, string> = {};
  const invalidLines: string[] = [];
  let lastKey: string | undefined;
  for (const line of text.slice(4, end).split("\n")) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      continue;
    }
    if (/^\s/.test(line) && lastKey) {
      fields[lastKey] = `${fields[lastKey]} ${line.trim()}`.trim();
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(line);
    if (!match) {
      invalidLines.push(line);
      continue;
    }
    lastKey = match[1];
    fields[lastKey] = unquote((match[2] ?? "").trim());
  }
  return { fields, invalidLines };
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function pathValues(value: Json | undefined): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => pathValues(entry));
  }
  return [];
}

// ------------------------------------------------------------------ Manifest

function validateManifest(root: string, manifest: JsonObject, result: ValidationResult): void {
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_FIELDS.has(key)) {
      result.errors.push(`plugin.json: unbekanntes Feld "${key}"`);
    }
  }

  if (typeof manifest.name !== "string" || !PLUGIN_NAME.test(manifest.name)) {
    result.errors.push('plugin.json: "name" muss kleingeschrieben sein (a-z, 0-9, "-", ".") und mit Buchstabe/Ziffer beginnen und enden');
  }
  if (typeof manifest.description !== "string" || manifest.description.trim().length === 0) {
    result.errors.push('plugin.json: "description" fehlt');
  }
  if (manifest.displayName !== undefined && (typeof manifest.displayName !== "string" || manifest.displayName.trim().length === 0)) {
    result.errors.push('plugin.json: "displayName" muss ein nicht leerer String sein');
  }
  if (manifest.version === undefined) {
    result.warnings.push('plugin.json: "version" fehlt');
  } else if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) {
    result.errors.push('plugin.json: "version" muss eine SemVer-Version sein (z. B. 1.0.0)');
  }
  if (manifest.author !== undefined) {
    if (!isObject(manifest.author) || typeof manifest.author.name !== "string" || manifest.author.name.trim().length === 0) {
      result.errors.push('plugin.json: "author.name" fehlt');
    } else if (manifest.author.email !== undefined && (typeof manifest.author.email !== "string" || !manifest.author.email.includes("@"))) {
      result.errors.push('plugin.json: "author.email" ist keine E-Mail-Adresse');
    }
  }
  for (const field of ["homepage", "repository"] as const) {
    const value = manifest[field];
    if (value !== undefined && (typeof value !== "string" || !isHttpsUrl(value))) {
      result.errors.push(`plugin.json: "${field}" muss eine https-URL sein`);
    }
  }
  if (manifest.keywords !== undefined && !isStringArray(manifest.keywords)) {
    result.errors.push('plugin.json: "keywords" muss ein String-Array sein');
  }
  if (manifest.license === undefined || manifest.license === "UNLICENSED") {
    result.warnings.push(
      'plugin.json: keine offene Lizenz ("license" fehlt oder ist UNLICENSED). Für ein öffentliches Plugin eine Lizenz wählen, z. B. MIT.',
    );
  } else if (typeof manifest.license !== "string") {
    result.errors.push('plugin.json: "license" muss ein String sein');
  }

  for (const field of PATH_FIELDS) {
    for (const value of pathValues(manifest[field])) {
      if (field === "logo" && /^https?:\/\//.test(value)) {
        continue;
      }
      if (!isSafeRelativePath(value)) {
        result.errors.push(`plugin.json: "${field}" hat einen unzulässigen Pfad "${value}" (relativ, ohne "..")`);
      } else if (!existsSync(resolve(root, value))) {
        result.errors.push(`plugin.json: "${field}" verweist auf fehlenden Pfad "${value}"`);
      }
    }
  }

  if (typeof manifest.logo === "string" && extname(manifest.logo).toLowerCase() === ".svg" && isSafeRelativePath(manifest.logo)) {
    const logoPath = resolve(root, manifest.logo);
    if (existsSync(logoPath)) {
      validateSvgLogo(readFileSync(logoPath, "utf8"), result);
    }
  } else if (manifest.logo === undefined) {
    result.warnings.push('plugin.json: kein "logo" (das Einreichungsformular verlangt ein 1:1-Logo)');
  }

  if (manifest.variables !== undefined) {
    validateVariablesSchema(manifest.variables, result);
  }
}

function validateSvgLogo(svg: string, result: ValidationResult): void {
  const open = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!open) {
    result.errors.push("Logo: kein <svg>-Element");
    return;
  }
  const viewBox = /\bviewBox="\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/i.exec(open);
  if (!viewBox) {
    result.errors.push("Logo: viewBox fehlt");
    return;
  }
  const width = Number(viewBox[3]);
  const height = Number(viewBox[4]);
  if (width !== height) {
    result.errors.push(`Logo: muss quadratisch sein (viewBox ${width}x${height})`);
  }
  const plate = [...svg.matchAll(/<rect\b[^>]*>/gi)].some((match) => {
    const tag = match[0];
    const w = /\bwidth="([\d.]+)"/.exec(tag)?.[1];
    const h = /\bheight="([\d.]+)"/.exec(tag)?.[1];
    return Number(w) === width && Number(h) === height && /\bfill="(?!none)[^"]+"/.test(tag);
  });
  if (!plate) {
    result.errors.push("Logo: braucht eine gefüllte Hintergrundfläche über die ganze viewBox (Vorgabe des Einreichungsformulars)");
  }
  if (/<script\b/i.test(svg) || /\bon[a-z]+\s*=/i.test(svg)) {
    result.errors.push("Logo: SVG darf kein Skript und keine Event-Handler enthalten");
  }
  if (/\b(?:xlink:)?href\s*=\s*"(?!#)/i.test(svg)) {
    result.errors.push("Logo: SVG darf keine externen Ressourcen laden");
  }
}

function validateVariablesSchema(schema: Json, result: ValidationResult): void {
  if (!isObject(schema) || schema.type !== "object" || !isObject(schema.properties)) {
    result.errors.push('plugin.json: "variables" muss { "type": "object", "properties": { ... } } sein');
    return;
  }
  const visit = (node: Json, path: string): void => {
    if (!isObject(node)) {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (!VARIABLE_SCHEMA_KEYWORDS.has(key)) {
        result.errors.push(`plugin.json: ${path}.${key} ist kein zulässiges Schlüsselwort in "variables"`);
      }
      if (key === "properties" && isObject(value)) {
        for (const [name, child] of Object.entries(value)) {
          visit(child, `${path}.properties.${name}`);
        }
      } else if (key === "items") {
        visit(value, `${path}.items`);
      }
    }
  };
  visit(schema, "variables");

  for (const [name, property] of Object.entries(schema.properties)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      result.errors.push(`plugin.json: Variable "${name}" muss GROSS_GESCHRIEBEN sein (A-Z, 0-9, _)`);
    }
    if (!isObject(property) || typeof property.description !== "string" || property.description.trim().length === 0) {
      result.errors.push(`plugin.json: Variable "${name}" braucht eine "description"`);
    }
  }
  if (schema.required !== undefined) {
    if (!isStringArray(schema.required)) {
      result.errors.push('plugin.json: "variables.required" muss ein String-Array sein');
    } else {
      for (const name of schema.required) {
        if (!(name in schema.properties)) {
          result.errors.push(`plugin.json: "variables.required" nennt unbekannte Variable "${name}"`);
        }
      }
    }
  }
}

// ------------------------------------------------------------------ mcp.json

function collectPlaceholders(value: Json, found: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(PLACEHOLDER)) {
      found.add(match[1]);
    }
  } else if (Array.isArray(value)) {
    value.forEach((entry) => collectPlaceholders(entry, found));
  } else if (isObject(value)) {
    Object.values(value).forEach((entry) => collectPlaceholders(entry, found));
  }
}

function validateMcpConfig(
  mcp: Json,
  manifest: JsonObject,
  packageJson: JsonObject | undefined,
  result: ValidationResult,
): void {
  if (!isObject(mcp) || !isObject(mcp.mcpServers) || Object.keys(mcp.mcpServers).length === 0) {
    result.errors.push('mcp.json: "mcpServers" muss ein Objekt mit mindestens einem Server sein');
    return;
  }

  for (const [name, server] of Object.entries(mcp.mcpServers)) {
    const label = `mcp.json: Server "${name}"`;
    if (!MCP_SERVER_NAME.test(name) || name.includes("__")) {
      result.errors.push(`${label}: Name nur aus Buchstaben, Ziffern, "_" und "-", ohne "__", Beginn mit Buchstabe oder "_"`);
    }
    if (!isObject(server)) {
      result.errors.push(`${label}: muss ein Objekt sein`);
      continue;
    }
    const hasCommand = server.command !== undefined;
    const hasUrl = server.url !== undefined;
    if (hasCommand === hasUrl) {
      result.errors.push(`${label}: braucht genau eines von "command" (stdio) oder "url" (HTTP)`);
      continue;
    }
    const allowed = hasCommand ? MCP_STDIO_FIELDS : MCP_REMOTE_FIELDS;
    for (const key of Object.keys(server)) {
      if (!allowed.has(key)) {
        result.errors.push(`${label}: Feld "${key}" passt nicht zu einem ${hasCommand ? "stdio" : "HTTP"}-Server`);
      }
    }
    if (hasCommand) {
      validateStdioServer(label, server, packageJson, result);
    } else if (typeof server.url !== "string" || !isHttpsUrl(server.url)) {
      result.errors.push(`${label}: "url" muss eine https-URL sein`);
    }
    for (const field of ["env", "headers"] as const) {
      const record = server[field];
      if (record !== undefined && (!isObject(record) || !Object.values(record).every((value) => typeof value === "string"))) {
        result.errors.push(`${label}: "${field}" muss ein Objekt mit String-Werten sein`);
      }
    }
  }

  const used = new Set<string>();
  collectPlaceholders(mcp, used);
  const declared = isObject(manifest.variables) && isObject(manifest.variables.properties) ? Object.keys(manifest.variables.properties) : [];
  for (const name of used) {
    if (!HOST_PLACEHOLDERS.has(name) && !declared.includes(name)) {
      result.errors.push(`mcp.json: Platzhalter \${${name}} ist nicht in plugin.json "variables" deklariert`);
    }
  }
  for (const name of declared) {
    if (!used.has(name)) {
      result.warnings.push(`plugin.json: Variable "${name}" wird in mcp.json nicht verwendet`);
    }
  }
}

/** Zerlegt `name@version` bzw. `@scope/name@version`. */
export function parsePackageSpec(spec: string): { name: string; version: string | undefined } {
  const at = spec.lastIndexOf("@");
  if (at <= 0) {
    return { name: spec, version: undefined };
  }
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

function validateStdioServer(label: string, server: JsonObject, packageJson: JsonObject | undefined, result: ValidationResult): void {
  if (typeof server.command !== "string" || server.command.trim().length === 0) {
    result.errors.push(`${label}: "command" muss ein nicht leerer String sein`);
    return;
  }
  const args = server.args ?? [];
  if (!isStringArray(args)) {
    result.errors.push(`${label}: "args" muss ein String-Array sein`);
    return;
  }
  if (isAbsolute(server.command) && !server.command.startsWith("${")) {
    result.errors.push(`${label}: "command" darf kein absoluter Pfad sein`);
  }
  if (server.command !== "npx") {
    return;
  }

  const spec = args.find((arg) => !arg.startsWith("-"));
  if (!args.includes("-y") && !args.includes("--yes")) {
    result.errors.push(`${label}: npx braucht "-y", sonst wartet es beim ersten Start auf eine Bestätigung`);
  }
  if (!spec) {
    result.errors.push(`${label}: npx ohne Paketangabe`);
    return;
  }
  const { name, version } = parsePackageSpec(spec);
  if (!version || !SEMVER.test(version)) {
    result.errors.push(`${label}: "${spec}" muss auf eine exakte Version festgelegt sein (z. B. ${name}@1.2.3), nicht auf eine Range oder "latest"`);
    return;
  }
  if (packageJson) {
    if (name !== packageJson.name) {
      result.errors.push(`${label}: startet "${name}", das Repo baut aber "${String(packageJson.name)}"`);
    } else if (version !== packageJson.version) {
      result.errors.push(`${label}: startet ${name}@${version}, package.json hat aber Version ${String(packageJson.version)}`);
    }
  }
}

// --------------------------------------------------------------- Komponenten

function validateMarkdownComponents(
  root: string,
  dirs: string[],
  kind: string,
  extensions: Set<string>,
  required: string[],
  result: ValidationResult,
): void {
  for (const dir of dirs) {
    const absolute = resolve(root, dir);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      continue;
    }
    for (const file of listFiles(absolute)) {
      if (extensions.has(extname(file).toLowerCase())) {
        validateFrontmatterFile(root, file, kind, required, result);
      }
    }
  }
}

function validateFrontmatterFile(root: string, file: string, kind: string, required: string[], result: ValidationResult): Record<string, string> | undefined {
  const label = `${kind} ${relative(root, file).replace(/\\/g, "/")}`;
  const parsed = parseFrontmatter(readFileSync(file, "utf8"));
  if (!parsed) {
    result.errors.push(`${label}: YAML-Frontmatter fehlt`);
    return undefined;
  }
  for (const line of parsed.invalidLines) {
    result.errors.push(`${label}: ungültige Frontmatter-Zeile "${line}"`);
  }
  for (const key of required) {
    if (!parsed.fields[key]) {
      result.errors.push(`${label}: "${key}" fehlt im Frontmatter`);
    }
  }
  return parsed.fields;
}

function validateSkills(root: string, manifest: JsonObject, result: ValidationResult): void {
  const dirs = manifest.skills !== undefined ? pathValues(manifest.skills) : ["skills"];
  let count = 0;
  for (const dir of dirs) {
    const absolute = resolve(root, dir);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      continue;
    }
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillFile = join(absolute, entry.name, "SKILL.md");
      if (!existsSync(skillFile)) {
        result.errors.push(`Skill ${dir}/${entry.name}: SKILL.md fehlt`);
        continue;
      }
      count += 1;
      const fields = validateFrontmatterFile(root, skillFile, "Skill", ["name", "description"], result);
      if (!fields) {
        continue;
      }
      if (fields.name && (!KEBAB_CASE.test(fields.name) || fields.name.length > 64)) {
        result.errors.push(`Skill ${entry.name}: "name" muss kebab-case und höchstens 64 Zeichen lang sein`);
      }
      if (fields.name && fields.name !== entry.name) {
        result.errors.push(`Skill ${entry.name}: "name" (${fields.name}) muss dem Ordnernamen entsprechen`);
      }
      if (fields.description && fields.description.length > 1024) {
        result.errors.push(`Skill ${entry.name}: "description" ist länger als 1024 Zeichen`);
      }
    }
  }
  if (count === 0) {
    result.warnings.push("Keine Skills gefunden");
  }
}

function scanForSecrets(root: string, files: string[], result: ValidationResult): void {
  for (const file of files) {
    if (!existsSync(file) || !TEXT_EXTENSIONS.has(extname(file).toLowerCase())) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    for (const { label, pattern } of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        result.errors.push(`${relative(root, file).replace(/\\/g, "/")}: enthält vermutlich ein Secret (${label})`);
      }
    }
  }
}

// ---------------------------------------------------------------- Einstieg

/** Prüft das Plugin im Verzeichnis `root` (Repo-Wurzel mit `.cursor-plugin/plugin.json`). */
export function validatePlugin(root: string): ValidationResult {
  const result: ValidationResult = { errors: [], warnings: [] };
  const manifest = readJson(join(root, ".cursor-plugin", "plugin.json"), ".cursor-plugin/plugin.json", result);
  if (manifest === undefined) {
    return result;
  }
  if (!isObject(manifest)) {
    result.errors.push(".cursor-plugin/plugin.json muss ein JSON-Objekt sein");
    return result;
  }

  let packageJson: JsonObject | undefined;
  if (existsSync(join(root, "package.json"))) {
    const parsed = readJson(join(root, "package.json"), "package.json", result);
    packageJson = isObject(parsed) ? parsed : undefined;
  }

  validateManifest(root, manifest, result);

  if (packageJson) {
    if (manifest.version !== packageJson.version) {
      result.errors.push(`plugin.json hat Version ${String(manifest.version)}, package.json aber ${String(packageJson.version)}`);
    }
    if (manifest.license !== packageJson.license) {
      result.errors.push(`plugin.json hat Lizenz ${String(manifest.license)}, package.json aber ${String(packageJson.license)}`);
    }
  }

  const mcpPaths = manifest.mcpServers === undefined ? ["mcp.json"] : pathValues(manifest.mcpServers);
  if (isObject(manifest.mcpServers)) {
    validateMcpConfig({ mcpServers: manifest.mcpServers }, manifest, packageJson, result);
  }
  for (const mcpPath of mcpPaths) {
    const absolute = resolve(root, mcpPath);
    if (!isSafeRelativePath(mcpPath) || !existsSync(absolute)) {
      if (manifest.mcpServers === undefined) {
        result.warnings.push("Keine mcp.json (nur nötig, wenn das Plugin MCP-Server mitbringt)");
      }
      continue;
    }
    const mcp = readJson(absolute, mcpPath, result);
    if (mcp !== undefined) {
      validateMcpConfig(mcp, manifest, packageJson, result);
    }
  }

  validateSkills(root, manifest, result);
  validateMarkdownComponents(root, pathValues(manifest.rules ?? "rules"), "Regel", new Set([".md", ".mdc", ".markdown"]), ["description"], result);
  validateMarkdownComponents(root, pathValues(manifest.agents ?? "agents"), "Agent", new Set([".md", ".mdc", ".markdown"]), ["name", "description"], result);
  validateMarkdownComponents(
    root,
    pathValues(manifest.commands ?? "commands"),
    "Command",
    new Set([".md", ".mdc", ".markdown", ".txt"]),
    ["name", "description"],
    result,
  );

  const readme = join(root, "README.md");
  if (!existsSync(readme) || readFileSync(readme, "utf8").trim().length === 0) {
    result.errors.push("README.md fehlt oder ist leer (die Checkliste verlangt Nutzung und Konfiguration)");
  } else if (packageJson && typeof packageJson.name === "string") {
    const escaped = packageJson.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const match of readFileSync(readme, "utf8").matchAll(new RegExp(`${escaped}@(\\d[\\w.+-]*)`, "g"))) {
      if (match[1] !== packageJson.version) {
        result.errors.push(`README.md nennt ${match[0]}, package.json hat aber Version ${String(packageJson.version)}`);
      }
    }
  }

  const pluginFiles = [join(root, ".cursor-plugin", "plugin.json"), readme, ...mcpPaths.map((path) => resolve(root, path))];
  for (const dir of ["skills", "rules", "agents", "commands", "assets"]) {
    const absolute = join(root, dir);
    if (existsSync(absolute) && statSync(absolute).isDirectory()) {
      pluginFiles.push(...listFiles(absolute));
    }
  }
  scanForSecrets(root, pluginFiles, result);

  return result;
}

function main(): void {
  const root = resolve(process.argv[2] ?? process.cwd());
  const { errors, warnings } = validatePlugin(root);
  for (const warning of warnings) {
    console.log(`Warnung: ${warning}`);
  }
  for (const error of errors) {
    console.error(`Fehler: ${error}`);
  }
  if (errors.length > 0) {
    console.error(`\nPlugin-Prüfung fehlgeschlagen (${errors.length} Fehler).`);
    process.exit(1);
  }
  console.log(`Plugin-Prüfung bestanden${warnings.length > 0 ? ` (${warnings.length} Warnungen)` : ""}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
