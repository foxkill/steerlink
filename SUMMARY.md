# Summary

## What the project is

`steerlink` (repo `grokbot-acp-connector`) is an MCP server (stdio, TypeScript, Node ≥ 20.19) that lets an MCP
host such as Grok Bot drive coding agents, the way Zed does as an ACP client. Upstream it speaks MCP; downstream it
starts `@agentclientprotocol/claude-agent-acp` (or other ACP agents such as codex-acp) as a subprocess.

The repo is also a plugin in the Cursor plugin format, which the Grok Bot marketplace adopts. How to submit it and
what still needs to be decided first is described in `docs/marketplace-submission.md`.

## Structure

| Part | Files |
|---|---|
| Server | `src/` (MCP tools, sessions, permissions, auth rules) |
| Plugin | `.cursor-plugin/plugin.json` (variable `ANTHROPIC_API_KEY`), `mcp.json` (`npx -y steerlink@<version>`, `api_key` mode), `skills/delegate-to-coding-agent/SKILL.md`, `assets/logo.svg` |
| Checks | `scripts/validate-plugin.ts`, `test/`, `test/e2e/`, `.github/workflows/ci.yml` |

## Plugin work status (2026-10-19)

- **Plugin scaffold** follows <https://cursor.com/docs/reference/plugins>; also checked against the validator from
  Cursor's official plugin template (passed).
- **Skill** for Grok Bot: workflow, polling and, above all: present every permission request to the user as a
  question with the diff, never decide on the user's behalf, never ask for keys in the chat.
- **Name and version** come from `package.json` in one place (MCP server, ACP client, startup message).
- **Unexpanded plugin placeholders** (`${ANTHROPIC_API_KEY}` when the user has not set the variable) count as unset,
  never reach the agent, and produce a clear message ("enter it in the plugin settings").
- **npm package** prepared: only `dist/**/*.js`, `bin`, build in `prepack`, `prepublishOnly` with all checks;
  MIT license; `private: true` until the name is final and the package is published.
- **Node:** `engines.node` is `>=20.19`, because Grok Bot's computer ships Node 20. `claude-agent-acp` declares
  Node ≥ 22 but runs on Node 20 (full end-to-end flow verified on 20.20; CI tests Node 20); a test pins this exception
  against all dependencies from now on.

## Code quality and tooling

- TypeScript 7 with the strictest options (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `noImplicitOverride` …); `tsconfig.json` for the whole project, `tsconfig.build.json` for `src/`.
- oxlint with type-aware rules (`oxlint-tsgolint`) and oxfmt (4 spaces); both run in `npm run check` and CI.
- External JSON (config file, `package.json`) is validated with zod instead of being assumed via `as`.
- Every ACP update type is handled explicitly in the `switch`; new types in an SDK release break the build.
- Only one justified lint exception in production code (`Readable.toWeb` is typed as `any` in `@types/node`),
  plus the `console.log` redirect in `main.ts`.

## How it was tested

| Check | Result |
|---|---|
| `npm run check` (type check, oxlint, oxfmt, 138 tests, plugin validator) | green, no warnings |
| Validator from `cursor/plugin-template` | passed |
| `npm run test:package` (pack → install into an empty folder → start via `npx` → real Claude adapter → session) | 5/5; install 16 s (warm cache), 303 MB |
| `npm run test:smoke` against real Claude Code (subscription mode, Windows) | 2/2 |
| Product page `site/` | checked at 1440 px and 375 px, light and dark |

Found and fixed in shutdown: after closing stdin, MCP hosts give a server only about 2 s, but the connector waited
up to 5 s per agent and was then killed. Now: a 1.5 s grace period, then the whole process tree is killed
(`taskkill /T` or the process group). `test/shutdown.test.ts` checks this with an agent that ignores stdin and starts
a grandchild process; cross-checked with the old value (the test fails).

Found and fixed in the real smoke test: the connector removed all `CLAUDE_CODE_*` variables, including
`CLAUDE_CODE_GIT_BASH_PATH`. On Windows, Claude Code then could not find Git Bash, a hook failed and blocked every
write. Now only the variables that a surrounding session sets itself are removed.

## Open items

- npm release (`0.1.0-rc.0` published and tested in Grok Bot, `0.1.0` ready), public repo, Ko-fi later: next steps for the owner (see
  `docs/marketplace-submission.md`).
- The first start downloads about 300 MB (the Agent SDK's native Claude Code binary); short host start timeouts can
  abort the first start.
- Whether Grok Bot expands plugin variables (`variables`) the same way Cursor does is only inferred from the Cursor
  docs, not tried in Grok Bot.
- MCP elicitation (follow-up questions as native forms) is not implemented; the question cards come from the skill.
- Still open from the first run: sessions only in memory, text prompts only, other ACP agents not tested for real,
  API key path not run against the real API (no key available).
- The CI workflow exists but has never run on GitHub.
