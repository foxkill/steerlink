---
name: delegate-to-coding-agent
description: Delegate a coding task in a local project to an ACP coding agent (default Claude Code) through the steerlink MCP server, and let the user review and approve every change. Use when the user asks to have code written, fixed, refactored, reviewed or explained by Claude Code or another coding agent.
---

# Delegate to a coding agent

The `steerlink` MCP server drives ACP coding agents (Claude Code by default, plus any
agent the user configured, such as Codex). You talk to the agent; the agent edits files.
Every file change and command the agent wants to run comes back to you as a permission
request, and the **user** decides on it.

In the tool list the tools carry the server prefix, for example `steerlink__start_session`.

## Tools

| Tool | Purpose |
|---|---|
| `list_agents` | Configured agents, which one is the default, and their auth methods |
| `start_session` | Start a session in an absolute project directory (`cwd`), optional `agent` and `mode` |
| `send_prompt` | Send a task; waits until the turn ends, a permission is needed, or the timeout |
| `get_session_updates` | New events since the last call; `wait_seconds` long-polls |
| `list_pending_permissions` | Open permission requests with tool, input, diff and options |
| `respond_permission` | Answer one request: `allow`, `allow_always`, `deny`, `deny_always` or an `option_id` |
| `set_mode` | Switch the session mode |
| `cancel` | Stop the running turn and withdraw open permission requests |
| `close_session` | End a session |
| `list_sessions` | All sessions with status |
| `auth_status` | Which credentials are active, without revealing secrets |
| `authenticate` | Run an agent auth method; terminal methods only return the command |

## Workflow

1. **Start.** Call `start_session` with the absolute path of the project on the machine
   where the server runs. Keep the default mode `default` unless the user explicitly asks
   for something else.
2. **Prompt.** Call `send_prompt` with a precise task: goal, relevant files, constraints,
   and how to verify the result (for example which tests to run).
3. **Act on `status`:**
   - `awaiting_permission` → follow *Permission requests* below.
   - `running` → call `get_session_updates` with `wait_seconds: 30` until the status
     changes. Report progress to the user in a sentence or two, not event by event.
   - `idle` → the turn is done. Summarize `response_text` and the files changed
     (`tool_calls`) for the user.
4. **Follow up** with further `send_prompt` calls in the same session, so the agent keeps
   its context.
5. **Finish** with `close_session` once the user is done.

For long tasks call `send_prompt` with `wait: false` and poll `get_session_updates`.

**Slash commands.** `start_session` and `list_sessions` return `available_commands`, the slash
commands this session accepts (for example `/compact`). To run one, send it as the `send_prompt`
text. Commands that are not listed do not work through this server; terminal-only commands such
as `/rc` (Remote Control) are never available. Tell the user instead of trying them.

## Direct mode

If the user wants to talk to the agent directly ("let me talk to Claude Code", "direct mode"):

- Send each of their messages unchanged as `send_prompt` text. Do not rephrase, add or shorten.
- Show the agent's `response_text` verbatim, without your own summary, followed by one line
  with the changed files.
- Permission requests still go to the user as described below.
- Leave direct mode when the user asks for it or the session is closed.

## Permission requests

Each entry in `pending_permissions` has a `permission_id`, a `title`, the tool `kind`, the
`input`, the `diffs` and the `options`.

- **If `asked_user` is true**, the user is answering the request in a dialog of the host right
  now. Do not ask again in the chat; wait with `get_session_updates`. If `respond_permission`
  refuses an `allow` (`permission_prompt=required`), only the user's dialog can allow it.
- **Ask the user, do not decide yourself.** Present the request as a question with
  choices: what the agent wants to do (`title`), the file path, the diff or command, and the
  options *Allow once*, *Always allow*, *Deny*. Then call `respond_permission` with the
  user's choice.
- Keep internal identifiers (`session_id`, `permission_id`, `tool_call_id`) out of what you
  show the user unless they ask for them.
- Use `allow_always` or `deny_always` only when the user picked it.
- Answer automatically only when the user explicitly granted that for this session
  (for example "approve all edits in this session"), and even then never for deleting
  files, `git push`, publishing, network uploads or commands outside the project.
- Never switch to `bypassPermissions` on your own initiative.
- If the user wants to stop, call `cancel`.

## Sign-in problems

If `start_session` fails or `auth_status` reports a `problem`:

- `ANTHROPIC_API_KEY` missing or a placeholder: ask the user to enter their own Anthropic
  API key in the plugin settings (variable `ANTHROPIC_API_KEY`). **Never ask the user to
  paste a key into the chat**, and never print one.
- A terminal login method (`authenticate` returns `command`): show the command; the user
  runs it themselves.
- After the user changed credentials, call `auth_status` with `restart_agent: true`.

## Rules

- Pass on the agent's results faithfully, including failed tests or skipped steps.
- Do not send secrets, tokens or credentials in prompts to the agent.
- One task per session is easiest to follow; close sessions you no longer need.
