# Zusammenfassung

## Was gebaut wurde

`grokbot-acp-connector` ist ein MCP-Server (stdio, TypeScript/Node ≥ 20), über den Grok Bot Claude Code steuert –
so, wie Zed das als ACP-Client tut. Nach oben spricht der Server MCP, nach unten startet er
`@agentclientprotocol/claude-agent-acp` (v0.93.0) als Subprozess und spricht mit dem ACP-TypeScript-SDK
`@agentclientprotocol/sdk` (Client-Seite) mit ihm.

- **Agents konfigurierbar wie Zeds `agent_servers`** (`type`, `command`, `args`, `env`) über eine JSON-Datei in
  `ACP_CONNECTOR_CONFIG`. `claude` ist eingebaut; weitere ACP-Agents (z. B. codex-acp) lassen sich ergänzen.
- **MCP-Tools:** `list_agents`, `start_session`, `send_prompt` (mit `wait=false` für lange Aufgaben),
  `get_session_updates` (Long-Polling), `list_pending_permissions`, `respond_permission`, `set_mode`, `cancel`,
  `close_session`, `list_sessions`, `auth_status`, `authenticate`.
- **Antworten zusammengefasst:** Antworttext, Tool-Calls mit Status und gekürzten Diffs, offene Freigaben mit Diff und
  Optionen, Hinweis auf den nächsten Schritt.
- **Anmeldung:**
  - Default `api_key`: `ANTHROPIC_API_KEY` ist Pflicht, ein OAuth-Token wird entfernt, der Adapter läuft mit
    `--hide-claude-auth` (kein Abo kann belastet werden).
  - `ACP_CONNECTOR_AUTH_MODE=subscription` (bewusst gesetzt): API-Keys werden entfernt, der vorhandene
    Claude-Code-Login (`claude /login`) bzw. ein gesetztes `CLAUDE_CODE_OAUTH_TOKEN` wird nur durchgereicht. Der
    Connector speichert, loggt oder übermittelt das Token nie.
  - `auth_status` zeigt Modus, ob Zugangsdaten vorhanden sind (nur ja/nein) und was der Agent meldet (z. B.
    `account` / `Claude Max`), ohne E-Mail, Organisation oder Token. `authenticate` führt Terminal-Logins nicht selbst
    aus, sondern gibt nur den Befehl aus.

In diesem Lauf ergänzt bzw. korrigiert: `turn_end` und `status=idle` kommen jetzt im selben Abruf an (vorher meldete
`get_session_updates` beim Turn-Ende kurz noch `running`), dazu Demo-Skript, echter Smoke-Test und README.

## Wie getestet

| Prüfung | Ergebnis |
|---|---|
| `npm run typecheck` | fehlerfrei |
| `npm test` (Unit-Tests und Integration MCP → Connector → Fake-ACP-Agent: Freigabe allow/deny, `acceptEdits`, `wait=false` + Polling, `cancel`, `close_session`, Auth-Status ohne E-Mail, `authenticate`, api_key ohne Key) | 20 bestanden, 2 übersprungen (Smoke ohne `RUN_SMOKE`) |
| `ACP_CONNECTOR_AUTH_MODE=subscription npm run test:smoke` (echter claude-agent-acp) | 2/2 bestanden |
| `ACP_CONNECTOR_AUTH_MODE=subscription npm run demo` (MCP-Client → `dist/main.js` → Claude Code) | `DEMO OK` |

Ablauf der Demo (gekürzt, echter Lauf):

```
auth_status      → auth_mode=subscription, agent_reported={kind: account, label: Claude Max}, problem=null
start_session    → cwd=/tmp/grokbot-acp-demo-…, current_mode=default
send_prompt "Erzeuge hello.txt mit 'hi'"
                 → status=awaiting_permission, perm-1 "Write hello.txt", Diff: null → "hi"
respond_permission perm-1 allow → allow_once
get_session_updates … status=idle, neue Events: turn_end
letzter Turn     → stop_reason=end_turn, Tool-Call "Write hello.txt" completed
Ergebnis         → hello.txt existiert, Inhalt "hi"
DEMO OK
```

Lokal war kein `ANTHROPIC_API_KEY` vorhanden; der echte Lauf erfolgte deshalb bewusst im Abo-Modus über den
bestehenden Claude-Code-Login. Der API-Key-Pfad ist mit Unit- und Integrationstests abgedeckt (Env-Bereinigung,
`--hide-claude-auth`, Fehlermeldung ohne Key), aber nicht gegen die echte API gelaufen. Die Logs wurden auf Token und
E-Mail-Adressen geprüft.

## Einbindung in Grok Bot

```bash
npm ci && npm run build
```

stdio-MCP-Server in Grok Bot eintragen:

```json
{
  "command": "node",
  "args": ["/absoluter/pfad/grokbot-acp-connector/dist/main.js"],
  "env": { "ANTHROPIC_API_KEY": "<key>" }
}
```

Für das eigene Abo statt des Keys `"env": { "ACP_CONNECTOR_AUTH_MODE": "subscription" }` und vorher einmal
`claude /login`. Details, weitere Agents und die Tool-Referenz stehen in der `README.md`.

## Offene Punkte

- API-Key-Modus nicht gegen die echte Anthropic-API getestet (kein Key vorhanden).
- Andere ACP-Agents (z. B. codex-acp) nur über die Konfiguration vorgesehen, nicht real getestet.
- Sessions leben nur im Speicher; nach einem Neustart des Connectors sind sie weg (`session/load`/`resume` wird nicht
  genutzt).
- Nur Text-Prompts; Bilder/Ressourcen sowie ACP-Client-Fähigkeiten `fs` und `terminal` sind nicht umgesetzt – Claude
  Code nutzt seine eigenen Werkzeuge.
- MCP-Server an den Agent durchreichen (`mcpServers` in `session/new`, RFD „MCP over ACP“) ist nicht umgesetzt.
- ACP v2 (`CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=1`) nicht getestet; der Connector spricht ACP v1.
- Die Regressionsprüfung für „turn_end mit idle“ im Integrationstest ist zeitabhängig und deckt die frühere Race mit
  dem Fake-Agent nicht zuverlässig ab; bewiesen wurde der Fix im echten Demo-Lauf.
- Laut Anthropic dürfen Drittprodukte kein claude.ai-Login anbieten: Der Abo-Modus ist nur für den privaten Gebrauch
  gedacht und muss bewusst gesetzt werden.
