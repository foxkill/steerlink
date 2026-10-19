---
name: delegate-to-coding-agent
description: Delegate a coding task in a local project to an ACP coding agent (default Claude Code) through the agent-steer MCP server, and let the user review and approve every change. Use when the user asks to have code written, fixed, refactored, reviewed or explained by Claude Code or another coding agent.
---

# Delegate to a coding agent

The `agent-steer` MCP server drives ACP coding agents (Claude Code by default, plus any
agent the user configured, such as Codex). You talk to the agent; the agent edits files.
Every file change and command the agent wants to run comes back to you as a permission
request, and the **user** decides on it.

In the tool list the tools carry the server prefix, for example `agent-steer__start_session`.

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

## Permission requests

Each entry in `pending_permissions` has a `permission_id`, a `title`, the tool `kind`, the
`input`, the `diffs` and the `options`.

- **Ask the user, do not decide yourself.** Present the request as a question with
  choices: what the agent wants to do (`title`), the diff or command, and the options
  *Allow once*, *Always allow*, *Deny*. Then call `respond_permission` with the user's
  choice.
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
