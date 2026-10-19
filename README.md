# grokbot-acp-connector

MCP-Server (stdio, TypeScript/Node), über den Grok Bot Coding-Agents wie Claude Code steuert – nach dem Vorbild der
External Agents im Zed Editor. Grok Bot spricht MCP mit dem Connector, der Connector spricht als ACP-Client
([Agent Client Protocol](https://agentclientprotocol.com)) mit dem Agent-Subprozess.

```
Grok Bot ──MCP/stdio──▶ grokbot-acp-connector ──ACP/stdio──▶ claude-agent-acp (Claude Code)
                                              └─ACP/stdio──▶ weitere Agents (z. B. codex-acp)
```

- ACP-Client: `@agentclientprotocol/sdk` (v1)
- Standard-Agent: `@agentclientprotocol/claude-agent-acp` (wird mitinstalliert, Name `claude`)
- Weitere Agents konfigurierbar wie Zeds `agent_servers` (`command`, `args`, `env`)

## Installation

Voraussetzung: Node.js ≥ 20.

```bash
cd grokbot-acp-connector
npm ci
npm run build          # erzeugt dist/main.js
```

## Einbindung in Grok Bot (MCP, stdio)

Der Connector ist ein normaler stdio-MCP-Server. In der Connector-/MCP-Konfiguration von Grok Bot:

**Option A – API-Key (Standard)**

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "node",
      "args": ["/absoluter/pfad/grokbot-acp-connector/dist/main.js"],
      "env": {
        "ANTHROPIC_API_KEY": "<dein Anthropic API Key>"
      }
    }
  }
}
```

**Option B – eigene Claude-Subscription (bewusst gesetzt)**

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "node",
      "args": ["/absoluter/pfad/grokbot-acp-connector/dist/main.js"],
      "env": {
        "ACP_CONNECTOR_AUTH_MODE": "subscription"
      }
    }
  }
}
```

Vorher einmal im Terminal anmelden: `claude /login` (der Login liegt danach bei Claude Code selbst), oder ein Token mit
`claude setup-token` erzeugen und als `CLAUDE_CODE_OAUTH_TOKEN` in den `env`-Block setzen.

## Anmeldung

| `ACP_CONNECTOR_AUTH_MODE` | Verhalten |
|---|---|
| `api_key` (Default) | `ANTHROPIC_API_KEY` ist Pflicht. `CLAUDE_CODE_OAUTH_TOKEN` wird aus der Agent-Umgebung entfernt und der Adapter läuft mit `--hide-claude-auth`, d. h. ein claude.ai-Abo kann nie belastet werden. Ohne Key startet der Claude-Agent nicht; `auth_status` meldet das Problem. |
| `subscription` | `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` werden aus der Agent-Umgebung entfernt, damit der vorhandene Claude-Code-Login (bzw. ein bereits gesetztes `CLAUDE_CODE_OAUTH_TOKEN`) greift. |

Der Connector liest, speichert, loggt oder übermittelt das Abo-Token nie; er reicht nur die vorhandene Umgebung an den
Agent-Prozess durch. `auth_status` zeigt nur, *ob* Zugangsdaten vorhanden sind, und die vom Agent gemeldete Art
(z. B. `account`/`Claude Max` oder `api_key`) – ohne E-Mail, Organisation oder Token.

> Hinweis: Laut Anthropic dürfen Drittprodukte keinen claude.ai-Login anbieten. Dieser Connector ist ein privates
> Werkzeug für den eigenen Gebrauch; Default ist deshalb der API-Key, das Abo nur eine bewusst gesetzte Option.
> Der Connector bietet selbst keinen Login an: `authenticate` mit einer Terminal-Methode liefert nur den Befehl, den man
> selbst im Terminal ausführt.

Variablen von umgebenden Claude-Code-Sitzungen (`CLAUDECODE`, `CLAUDE_CODE_*` außer `CLAUDE_CODE_OAUTH_TOKEN` usw.)
werden nicht an den Agent vererbt, damit er sich nicht für eine verschachtelte Sitzung hält.

## Weitere Agents (wie Zeds `agent_servers`)

Optionale JSON-Datei, Pfad in `ACP_CONNECTOR_CONFIG`:

```json
{
  "default_agent": "claude",
  "auth_mode": "api_key",
  "agent_servers": {
    "codex": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "@zed-industries/codex-acp"],
      "env": {}
    }
  }
}
```

- `claude` ist immer eingebaut (lokales `claude-agent-acp`); ein eigener Eintrag `claude` überschreibt ihn.
- `auth_profile`: `"claude"` (Auth-Regeln oben, Default für den Namen `claude`) oder `"none"` (Env/Args unverändert).
- Env-Overrides: `ACP_CONNECTOR_AUTH_MODE`, `ACP_CONNECTOR_DEFAULT_AGENT`; `ACP_CONNECTOR_DEBUG=1` spiegelt die
  stderr-Ausgabe der Agents nach stderr (kann Kontoinfos des Agents enthalten – nur zum Debuggen).

## MCP-Tools

| Tool | Zweck |
|---|---|
| `list_agents` | Konfigurierte Agents mit Status und angebotenen Auth-Methoden |
| `start_session` | `cwd` (absolut), optional `agent`, `mode` (Default `default` = jede Änderung braucht Freigabe; außerdem `acceptEdits`, `plan`, `auto`, `bypassPermissions`) |
| `send_prompt` | `session_id`, `text`, `wait` (Default `true`), `timeout_seconds`. Liefert Status, Antworttext, Tool-Calls mit Diffs und offene Freigaben. `wait=false` startet nur. |
| `get_session_updates` | Ereignisse seit dem letzten Abruf (Text, Tool-Calls, Diffs, Pläne, Freigaben, Turn-Ende); `wait_seconds` für Long-Polling |
| `list_pending_permissions` | Offene Freigaben mit Tool, Eingabe, Diff und Optionen |
| `respond_permission` | `permission_id` + `decision` (`allow`, `allow_always`, `deny`, `deny_always`) oder konkrete `option_id` |
| `set_mode` | Session-Modus wechseln |
| `cancel` | Laufenden Turn abbrechen, offene Freigaben zurückziehen |
| `close_session` / `list_sessions` | Sessions verwalten |
| `auth_status` | Aktive Anmeldemethode ohne Secrets; `restart_agent=true` nach einem Login im Terminal |
| `authenticate` | Vom Agent angebotene Auth-Methode; Terminal-Methoden liefern nur den Befehl |

Typischer Ablauf aus Sicht von Grok Bot:

1. `start_session { cwd: "/pfad/zum/projekt" }`
2. `send_prompt { session_id, text: "…" }` → `status`
   - `awaiting_permission`: `pending_permissions` prüfen (Diff!), dann `respond_permission { permission_id, decision: "allow" }`
   - `running`: `get_session_updates { session_id, wait_seconds: 30 }` wiederholen
   - `idle`: Turn fertig, `response_text` und `tool_calls` lesen
3. Lange Aufgaben: `send_prompt { …, wait: false }` und nur noch pollen.

## Entwicklung und Tests

```bash
npm run typecheck
npm test                    # Unit- und Integrationstests mit Fake-ACP-Agent (kein Netz, keine Kosten)
npm run build               # dist/main.js (demo und test:smoke bauen selbst)
npm run test:smoke          # echter Smoke-Test gegen claude-agent-acp (braucht Auth, siehe unten)
npm run demo                # End-to-End-Demo: MCP-Client → dist/main.js → Claude → hello.txt
```

Smoke-Test und Demo laufen mit `ANTHROPIC_API_KEY` oder, bewusst gewählt, mit
`ACP_CONNECTOR_AUTH_MODE=subscription npm run test:smoke` bzw. `… npm run demo`. Ohne Anmeldung wird der Smoke-Test
übersprungen.

Struktur:

```
src/main.ts                     stdio-Einstieg
src/config/connector-config.ts  agent_servers, auth_mode
src/auth/agent-launch.ts        Env/Args je Auth-Modus (ohne Secrets anzufassen)
src/acp/agent-process.ts        Agent-Subprozess + ACP-Client-Verbindung
src/sessions/                   Sessions, Ereignis-Puffer, Freigaben
src/mcp/mcp-server.ts           MCP-Tools
test/fixtures/fake-agent.ts     Fake-ACP-Agent für Integrationstests
scripts/demo.ts                 End-to-End-Beweis
```
