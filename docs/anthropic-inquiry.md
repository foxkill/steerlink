# Inquiry to Anthropic (draft)

Send via <https://www.anthropic.com/contact-sales>, as recommended in
<https://code.claude.com/docs/en/legal-and-compliance> for questions about permitted authentication methods.

---

**Subject:** Confirmation request: open-source MCP plugin that runs Claude Code via claude-agent-acp (BYO API key)

Hello,

I maintain SteerLink, a free, MIT-licensed open-source MCP server (npm: `steerlink`, source:
https://github.com/foxkill/steerlink). I plan to list it in the Grok Bot plugin marketplace (xAI). Before I do, I
would like to confirm that the setup below complies with your terms for Claude Code.

What it does: it lets an MCP host (Grok Bot, Cursor) delegate a coding task to Claude Code through Zed's official
ACP adapter `@agentclientprotocol/claude-agent-acp`. Every file change and command Claude Code wants to run is shown
to the user, who approves or denies it.

How it handles Claude Code and billing:

- Claude Code runs unmodified, as installed by `@anthropic-ai/claude-agent-sdk` through the adapter.
- Each user installs SteerLink themselves and enters their **own** Anthropic API key as a plugin variable. Usage is
  billed directly to that user. I do not host, pay for, resell or route any Claude usage, and I never receive or
  store keys.
- SteerLink offers no login of its own and never collects claude.ai credentials or session tokens. It does not
  remove or restrict Claude Code's built-in sign-in methods; the adapter's methods (Claude subscription, Anthropic
  Console) stay available and run through your own flow.
- An optional mode, for personal use only and set by the user, lets a user use their own Claude Code login.
- The product name and logo do not use "Claude" or Anthropic marks; the docs say in plain text that it runs Claude
  Code and that the project is independent.
- The project is free. It has an optional donation link (PayPal); donations are not payment for Claude usage.

My questions:

1. Is this distribution model (an open-source tool that end users install and run with their own credentials)
   permitted, and does it require me, as the author, to agree to the Commercial Terms of Service?
2. Is the optional personal-subscription mode acceptable as described, or should the published plugin offer only
   API-key sign-in?
3. Is there anything else I should change before listing it in a third-party marketplace?

Thank you very much.

Best regards,
Stefan Martin
https://github.com/foxkill
