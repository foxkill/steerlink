/**
 * Checks the plugin (Cursor plugin format, as adopted by the Grok Bot
 * marketplace) before a submission.
 *
 * Based on the submission checklist at https://cursor.com/docs/reference/plugins
 * plus rules specific to this repo: mcp.json starts exactly the version from
 * package.json, manifest and package have the same version and license, and the
 * plugin files contain no secrets.
 *
 * Usage: npm run validate:plugin [-- <plugin-directory>]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, posix, relative, resolve } from "node:path";

export interface ValidationResult {
    errors: string[];
    warnings: string[];
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const PLUGIN_NAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** Rule by which Grok Bot accepts MCP server names (`server__tool`). */
const MCP_SERVER_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const PLACEHOLDER = /\$\{([^}]*)\}/g;
/** Placeholders the host replaces itself (the plugin's install path). */
const HOST_PLACEHOLDERS = new Set(["CURSOR_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"]);

/** Fields from the Cursor reference; `displayName` is used by Cursor's official plugin template. */
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

/** JSON Schema keywords that Cursor accepts in `variables`. */
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
    { label: "Anthropic key", pattern: /sk-ant-[A-Za-z0-9_-]{16,}/ },
    { label: "OpenAI key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/ },
    { label: "xAI key", pattern: /\bxai-[A-Za-z0-9]{32,}/ },
    { label: "GitHub token", pattern: /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/ },
    { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
    { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
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

/** Relative, without `..` and without absolute prefixes (Cursor's checklist). */
export function isSafeRelativePath(value: string): boolean {
    if (
        value.length === 0 ||
        isAbsolute(value) ||
        /^[A-Za-z]:/.test(value) ||
        value.startsWith("/") ||
        value.startsWith("\\")
    ) {
        return false;
    }
    const normalized = posix.normalize(value.replaceAll("\\", "/"));
    return normalized !== ".." && !normalized.startsWith("../");
}

/** JSON.parse always returns Json; this guard makes that visible to the compiler. */
function toJson(value: unknown): Json {
    if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => toJson(entry));
    }
    if (typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJson(entry)]));
    }
    throw new TypeError(`Not a JSON value: ${typeof value}`);
}

/** Short form of a JSON value for messages. */
function show(value: Json | undefined): string {
    if (value === undefined) {
        return "(missing)";
    }
    return typeof value === "string" ? value : JSON.stringify(value);
}

function readJson(path: string, label: string, result: ValidationResult): Json | undefined {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch {
        result.errors.push(`${label} is missing: ${path}`);
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(text);
        return toJson(parsed);
    } catch (error) {
        result.errors.push(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

/**
 * Minimal parser for YAML frontmatter made of `key: value` lines.
 * Indented continuation lines are appended to the previous value (folded description).
 * Returns `undefined` if there is no frontmatter block.
 */
export function parseFrontmatter(
    content: string,
): { fields: Record<string, string>; invalidLines: string[] } | undefined {
    const text = content.replace(/^﻿/, "").replaceAll("\r\n", "\n");
    if (!text.startsWith("---\n")) {
        return undefined;
    }
    // Only a line consisting of exactly `---` closes the block (not, say, `---more`).
    const close = /\n---[ \t]*(?:\n|$)/.exec(text.slice(3));
    if (!close) {
        return undefined;
    }
    const end = close.index + 3;
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
        const [, key, rawValue = ""] = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(line) ?? [];
        if (key === undefined) {
            invalidLines.push(line);
            continue;
        }
        lastKey = key;
        // YAML block scalar (`>`, `|`, `>-` …): the content follows in the indented lines.
        const value = rawValue.trim();
        fields[key] = /^[>|][+-]?$/.test(value) ? "" : unquote(value);
    }
    return { fields, invalidLines };
}

function unquote(value: string): string {
    if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
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
            result.errors.push(`plugin.json: unknown field "${key}"`);
        }
    }

    if (typeof manifest.name !== "string" || !PLUGIN_NAME.test(manifest.name)) {
        result.errors.push(
            'plugin.json: "name" must be lowercase (a-z, 0-9, "-", ".") and start and end with a letter or digit',
        );
    }
    if (typeof manifest.description !== "string" || manifest.description.trim().length === 0) {
        result.errors.push('plugin.json: "description" is missing');
    }
    if (
        manifest.displayName !== undefined &&
        (typeof manifest.displayName !== "string" || manifest.displayName.trim().length === 0)
    ) {
        result.errors.push('plugin.json: "displayName" must be a non-empty string');
    }
    if (manifest.version === undefined) {
        result.warnings.push('plugin.json: "version" is missing');
    } else if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) {
        result.errors.push('plugin.json: "version" must be a SemVer version (e.g. 1.0.0)');
    }
    if (manifest.author !== undefined) {
        if (
            !isObject(manifest.author) ||
            typeof manifest.author.name !== "string" ||
            manifest.author.name.trim().length === 0
        ) {
            result.errors.push('plugin.json: "author.name" is missing');
        } else if (
            manifest.author.email !== undefined &&
            (typeof manifest.author.email !== "string" || !manifest.author.email.includes("@"))
        ) {
            result.errors.push('plugin.json: "author.email" is not an email address');
        }
    }
    for (const field of ["homepage", "repository"] as const) {
        const value = manifest[field];
        if (value !== undefined && (typeof value !== "string" || !isHttpsUrl(value))) {
            result.errors.push(`plugin.json: "${field}" must be an https URL`);
        }
    }
    if (manifest.keywords !== undefined && !isStringArray(manifest.keywords)) {
        result.errors.push('plugin.json: "keywords" must be a string array');
    }
    if (manifest.license === undefined || manifest.license === "UNLICENSED") {
        result.warnings.push(
            'plugin.json: no open-source license ("license" is missing or UNLICENSED). Choose a license such as MIT for a public plugin.',
        );
    } else if (typeof manifest.license !== "string") {
        result.errors.push('plugin.json: "license" must be a string');
    }

    for (const field of PATH_FIELDS) {
        for (const value of pathValues(manifest[field])) {
            if (field === "logo" && /^https?:\/\//.test(value)) {
                if (!/^https:\/\/(?:raw|user-images)\.githubusercontent\.com\//.test(value)) {
                    result.errors.push(
                        `plugin.json: an absolute logo URL must point to GitHub user content, not to "${value}"`,
                    );
                }
                continue;
            }
            if (!isSafeRelativePath(value)) {
                result.errors.push(
                    `plugin.json: "${field}" has an invalid path "${value}" (must be relative, without "..")`,
                );
            } else if (!existsSync(resolve(root, value))) {
                result.errors.push(`plugin.json: "${field}" points to a missing path "${value}"`);
            }
        }
    }

    if (
        typeof manifest.logo === "string" &&
        extname(manifest.logo).toLowerCase() === ".svg" &&
        isSafeRelativePath(manifest.logo)
    ) {
        const logoPath = resolve(root, manifest.logo);
        if (existsSync(logoPath)) {
            validateSvgLogo(readFileSync(logoPath, "utf8"), result);
        }
    } else if (manifest.logo === undefined) {
        result.warnings.push('plugin.json: no "logo" (the submission form requires a 1:1 logo)');
    }

    if (manifest.variables !== undefined) {
        validateVariablesSchema(manifest.variables, result);
    }
}

function validateSvgLogo(svg: string, result: ValidationResult): void {
    const open = /<svg\b[^>]*>/i.exec(svg)?.[0];
    if (!open) {
        result.errors.push("Logo: no <svg> element");
        return;
    }
    const viewBox = /\bviewBox="\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/i.exec(open);
    if (!viewBox) {
        result.errors.push("Logo: viewBox is missing");
        return;
    }
    const width = Number(viewBox[3]);
    const height = Number(viewBox[4]);
    if (width !== height) {
        result.errors.push(`Logo: must be square (viewBox ${width}x${height})`);
    }
    const plate = [...svg.matchAll(/<rect\b[^>]*>/gi)].some((match) => {
        const tag = match[0];
        // Whitespace instead of \b before it, otherwise `width=` would also match `stroke-width=`.
        const covers = (attribute: string, size: number): boolean => {
            const value = new RegExp(`\\s${attribute}="\\s*([\\d.]+%?)\\s*"`).exec(tag)?.[1];
            return value === "100%" || Number(value) === size;
        };
        return covers("width", width) && covers("height", height) && /\sfill="(?!none)[^"]+"/.test(tag);
    });
    if (!plate) {
        result.errors.push(
            "Logo: needs a filled background covering the entire viewBox (required by the submission form)",
        );
    }
    if (/<script\b/i.test(svg) || /\bon[a-z]+\s*=/i.test(svg)) {
        result.errors.push("Logo: SVG must not contain scripts or event handlers");
    }
    if (/\b(?:xlink:)?href\s*=\s*"(?!#)/i.test(svg)) {
        result.errors.push("Logo: SVG must not load external resources");
    }
}

function validateVariablesSchema(schema: Json, result: ValidationResult): void {
    if (!isObject(schema) || schema.type !== "object" || !isObject(schema.properties)) {
        result.errors.push('plugin.json: "variables" must be { "type": "object", "properties": { ... } }');
        return;
    }
    const visit = (node: Json, path: string): void => {
        if (!isObject(node)) {
            return;
        }
        for (const [key, value] of Object.entries(node)) {
            if (!VARIABLE_SCHEMA_KEYWORDS.has(key)) {
                result.errors.push(`plugin.json: ${path}.${key} is not an allowed keyword in "variables"`);
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
            result.warnings.push(
                `plugin.json: variable "${name}" should be named like an environment variable (A-Z, 0-9, _)`,
            );
        }
        if (
            !isObject(property) ||
            typeof property.description !== "string" ||
            property.description.trim().length === 0
        ) {
            result.errors.push(`plugin.json: variable "${name}" needs a "description"`);
        }
    }
    if (schema.required !== undefined) {
        if (isStringArray(schema.required)) {
            for (const name of schema.required) {
                if (!(name in schema.properties)) {
                    result.errors.push(`plugin.json: "variables.required" names unknown variable "${name}"`);
                }
            }
        } else {
            result.errors.push('plugin.json: "variables.required" must be a string array');
        }
    }
}

// ------------------------------------------------------------------ mcp.json

function collectPlaceholders(value: Json, found: Set<string>): void {
    if (typeof value === "string") {
        for (const [, name] of value.matchAll(PLACEHOLDER)) {
            if (name !== undefined) {
                found.add(name);
            }
        }
    } else if (Array.isArray(value)) {
        value.forEach((entry) => {
            collectPlaceholders(entry, found);
        });
    } else if (isObject(value)) {
        Object.values(value).forEach((entry) => {
            collectPlaceholders(entry, found);
        });
    }
}

function validateMcpConfig(
    mcp: Json,
    manifest: JsonObject,
    packageJson: JsonObject | undefined,
    result: ValidationResult,
): void {
    if (!isObject(mcp) || !isObject(mcp.mcpServers) || Object.keys(mcp.mcpServers).length === 0) {
        result.errors.push('mcp.json: "mcpServers" must be an object with at least one server');
        return;
    }

    for (const [name, server] of Object.entries(mcp.mcpServers)) {
        const label = `mcp.json: server "${name}"`;
        if (!MCP_SERVER_NAME.test(name) || name.includes("__")) {
            result.errors.push(
                `${label}: name may only contain letters, digits, "_" and "-", must not contain "__", and must start with a letter or "_"`,
            );
        }
        if (!isObject(server)) {
            result.errors.push(`${label}: must be an object`);
            continue;
        }
        const hasCommand = server.command !== undefined;
        const hasUrl = server.url !== undefined;
        if (hasCommand === hasUrl) {
            result.errors.push(`${label}: needs exactly one of "command" (stdio) or "url" (HTTP)`);
            continue;
        }
        const allowed = hasCommand ? MCP_STDIO_FIELDS : MCP_REMOTE_FIELDS;
        for (const key of Object.keys(server)) {
            if (!allowed.has(key)) {
                result.errors.push(`${label}: field "${key}" does not fit a ${hasCommand ? "stdio" : "HTTP"} server`);
            }
        }
        if (hasCommand) {
            validateStdioServer(label, server, packageJson, result);
        } else if (typeof server.url !== "string" || !isHttpsUrl(server.url)) {
            result.errors.push(`${label}: "url" must be an https URL`);
        }
        for (const field of ["env", "headers"] as const) {
            const record = server[field];
            if (
                record !== undefined &&
                (!isObject(record) || !Object.values(record).every((value) => typeof value === "string"))
            ) {
                result.errors.push(`${label}: "${field}" must be an object with string values`);
            }
        }
    }

    const used = new Set<string>();
    collectPlaceholders(mcp, used);
    const declared =
        isObject(manifest.variables) && isObject(manifest.variables.properties)
            ? Object.keys(manifest.variables.properties)
            : [];
    for (const name of used) {
        if (!HOST_PLACEHOLDERS.has(name) && !declared.includes(name)) {
            result.errors.push(`mcp.json: placeholder \${${name}} is not declared in plugin.json "variables"`);
        }
    }
    for (const name of declared) {
        if (!used.has(name)) {
            result.warnings.push(`plugin.json: variable "${name}" is not used in mcp.json`);
        }
    }
}

/** Splits `name@version` or `@scope/name@version`. */
export function parsePackageSpec(spec: string): { name: string; version: string | undefined } {
    const at = spec.lastIndexOf("@");
    if (at <= 0) {
        return { name: spec, version: undefined };
    }
    return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

function validateStdioServer(
    label: string,
    server: JsonObject,
    packageJson: JsonObject | undefined,
    result: ValidationResult,
): void {
    if (typeof server.command !== "string" || server.command.trim().length === 0) {
        result.errors.push(`${label}: "command" must be a non-empty string`);
        return;
    }
    const args = server.args ?? [];
    if (!isStringArray(args)) {
        result.errors.push(`${label}: "args" must be a string array`);
        return;
    }
    if ((isAbsolute(server.command) || /^[A-Za-z]:[\\/]/.test(server.command)) && !server.command.startsWith("${")) {
        result.errors.push(`${label}: "command" must not be an absolute path`);
    }
    if (server.command !== "npx") {
        return;
    }

    const spec = args.find((arg) => !arg.startsWith("-"));
    if (!args.includes("-y") && !args.includes("--yes")) {
        result.errors.push(`${label}: npx needs "-y", otherwise it waits for confirmation on first start`);
    }
    if (!spec) {
        result.errors.push(`${label}: npx without a package`);
        return;
    }
    const { name, version } = parsePackageSpec(spec);
    if (!version || !SEMVER.test(version)) {
        result.errors.push(
            `${label}: "${spec}" must be pinned to an exact version (e.g. ${name}@1.2.3), not a range or "latest"`,
        );
        return;
    }
    if (packageJson) {
        if (name !== packageJson.name) {
            result.errors.push(`${label}: starts "${name}", but the repo builds "${show(packageJson.name)}"`);
        } else if (version !== packageJson.version) {
            result.errors.push(
                `${label}: starts ${name}@${version}, but package.json has version ${show(packageJson.version)}`,
            );
        }
    }
}

// ---------------------------------------------------------------- Components

function validateMarkdownComponents(
    root: string,
    dirs: string[],
    kind: string,
    extensions: Set<string>,
    rules: FrontmatterRules,
    result: ValidationResult,
): void {
    for (const dir of dirs) {
        const absolute = resolve(root, dir);
        if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
            continue;
        }
        for (const file of listFiles(absolute)) {
            if (extensions.has(extname(file).toLowerCase())) {
                validateFrontmatterFile(root, file, kind, rules, result);
            }
        }
    }
}

/**
 * `required`: a missing field is an error. `recommended`: a missing field is a warning.
 * `optional`: a file without frontmatter is allowed (commands, per Cursor).
 */
interface FrontmatterRules {
    required?: string[];
    recommended?: string[];
    optional?: boolean;
}

function validateFrontmatterFile(
    root: string,
    file: string,
    kind: string,
    rules: FrontmatterRules,
    result: ValidationResult,
): Record<string, string> | undefined {
    const label = `${kind} ${relative(root, file).replaceAll("\\", "/")}`;
    const parsed = parseFrontmatter(readFileSync(file, "utf8"));
    if (!parsed) {
        if (!rules.optional) {
            result.errors.push(`${label}: YAML frontmatter is missing`);
        }
        return undefined;
    }
    for (const line of parsed.invalidLines) {
        result.errors.push(`${label}: invalid frontmatter line "${line}"`);
    }
    for (const key of rules.required ?? []) {
        if (!parsed.fields[key]) {
            result.errors.push(`${label}: "${key}" is missing from the frontmatter`);
        }
    }
    for (const key of rules.recommended ?? []) {
        if (!parsed.fields[key]) {
            result.warnings.push(`${label}: "${key}" is missing from the frontmatter (recommended)`);
        }
    }
    return parsed.fields;
}

function validateSkills(root: string, manifest: JsonObject, result: ValidationResult): void {
    const dirs = manifest.skills === undefined ? ["skills"] : pathValues(manifest.skills);
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
                result.errors.push(`Skill ${dir}/${entry.name}: SKILL.md is missing`);
                continue;
            }
            count += 1;
            const fields = validateFrontmatterFile(
                root,
                skillFile,
                "Skill",
                { required: ["name", "description"] },
                result,
            );
            if (!fields) {
                continue;
            }
            if (fields.name && (!KEBAB_CASE.test(fields.name) || fields.name.length > 64)) {
                result.errors.push(
                    `Skill ${entry.name}: "name" must be kebab-case and at most 64 characters long (Agent Skills specification)`,
                );
            }
            if (fields.name && fields.name !== entry.name) {
                result.errors.push(
                    `Skill ${entry.name}: "name" (${fields.name}) must match the folder name (Agent Skills specification)`,
                );
            }
            if (fields.description && fields.description.length > 1024) {
                result.errors.push(
                    `Skill ${entry.name}: "description" is longer than 1024 characters (Agent Skills specification)`,
                );
            }
        }
    }
    if (count === 0) {
        result.warnings.push("No skills found");
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
                result.errors.push(
                    `${relative(root, file).replaceAll("\\", "/")}: probably contains a secret (${label})`,
                );
            }
        }
    }
}

// --------------------------------------------------------------- Entry point

/** Checks the plugin in directory `root` (repo root containing `.cursor-plugin/plugin.json`). */
export function validatePlugin(root: string): ValidationResult {
    const result: ValidationResult = { errors: [], warnings: [] };
    const manifest = readJson(join(root, ".cursor-plugin", "plugin.json"), ".cursor-plugin/plugin.json", result);
    if (manifest === undefined) {
        return result;
    }
    if (!isObject(manifest)) {
        result.errors.push(".cursor-plugin/plugin.json must be a JSON object");
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
            result.errors.push(
                `plugin.json has version ${show(manifest.version)}, but package.json has ${show(packageJson.version)}`,
            );
        }
        if (manifest.license !== packageJson.license) {
            result.errors.push(
                `plugin.json has license ${show(manifest.license)}, but package.json has ${show(packageJson.license)}`,
            );
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
                result.warnings.push("No mcp.json (only needed if the plugin ships MCP servers)");
            }
            continue;
        }
        const mcp = readJson(absolute, mcpPath, result);
        if (mcp !== undefined) {
            validateMcpConfig(mcp, manifest, packageJson, result);
        }
    }

    validateSkills(root, manifest, result);
    const markdown = new Set([".md", ".mdc", ".markdown"]);
    validateMarkdownComponents(
        root,
        pathValues(manifest.rules ?? "rules"),
        "Rule",
        markdown,
        { recommended: ["description"] },
        result,
    );
    validateMarkdownComponents(
        root,
        pathValues(manifest.agents ?? "agents"),
        "Agent",
        markdown,
        { required: ["name", "description"] },
        result,
    );
    validateMarkdownComponents(
        root,
        pathValues(manifest.commands ?? "commands"),
        "Command",
        new Set([...markdown, ".txt"]),
        { recommended: ["name", "description"], optional: true },
        result,
    );

    const readme = join(root, "README.md");
    if (!existsSync(readme) || readFileSync(readme, "utf8").trim().length === 0) {
        result.errors.push("README.md is missing or empty (the checklist requires usage and configuration docs)");
    } else if (packageJson && typeof packageJson.name === "string") {
        const escaped = packageJson.name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
        for (const match of readFileSync(readme, "utf8").matchAll(
            new RegExp(`${escaped}@(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?)`, "g"),
        )) {
            if (match[1] !== packageJson.version) {
                result.errors.push(
                    `README.md mentions ${match[0]}, but package.json has version ${show(packageJson.version)}`,
                );
            }
        }
    }

    const pluginFiles = [
        join(root, ".cursor-plugin", "plugin.json"),
        readme,
        ...mcpPaths.map((path) => resolve(root, path)),
    ];
    const scanPaths = new Set(["skills", "rules", "agents", "commands", "assets", "docs"]);
    for (const field of ["rules", "agents", "skills", "commands", "hooks"] as const) {
        for (const path of pathValues(manifest[field])) {
            if (isSafeRelativePath(path)) {
                scanPaths.add(path);
            }
        }
    }
    for (const path of scanPaths) {
        const absolute = resolve(root, path);
        if (existsSync(absolute)) {
            pluginFiles.push(...(statSync(absolute).isDirectory() ? listFiles(absolute) : [absolute]));
        }
    }
    scanForSecrets(root, pluginFiles, result);

    return result;
}

function main(): void {
    const root = resolve(process.argv[2] ?? process.cwd());
    const { errors, warnings } = validatePlugin(root);
    for (const warning of warnings) {
        console.log(`Warning: ${warning}`);
    }
    for (const error of errors) {
        console.error(`Error: ${error}`);
    }
    if (errors.length > 0) {
        console.error(`\nPlugin check failed (${errors.length} error${errors.length === 1 ? "" : "s"}).`);
        process.exit(1);
    }
    console.log(
        `Plugin check passed${warnings.length > 0 ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""}.`,
    );
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
    main();
}
