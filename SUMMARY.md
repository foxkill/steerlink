# Zusammenfassung

## Was das Projekt ist

`acp-agent-bridge` (Repo `grokbot-acp-connector`) ist ein MCP-Server (stdio, TypeScript, Node ≥ 22), über den ein
MCP-Host wie Grok Bot Coding-Agents steuert – so, wie Zed das als ACP-Client tut. Nach oben spricht der Server MCP,
nach unten startet er `@agentclientprotocol/claude-agent-acp` (oder weitere ACP-Agents wie codex-acp) als
Subprozess.

Das Repo ist zugleich ein Plugin im Cursor-Plugin-Format, das der Grok-Bot-Marktplatz übernimmt. Wie es
eingereicht wird und was vorher noch zu entscheiden ist, steht in `docs/marketplace-submission.md`.

## Aufbau

| Teil | Dateien |
|---|---|
| Server | `src/` (MCP-Tools, Sessions, Freigaben, Auth-Regeln) |
| Plugin | `.cursor-plugin/plugin.json` (Variable `ANTHROPIC_API_KEY`), `mcp.json` (`npx -y acp-agent-bridge@<version>`, `api_key`-Modus), `skills/delegate-to-coding-agent/SKILL.md`, `assets/logo.svg` |
| Prüfungen | `scripts/validate-plugin.ts`, `test/`, `test/e2e/`, `.github/workflows/ci.yml` |

## Stand der Plugin-Arbeit (19.10.2026)

- **Plugin-Gerüst** nach <https://cursor.com/docs/reference/plugins>; zusätzlich gegen den Validator aus Cursors
  offiziellem Plugin-Template geprüft (bestanden).
- **Skill** für Grok Bot: Ablauf, Polling und vor allem: jede Freigabe als Frage mit Diff an den Nutzer, nie selbst
  entscheiden, nie Keys im Chat erfragen.
- **Name und Version** kommen zentral aus `package.json` (MCP-Server, ACP-Client, Startmeldung).
- **Nicht ersetzte Plugin-Platzhalter** (`${ANTHROPIC_API_KEY}`, wenn der Nutzer die Variable nicht gesetzt hat)
  gelten als nicht gesetzt, erreichen den Agent nie und führen zu einer klaren Meldung („in den
  Plugin-Einstellungen eintragen“).
- **npm-Paket** vorbereitet: nur `dist/**/*.js`, `bin`, `prepack`-Build, `prepublishOnly` mit allen Prüfungen;
  `private: true`, bis Name und Lizenz entschieden sind.
- **Korrektur:** `engines.node` war `>=20`, `claude-agent-acp` verlangt aber Node ≥ 22. Jetzt `>=22`; ein Test
  prüft das künftig gegen alle Abhängigkeiten.

## Wie getestet

| Prüfung | Ergebnis |
|---|---|
| `npm run typecheck` | fehlerfrei |
| `npm test` (Unit, Integration mit Fake-ACP-Agent, Plugin-Validator positiv und mit über 40 kaputten Varianten, Skill-Tooltabelle = `tools/list`, Plugin-Env gegen den echten Connector) | 114 bestanden |
| `npm run validate:plugin` | bestanden, 1 Warnung (Lizenz noch offen) |
| Validator aus `cursor/plugin-template` | bestanden |
| `npm run test:package` (pack → Installation in leeren Ordner → Start per `npx` → echter Claude-Adapter startet → Session mit Fake-Agent) | 5 bestanden; Installation 16 s (warmer Cache), 303 MB |
| `npm run test:smoke` gegen echtes Claude Code | siehe Abschlussbericht dieses Laufs |

## Offene Punkte

- Lizenz, endgültiger Name, Autor, npm-Veröffentlichung, öffentliches Repo: Entscheidungen des Inhabers (siehe
  `docs/marketplace-submission.md`).
- Erster Start lädt ca. 300 MB (native Claude-Code-Binary des Agent SDK); kurze Start-Timeouts eines Hosts können
  den ersten Start abbrechen.
- Ob Grok Bot Plugin-Variablen (`variables`) genauso wie Cursor ersetzt, ist nur aus der Cursor-Doku abgeleitet,
  nicht in Grok Bot ausprobiert.
- MCP-Elicitation (Rückfragen als native Formulare) nicht umgesetzt; die Frage-Karten kommen über den Skill.
- Weiterhin offen aus dem ersten Lauf: Sessions nur im Speicher, nur Text-Prompts, andere ACP-Agents nicht real
  getestet, API-Key-Pfad nicht gegen die echte API gelaufen (kein Key vorhanden).
- CI-Workflow ist angelegt, aber noch nie auf GitHub gelaufen.
