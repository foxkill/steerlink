// Bundles the session view (ui/session-view) into one self-contained HTML
// file: dist/ui/session-view.html. Hosts render it in a sandboxed iframe, so
// it must not load anything from outside.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { build } from "esbuild";

const ROOT = join(import.meta.dirname, "..");
const SOURCE = join(ROOT, "ui", "session-view");
export const SESSION_VIEW_OUTPUT = join(ROOT, "dist", "ui", "session-view.html");
const PLACEHOLDER = "<!-- steerlink:script -->";

export async function buildUi(): Promise<void> {
    const result = await build({
        entryPoints: [join(SOURCE, "main.ts")],
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "es2022",
        minify: true,
        legalComments: "none",
        write: false,
        logLevel: "silent",
    });
    const script = result.outputFiles[0]?.text;
    if (script === undefined) {
        throw new Error("esbuild produced no output for the session view");
    }
    const template = readFileSync(join(SOURCE, "index.html"), "utf8");
    if (!template.includes(PLACEHOLDER)) {
        throw new Error(`ui/session-view/index.html lacks ${PLACEHOLDER}`);
    }
    // "</script" inside the code would end the inline script early.
    const inline = script.replaceAll("</script", String.raw`<\/script`);
    const html = template.replace(PLACEHOLDER, () => `<script type="module">${inline}</script>`);
    mkdirSync(dirname(SESSION_VIEW_OUTPUT), { recursive: true });
    writeFileSync(SESSION_VIEW_OUTPUT, html);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
    await buildUi();
    console.error(`Built ${SESSION_VIEW_OUTPUT}`);
}
