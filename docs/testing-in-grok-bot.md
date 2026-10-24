# Testing before submission

The submission form asks you to confirm that the plugin was tested **locally and in-app**. This guide covers both,
using a prerelease on npm so that the in-app test uses exactly the install path real users will get.

## 1. Local test (Cursor)

```bash
npm run plugin:local -- --subscription   # or set ANTHROPIC_API_KEY and omit --subscription
```

This installs the plugin into `~/.cursor/plugins/local/steerlink`, points its `mcp.json` at a freshly packed local
tarball, starts the server exactly as configured and checks the tools and the sign-in. Then in Cursor run
**Developer: Reload Window**, open **Customize**, confirm that the plugin, its skill and the `steerlink` MCP server
appear, and try the prompts from step 6 below. Remove it afterwards with `npm run plugin:local -- --remove`.

## 2. Publish a prerelease

```bash
npm login
npm publish --tag next
npm view steerlink dist-tags          # expect: next: <the version in package.json>
```

Run these in the project folder. npm may need a few minutes before the new version can be installed.

`prepublishOnly` runs `npm run check` and `npm run test:package` first and stops the release if anything fails. The
`next` tag keeps the prerelease away from users who install `steerlink` without a version.

## 3. Prepare Grok Bot's computer

Grok Bot runs custom MCP servers on its own computer (Linux), not on your PC. Ask Grok Bot in a chat:

> Run on your computer and show me the raw output: `node --version`, `npm install -g steerlink@<version>`,
> `npm ls -g steerlink` and `which -a steerlink`

Check that `npm ls -g` shows the version you just published. An older global install (for example under another
Node.js version in `~/.nvm`) can otherwise keep running unnoticed; from `0.1.12` on, `auth_status` shows the running
version under `server`.

- Node.js **20.19 or newer** is enough; Grok Bot's computer already has it. npm may print an `EBADENGINE` warning
  for `claude-agent-acp` (it declares Node 22); it runs fine on Node 20.
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
| Name | `steerlink` |
| Command | `steerlink`, or the full path that `which steerlink` printed in step 3 |
| Arguments | none |
| Environment variables | from step 4 |

The app cannot edit a connector afterwards (only uninstall it under Ctrl+K → *Apps verbinden* → *Plugins und Skills
verwalten*). To change a variable, ask Grok Bot to delete and recreate the connector. A variable with an empty value
(for example `CLAUDE_CODE_OAUTH_TOKEN=""`) switches off a value set in Grok Bot's general environment.

A custom MCP server does not bring the plugin's skill along. Without it Grok Bot may pick `acceptEdits` or approve
requests itself (seen in the test on 2026-10-23). The app has no field for it, but Grok Bot can store permanent
instructions on the connector when asked. **They are cut off after 500 characters**, so the full skill does not fit
(in the test it ended inside the tool table and the permission rules were lost). Ask Grok Bot to store exactly this
short version instead:

```text
steerlink rules: Start sessions in mode default unless I ask otherwise. Never approve a permission request yourself: show me what the agent wants (file and diff, or command) and ask: Allow once, Always allow, Deny. Then call respond_permission with my answer. Never switch to acceptEdits or bypassPermissions on your own. Report results faithfully, including failures. Close sessions when done. Never ask for or print keys or tokens.
```

Then ask it to show the stored text back and check that it ends with "keys or tokens.". The published plugin brings
the full skill as a file and is not affected by this limit.

## 6. Test conversation

1. "Call auth_status of steerlink." Expect `problem: null` (and from `0.1.12` on, `server.version` as published).
   With a subscription token the agent says "Not logged in"; that is expected and the `note` explains it.
2. "Create the folder /tmp/steerlink-demo, start a steerlink session there in mode default and let Claude Code create
   hello.txt with the content hi." Claude Code asks for permission to write `hello.txt`.
3. Grok Bot shows the request with the diff or command and asks you. Approve it. Expect status `idle` and
   `/tmp/steerlink-demo/hello.txt` with the content `hi`.
4. Repeat with a second file and deny the request. The file must not exist.
5. "Close the session." Then ask Grok Bot to run `ps aux | grep -i claude` on its computer. One idle
   `claude-agent-acp` process is expected: SteerLink keeps the adapter for the next session and stops it with the
   server. No other Claude process from the test may be left over.

If Grok Bot answers a request itself instead of asking you, the instructions from step 5 are missing.
`auth_status` → `permission_prompt.note` reports when SteerLink switched dialogs off because the host declined them.

Note anything unexpected (wording of the approval card, timeouts, errors) before submitting.

## 7. Clean up

Remove the custom MCP server in Grok Bot, ask Grok Bot to run `npm uninstall -g steerlink`, and revoke the token
from `claude setup-token` if you created one only for this test.
