import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../package-info.js";
import type { SessionManager } from "../sessions/session-manager.js";

function ok(value: object): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  return { content: [{ type: "text", text: `Fehler: ${message}` }], isError: true };
}

async function run(operation: () => Promise<object> | object): Promise<CallToolResult> {
  try {
    return ok(await operation());
  } catch (error) {
    return fail(error);
  }
}

const sessionId = z.string().describe("session_id aus start_session");
const agentName = z.string().optional().describe("Name aus list_agents; Default ist der konfigurierte default_agent");

export function createMcpServer(manager: SessionManager): McpServer {
  const server = new McpServer(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    {
      instructions:
        "Steuert ACP-Coding-Agents (Standard: Claude Code über claude-agent-acp). Ablauf: start_session(cwd) → send_prompt(text). " +
        "Meldet send_prompt status=awaiting_permission, mit respond_permission(permission_id, allow|deny) antworten und dann " +
        "get_session_updates(wait_seconds) abfragen, bis status=idle. Lange Aufgaben: send_prompt mit wait=false und pollen.",
    },
  );

  server.registerTool(
    "list_agents",
    {
      title: "ACP-Agents auflisten",
      description: "Listet die konfigurierten ACP-Agents (wie Zeds agent_servers) mit Status und Auth-Methoden.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run(() => ({ agents: manager.listAgents() })),
  );

  server.registerTool(
    "start_session",
    {
      title: "Session starten",
      description:
        "Startet eine neue Agent-Session in einem Arbeitsverzeichnis. mode: z. B. 'default' (fragt vor Änderungen, Standard), " +
        "'acceptEdits', 'plan', 'auto', 'bypassPermissions' – die verfügbaren Modi stehen in der Antwort.",
      inputSchema: {
        cwd: z.string().describe("Absoluter Pfad des Arbeitsverzeichnisses"),
        agent: agentName,
        mode: z.string().optional().describe("Session-Modus; Default 'default' (jede Änderung braucht eine Freigabe)"),
      },
    },
    ({ cwd, agent, mode }) => run(() => manager.startSession({ cwd, agent, mode: mode ?? "default" })),
  );

  server.registerTool(
    "send_prompt",
    {
      title: "Prompt senden",
      description:
        "Sendet einen Prompt. Mit wait=true (Standard) kehrt der Aufruf zurück, sobald der Turn endet, eine Freigabe nötig ist " +
        "oder timeout_seconds abläuft. Liefert Antworttext, Tool-Calls mit Diffs und offene Freigaben. wait=false startet nur.",
      inputSchema: {
        session_id: sessionId,
        text: z.string().min(1).describe("Prompt-Text"),
        wait: z.boolean().optional().describe("Auf Ende/Freigabe warten (Standard true)"),
        timeout_seconds: z.number().int().min(1).max(3600).optional().describe("Maximale Wartezeit (Standard 120)"),
      },
    },
    ({ session_id, text, wait, timeout_seconds }) =>
      run(() => manager.sendPrompt({ session_id, text, wait: wait ?? true, timeout_seconds: timeout_seconds ?? 120 })),
  );

  server.registerTool(
    "get_session_updates",
    {
      title: "Session-Updates abrufen",
      description:
        "Liefert alle Ereignisse seit dem letzten Abruf (Text, Tool-Calls, Diffs, Freigaben, Turn-Ende) plus Status. " +
        "wait_seconds > 0 wartet so lange auf neue Ereignisse (Long-Polling).",
      inputSchema: {
        session_id: sessionId,
        wait_seconds: z.number().int().min(0).max(600).optional().describe("Long-Polling-Dauer (Standard 0)"),
        include_thoughts: z.boolean().optional().describe("Gedanken-Chunks des Agents einschließen (Standard false)"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ session_id, wait_seconds, include_thoughts }) =>
      run(() => manager.getUpdates({ session_id, wait_seconds: wait_seconds ?? 0, include_thoughts: include_thoughts ?? false })),
  );

  server.registerTool(
    "list_pending_permissions",
    {
      title: "Offene Freigaben",
      description: "Listet offene Permission-Anfragen der Agents (optional nur einer Session) mit Tool, Eingabe, Diff und Optionen.",
      inputSchema: { session_id: sessionId.optional() },
      annotations: { readOnlyHint: true },
    },
    ({ session_id }) => run(() => ({ pending_permissions: manager.listPendingPermissions(session_id) })),
  );

  server.registerTool(
    "respond_permission",
    {
      title: "Freigabe beantworten",
      description:
        "Beantwortet eine Permission-Anfrage. decision: allow (einmal), allow_always, deny (einmal), deny_always. " +
        "Alternativ eine konkrete option_id aus list_pending_permissions.",
      inputSchema: {
        permission_id: z.string(),
        decision: z.enum(["allow", "allow_always", "deny", "deny_always"]).optional(),
        option_id: z.string().optional(),
      },
    },
    ({ permission_id, decision, option_id }) => run(() => manager.respondPermission({ permission_id, decision, option_id })),
  );

  server.registerTool(
    "set_mode",
    {
      title: "Session-Modus setzen",
      description: "Wechselt den Modus einer Session (z. B. default, acceptEdits, plan).",
      inputSchema: { session_id: sessionId, mode: z.string() },
    },
    ({ session_id, mode }) => run(() => manager.setMode(session_id, mode)),
  );

  server.registerTool(
    "cancel",
    {
      title: "Turn abbrechen",
      description: "Bricht den laufenden Turn ab (session/cancel) und zieht offene Freigaben zurück.",
      inputSchema: { session_id: sessionId },
    },
    ({ session_id }) => run(() => manager.cancel(session_id)),
  );

  server.registerTool(
    "close_session",
    {
      title: "Session schließen",
      description: "Bricht laufende Arbeit ab und schließt die Session.",
      inputSchema: { session_id: sessionId },
    },
    ({ session_id }) => run(() => manager.closeSession(session_id)),
  );

  server.registerTool(
    "list_sessions",
    {
      title: "Sessions auflisten",
      description: "Listet alle Sessions dieses Connectors mit Status.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run(() => ({ sessions: manager.listSessions() })),
  );

  server.registerTool(
    "auth_status",
    {
      title: "Auth-Status",
      description:
        "Zeigt, welche Anmeldemethode aktiv ist (API-Key oder Claude-Abo), ob Zugangsdaten vorhanden sind und was der Agent " +
        "selbst meldet – ohne Secrets. restart_agent=true startet den Agent neu (z. B. nach einem Login im Terminal).",
      inputSchema: {
        agent: agentName,
        probe: z.boolean().optional().describe("Agent bei Bedarf starten und seine Meldung abwarten (Standard true)"),
        restart_agent: z.boolean().optional().describe("Agent-Prozess vorher neu starten (nur ohne offene Sessions)"),
      },
    },
    ({ agent, probe, restart_agent }) => run(() => manager.authStatus({ agent, probe: probe ?? true, restart_agent: restart_agent ?? false })),
  );

  server.registerTool(
    "authenticate",
    {
      title: "Anmelden",
      description:
        "Führt eine vom Agent angebotene Auth-Methode aus (siehe auth_status.auth_methods). Terminal-Methoden (z. B. Claude-Login) " +
        "liefern nur den Befehl, den der Mensch selbst im Terminal ausführt.",
      inputSchema: { agent: agentName, method_id: z.string() },
    },
    ({ agent, method_id }) => run(() => manager.authenticate({ agent, method_id })),
  );

  return server;
}
