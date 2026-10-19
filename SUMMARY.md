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

## Codequalität und Werkzeuge

- TypeScript 7 mit strengsten Optionen (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `noImplicitOverride` …); `tsconfig.json` fürs ganze Projekt, `tsconfig.build.json` für `src/`.
- oxlint mit typbasierten Regeln (`oxlint-tsgolint`) und oxfmt (4 Leerzeichen); beides in `npm run check` und CI.
- Externes JSON (Konfigurationsdatei, `package.json`) wird mit zod validiert statt per `as` angenommen.
- Alle ACP-Update-Typen sind im `switch` ausdrücklich eingeordnet; neue Typen einer SDK-Version brechen den Build.
- Nur eine begründete Lint-Ausnahme im Produktivcode (`Readable.toWeb` ist in `@types/node` als `any` typisiert)
  plus `console.log`-Umleitung in `main.ts`.

## Wie getestet

| Prüfung | Ergebnis |
|---|---|
| `npm run check` (Typprüfung, oxlint, oxfmt, 138 Tests, Plugin-Validator) | grün; 1 Warnung: Lizenz noch offen |
| Validator aus `cursor/plugin-template` | bestanden |
| `npm run test:package` (pack → Installation in leeren Ordner → Start per `npx` → echter Claude-Adapter → Session) | 5/5; Installation 16 s (warmer Cache), 303 MB |
| `npm run test:smoke` gegen echtes Claude Code (Abo-Modus, Windows) | 2/2 |
| Produktseite `site/` | geprüft in 1440 px, 375 px, hell und dunkel |

Gefunden und behoben beim Herunterfahren: MCP-Hosts geben einem Server nach dem Schließen von stdin nur rund 2 s,
der Connector wartete aber bis zu 5 s je Agent und wurde dann hart beendet. Jetzt: 1,5 s Gnadenfrist, danach wird
der ganze Prozessbaum beendet (`taskkill /T` bzw. Prozessgruppe). `test/shutdown.test.ts` prüft das mit einem Agent,
der stdin ignoriert und einen Enkelprozess startet; gegengeprüft mit dem alten Wert (Test schlägt fehl).

Gefunden und behoben im echten Smoke-Test: Der Connector hatte alle `CLAUDE_CODE_*`-Variablen entfernt, auch
`CLAUDE_CODE_GIT_BASH_PATH`. Unter Windows fand Claude Code deshalb kein Git Bash, ein Hook scheiterte und blockierte
jedes Schreiben. Jetzt werden nur die Variablen entfernt, die eine umgebende Sitzung selbst setzt.

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
