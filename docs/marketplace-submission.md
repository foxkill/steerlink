# Submitting to the Grok Bot marketplace

Form: <https://x.ai/bot/marketplace/submit-a-plugin>. Destinations there: Grok Bot and/or Cursor (same plugin
format). Reference for format and checklist: <https://cursor.com/docs/reference/plugins>.

## Before submitting: decisions and steps

| Item | Status | What to do |
|---|---|---|
| License | Decided: MIT, copyright Stefan Martin (`LICENSE`, `package.json`, `plugin.json`) | — |
| Name | Decided: `steerlink` / "SteerLink". `agent-steer` was rejected by npm as too similar to the existing `agentsteer` (AgentSteer, a security monitor for AI coding agents); a similar name in the same space would also risk confusion. | — |
| npm release | `0.1.4` published; repo at `0.1.5` (declined dialogs fall back to the host) | Run `npm publish` in a real terminal (2FA needs it). `prepublishOnly` runs `check` and `test:package` first. |
| Repo | `foxkill/steerlink` (renamed from `grokbot-acp-connector`) | Make it public and enable GitHub Pages (source: GitHub Actions). |
| Author | Decided: Stefan Martin (`package.json`, `plugin.json`) | Use the same name in the form. |
| Donations | PayPal: `paypal.me/foxkilldev` (`.github/FUNDING.yml`, `package.json` `funding`, README, product page) | Later: Ko-fi or GitHub Sponsors as one more line in `FUNDING.yml`. |

Then test locally and in-app as described in [testing-in-grok-bot.md](testing-in-grok-bot.md) — the form requires
confirming both.

## Form fields

| Field | Value |
|---|---|
| Organization Handle | unique, lowercase, no spaces (e.g. `foxkill`) |
| Logotype URL | `https://raw.githubusercontent.com/<org>/<repo>/<tag>/assets/logo.png` (1024 × 1024 PNG with background plate; `assets/logo.svg` is the same logo as a vector) |
| Listing destination | Grok Bot (optionally also Cursor) |
| MCP Server URL or Public GitHub Repository | URL of the public repo |
| Brief Description | see below |
| Testing Instructions | see below |

### Brief Description

> Steer and remote-control Claude Code from Grok Bot. Grok Bot starts a Claude Code session in a project, sends the
> task, and asks you before every change — with the diff — so you approve or deny each edit and command. Also works
> with Codex and other ACP coding agents. Bring your own Anthropic API key; usage is billed to your own account.

### Testing Instructions

> 1. Install the plugin and set the plugin variable `ANTHROPIC_API_KEY` to an Anthropic API key
>    (platform.claude.com). The first start downloads about 300 MB (the native Claude Code binary from Anthropic's
>    Agent SDK); if the first start times out, retry once the download has finished.
> 2. Ask Grok Bot: "Call auth_status of steerlink." Expect `problem: null` and `auth_mode: api_key`.
> 3. Ask: "Create a folder /tmp/steerlink-demo and let Claude Code create hello.txt with the content hi."
>    Grok Bot calls `start_session` and `send_prompt`; the agent requests permission to write `hello.txt`.
> 4. Grok Bot shows the request with its diff and asks you. Approve it. Expect status `idle` and the file
>    `/tmp/steerlink-demo/hello.txt` containing `hi`.
> 5. Repeat with a second file and deny the request. Expect that the file is not created.
> 6. Without the variable set, `auth_status` reports that `ANTHROPIC_API_KEY` must be entered in the plugin
>    settings, and `start_session` fails with the same message.

## Anthropic's rules (as of 2026-10-19)

Source: <https://code.claude.com/docs/en/legal-and-compliance>. Summary and how the plugin complies:

| Rule | How the plugin complies |
|---|---|
| Anyone who runs Claude Code in a product agrees to the Commercial Terms. | Agree before offering it, or have Anthropic (Sales) confirm. |
| The Claude Code binary stays unmodified. | It comes unmodified from `@anthropic-ai/claude-agent-sdk` via the official adapter `claude-agent-acp`. |
| Every end user pays for themselves (own API key or own subscription); no reselling, no brokering. | Every user enters their own key as a plugin variable. Donations are not payment for Claude usage. |
| Developer products use API keys; no claude.ai login in your own apps, no collecting subscription tokens. | The plugin sets `ACP_CONNECTOR_AUTH_MODE=api_key`. SteerLink offers no login of its own and never sees a claude.ai credential. Subscription mode is for personal use only and must be set by the user. |
| Do not remove or restrict any built-in login method. | SteerLink passes the adapter's arguments through unchanged and does not use `--hide-claude-auth` (removed in 0.1.1). The built-in methods (`claude-ai-login`, `console-login`) stay available and run through Anthropic's own flow; `test/e2e/package.test.ts` checks this against the real adapter. |
| No "Claude Code" in the product name or logo; no appearance of a partnership. | Neutral name and own logo; the README states plainly that Claude Code is used and points out the independence. |

Other agents (e.g. Codex) have their own terms.

## Known limitations

- The first start downloads about 300 MB (measured with `npm run test:package`: 303 MB `node_modules`, 16 s with a
  warm npm cache). Hosts with a short start timeout can abort the first start.
- Follow-up questions appear as question cards only because the skill instructs Grok Bot to do so. MCP elicitation
  (forms sent directly by the server) is not implemented; whether Grok Bot supports it is unknown.
- Sessions live only in the server's memory; they are gone after a restart.
