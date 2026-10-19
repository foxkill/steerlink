# Testing before submission

The submission form asks you to confirm that the plugin was tested **locally and in-app**. This guide covers both,
using a prerelease on npm so that the in-app test uses exactly the install path real users will get.

## 1. Local test (Cursor)

```bash
npm run plugin:local -- --subscription   # or set ANTHROPIC_API_KEY and omit --subscription
```

This installs the plugin into `~/.cursor/plugins/local/agent-steer`, points its `mcp.json` at a freshly packed local
tarball, starts the server exactly as configured and checks the tools and the sign-in. Then in Cursor run
**Developer: Reload Window**, open **Customize**, confirm that the plugin, its skill and the `agent-steer` MCP server
appear, and try the prompts from step 6 below. Remove it afterwards with `npm run plugin:local -- --remove`.

## 2. Publish a prerelease

```bash
npm login
npm publish --tag next
npm view agent-steer dist-tags          # expect: next: 0.1.0-rc.0
```

`prepublishOnly` runs `npm run check` and `npm run test:package` first and stops the release if anything fails. The
`next` tag keeps the prerelease away from users who install `agent-steer` without a version.

## 3. Prepare Grok Bot's computer

Grok Bot runs custom MCP servers on its own computer (Linux), not on your PC. Ask Grok Bot in a chat:

> Run on your computer: `node --version` and `npm install -g agent-steer@0.1.0-rc.0`

- Node.js must be **22 or newer**; if it is older, ask Grok Bot to install Node 22.
- The global install downloads about 300 MB once (the native Claude Code binary from Anthropic's Agent SDK). Doing it
  up front avoids a timeout on the server's first start.

## 4. Sign-in

Pick one. Never paste a key or token into the chat; enter it only in the environment-variable fields of step 5.

- **Your own Anthropic API key:** variable `ANTHROPIC_API_KEY`.
- **Your own Claude subscription (personal testing):** on your PC run `claude setup-token`, then use the variables
  `ACP_CONNECTOR_AUTH_MODE` = `subscription` and `CLAUDE_CODE_OAUTH_TOKEN` = the printed token.

Grok Bot runs a STDIO server that has environment variables only in your own conversations, not in teammates'.

## 5. Add the server in Grok Bot

Open the Bot's plugin settings, choose **Add a custom MCP**, type **STDIO**:

| Field | Value |
|---|---|
| Name | `agent-steer` |
| Command | `agent-steer` (after the global install from step 3) |
| Arguments | none |
| Environment variables | from step 4 |

A custom MCP server does not bring the plugin's skill along. Paste the content of
`skills/delegate-to-coding-agent/SKILL.md` (without the `---` header) into the server's **custom instructions**, so
Grok Bot asks you before every change, exactly as the published plugin will.

## 6. Test conversation

1. "Call auth_status of agent-steer." Expect `problem: null`.
2. "Create the folder /tmp/agent-steer-demo and let Claude Code create hello.txt there with the content hi."
   Grok Bot calls `start_session` and `send_prompt`; Claude Code asks for permission to write `hello.txt`.
3. Grok Bot shows the request with the diff and asks you. Approve it. Expect status `idle` and
   `/tmp/agent-steer-demo/hello.txt` with the content `hi`.
4. Repeat with a second file and deny the request. The file must not exist.
5. "Close the session." Then ask Grok Bot to run `ps aux | grep -i claude` on its computer: no Claude process from the
   test may be left over.

Note anything unexpected (wording of the approval card, timeouts, errors) before submitting.

## 7. Clean up

Remove the custom MCP server in Grok Bot, ask Grok Bot to run `npm uninstall -g agent-steer`, and revoke the token
from `claude setup-token` if you created one only for this test.
