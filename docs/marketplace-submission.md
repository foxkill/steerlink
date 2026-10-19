# Einreichung im Grok-Bot-Marktplatz

Formular: <https://x.ai/bot/marketplace/submit-a-plugin>. Ziele dort: Grok Bot und/oder Cursor (dasselbe
Plugin-Format). Grundlage für Format und Checkliste: <https://cursor.com/docs/reference/plugins>.

## Vor der Einreichung: offene Entscheidungen

Diese Punkte sind bewusst nicht entschieden, weil sie rechtliche oder geschäftliche Folgen haben:

| Punkt | Stand | Was zu tun ist |
|---|---|---|
| Lizenz | `UNLICENSED` (in `package.json` und `plugin.json`) | Offene Lizenz wählen (z. B. MIT), `LICENSE` anlegen, in beiden Dateien eintragen. `npm run validate:plugin` warnt bis dahin. |
| Name | Arbeitsname `acp-agent-bridge` (npm-Name am 19.10.2026 frei) | Bestätigen oder ändern: `package.json`, `plugin.json`, `mcp.json`, README. Kein „Claude“, „Anthropic“, „Grok“ oder „xAI“ im Produktnamen. |
| npm-Veröffentlichung | `"private": true` verhindert versehentliches Veröffentlichen | `private` entfernen, `npm login`, `npm publish`. `prepublishOnly` führt vorher `check` und `test:package` aus. |
| Repo | `foxkill/grokbot-acp-connector` | Öffentlich machen; ggf. umbenennen (dann `homepage`, `repository`, `bugs` anpassen). |
| Autor | `foxkill` | Name/E-Mail für Manifest und Formular festlegen. |
| Spenden | nicht eingerichtet | Optional: `"funding"` in `package.json`, `.github/FUNDING.yml`, Link im README (Buy Me a Coffee, GitHub Sponsors). |

Danach: `npm run check && npm run test:package`, Version taggen, Plugin in Grok Bot lokal installieren und einmal
komplett durchspielen (siehe Testanleitung).

## Formularfelder

| Feld | Wert |
|---|---|
| Organization Handle | eindeutig, klein, ohne Leerzeichen (z. B. `foxkill`) |
| Logotype URL | `https://raw.githubusercontent.com/<org>/<repo>/<tag>/assets/logo.svg` (1:1, mit Hintergrundfläche) |
| Listing destination | Grok Bot (optional zusätzlich Cursor) |
| MCP Server URL or Public GitHub Repository | URL des öffentlichen Repos |
| Brief Description | siehe unten |
| Testing Instructions | siehe unten |

### Brief Description

> Delegate coding tasks to ACP coding agents such as Claude Code. Grok Bot starts a session in a project, sends the
> task, and asks you before every change — with the diff — so you approve or deny each edit and command. Bring your
> own Anthropic API key; usage is billed to your own Anthropic account.

### Testing Instructions

> 1. Install the plugin and set the plugin variable `ANTHROPIC_API_KEY` to an Anthropic API key
>    (platform.claude.com). The first start downloads about 300 MB (the native Claude Code binary from Anthropic's
>    Agent SDK); if the first start times out, retry once the download has finished.
> 2. Ask Grok Bot: "Call auth_status of acp-agents." Expect `problem: null` and `auth_mode: api_key`.
> 3. Ask: "Create a folder /tmp/acp-demo and let Claude Code create hello.txt with the content hi."
>    Grok Bot calls `start_session` and `send_prompt`; the agent requests permission to write `hello.txt`.
> 4. Grok Bot shows the request with its diff and asks you. Approve it. Expect status `idle` and the file
>    `/tmp/acp-demo/hello.txt` containing `hi`.
> 5. Repeat with a second file and deny the request. Expect that the file is not created.
> 6. Without the variable set, `auth_status` reports that `ANTHROPIC_API_KEY` must be entered in the plugin
>    settings, and `start_session` fails with the same message.

## Regeln von Anthropic (Stand 19.10.2026)

Quelle: <https://code.claude.com/docs/en/legal-and-compliance>. Kurzfassung und wie das Plugin sie erfüllt:

| Regel | Umsetzung |
|---|---|
| Wer Claude Code in einem Produkt betreibt, stimmt den Commercial Terms zu. | Vor dem Angebot zustimmen bzw. bei Anthropic (Sales) bestätigen lassen. |
| Die Claude-Code-Binary bleibt unverändert. | Sie kommt unverändert aus `@anthropic-ai/claude-agent-sdk` über den offiziellen Adapter `claude-agent-acp`. |
| Jeder Endnutzer zahlt selbst (eigener API-Key oder eigenes Abo); kein Weiterverkauf, keine Vermittlung. | Jeder Nutzer trägt seinen eigenen Key als Plugin-Variable ein. Spenden sind kein Entgelt für Claude-Nutzung. |
| Entwickler-Produkte nutzen API-Keys; keine claude.ai-Anmeldung in eigenen Apps, keine Abo-Tokens sammeln. | Das Plugin setzt `ACP_CONNECTOR_AUTH_MODE=api_key`; der Adapter läuft mit `--hide-claude-auth`. Der Abo-Modus ist nur für den privaten Gebrauch und muss selbst gesetzt werden. |
| Keine eingebaute Anmeldemethode entfernen oder einschränken. | `--hide-claude-auth` ist eine Option des offiziellen Adapters, keine Änderung der Binary. Ob das für ein öffentliches Angebot genügt, vor dem Start bei Anthropic bestätigen lassen. |
| „Claude Code“ nicht im Produktnamen oder Logo; kein Anschein einer Partnerschaft. | Neutraler Name und eigenes Logo; README sagt sachlich, dass Claude Code genutzt wird, und weist auf die Unabhängigkeit hin. |

Für weitere Agents (z. B. Codex) gelten deren eigene Bedingungen.

## Bekannte Grenzen

- Erster Start lädt ca. 300 MB (gemessen mit `npm run test:package`: 303 MB `node_modules`, 16 s mit warmem
  npm-Cache). Hosts mit kurzem Start-Timeout können den ersten Start abbrechen.
- Rückfragen erscheinen als Frage-Karten nur, weil der Skill Grok Bot dazu anleitet. MCP-Elicitation (Formulare
  direkt vom Server) ist nicht umgesetzt; ob Grok Bot sie unterstützt, ist offen.
- Sessions leben nur im Speicher des Servers; nach einem Neustart sind sie weg.
