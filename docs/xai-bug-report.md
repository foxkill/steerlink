# Bug report to xAI (draft)

Send through the Grok Bot app (profile menu → *Support*) or the channel xAI names for Grok Bot feedback. Check the app
version before sending; the tests below ran on v0.75.2.

---

**Subject:** Grok Bot declares MCP form elicitation but declines every form without showing it

Hello,

I build SteerLink, an open-source MCP server (https://github.com/foxkill/steerlink, npm `steerlink`) that I would like
to list in the Grok Bot marketplace. It uses MCP elicitation to ask the user before a coding agent changes a file.
Grok Bot advertises form elicitation, but never shows the forms.

**Environment**

- Grok Bot desktop app v0.75.2 (Windows), custom MCP server over STDIO on the Bot's computer
- MCP server built with `@modelcontextprotocol/sdk` 1.32.1
- During `initialize`, Grok Bot's MCP client reports itself as `{ "name": "Cursor", "version": "1.0.0" }` with
  capabilities `{ "elicitation": { "form": {} } }`

**Steps**

1. Add a custom STDIO MCP server whose tool call sends `elicitation/create` with `mode: "form"`.
2. Call that tool from a chat.

The request we send (shortened message):

```json
{
  "mode": "form",
  "message": "claude wants to: Write dialog.txt\nProject: /tmp/steerlink-demo\n\nFile: dialog.txt (new file, 1 lines)\ntest",
  "requestedSchema": {
    "type": "object",
    "properties": {
      "decision": {
        "type": "string",
        "title": "Decision",
        "oneOf": [
          { "const": "allow", "title": "Allow once" },
          { "const": "allow_always", "title": "Always allow" },
          { "const": "deny", "title": "Deny" }
        ]
      }
    },
    "required": ["decision"]
  }
}
```

**Expected:** Grok Bot shows the form to the user and returns `accept` with the chosen value, or `decline`/`cancel`
after the user dismisses it.

**Actual:** No form appears. Grok Bot answers `{ "action": "decline" }` after 14 ms. The same happens with the older
`enum` + `enumNames` schema (tested 2026-10-23 and 2026-10-28). The chat model then asks the user in its own question
card instead.

**Impact:** A server cannot tell a real "decline" from a form that was never shown. For permission prompts this
matters: the point of elicitation is that only the user can answer, not the model. Because the capability is
declared, servers rely on it.

**Request:** Either render form elicitation (string, enum/`oneOf`, boolean fields), or stop declaring
`elicitation.form` until it is supported, so servers can fall back cleanly.

Our workaround: SteerLink treats a decline within 500 ms as "host cannot show forms", switches dialogs off and lets
the host ask in the chat.

Thank you,
Stefan Martin
https://github.com/foxkill
