import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectorClient, FAKE_AGENT_PATH } from "./helpers/connector-client.js";
import type { AuthStatusResult, TurnResult, UpdatesResult, AgentInfo } from "../src/sessions/session-manager.js";

interface StartSessionResult {
  session_id: string;
  current_mode: string | null;
  available_modes: Array<{ id: string; name: string }>;
}

describe("Connector mit Fake-ACP-Agent (MCP → Connector → ACP)", () => {
  const client = new ConnectorClient();
  let workDir: string;
  let configDir: string;

  beforeAll(async () => {
    configDir = mkdtempSync(join(tmpdir(), "acp-connector-config-"));
    workDir = mkdtempSync(join(tmpdir(), "acp-connector-work-"));
    const configPath = join(configDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        default_agent: "fake",
        agent_servers: {
          fake: { type: "custom", command: process.execPath, args: ["--import", "tsx", FAKE_AGENT_PATH], env: { FAKE_FLAG: "1" } },
        },
      }),
    );
    await client.connect({ ACP_CONNECTOR_CONFIG: configPath, ANTHROPIC_API_KEY: "", ACP_CONNECTOR_AUTH_MODE: "" });
  });

  afterAll(async () => {
    await client.close();
    rmSync(configDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it("bietet alle Tools an", async () => {
    const names = await client.listToolNames();
    expect(names).toEqual(
      expect.arrayContaining([
        "list_agents",
        "start_session",
        "send_prompt",
        "get_session_updates",
        "list_pending_permissions",
        "respond_permission",
        "cancel",
        "close_session",
        "auth_status",
        "authenticate",
        "set_mode",
        "list_sessions",
      ]),
    );
  });

  it("listet Agents wie Zeds agent_servers", async () => {
    const result = await client.call<{ agents: AgentInfo[] }>("list_agents");
    const names = result.data.agents.map((agent) => agent.name);
    expect(names).toEqual(expect.arrayContaining(["claude", "fake"]));
    const fake = result.data.agents.find((agent) => agent.name === "fake");
    expect(fake?.default).toBe(true);
    expect(fake?.env_keys).toEqual(["FAKE_FLAG"]);
  });

  it("Session → Prompt → Freigabe → Datei existiert", async () => {
    const session = await client.call<StartSessionResult>("start_session", { cwd: workDir });
    expect(session.isError).toBe(false);
    expect(session.data.current_mode).toBe("default");

    const turn = await client.call<TurnResult>("send_prompt", { session_id: session.data.session_id, text: "write hello.txt hi" });
    expect(turn.data.status).toBe("awaiting_permission");
    const permission = turn.data.pending_permissions[0];
    expect(permission.title).toBe("Write hello.txt");
    expect(turn.data.tool_calls[0].diffs[0]).toMatchObject({ new_text: "hi", old_text: null });
    expect(existsSync(join(workDir, "hello.txt"))).toBe(false);

    const pending = await client.call<{ pending_permissions: Array<{ permission_id: string }> }>("list_pending_permissions");
    expect(pending.data.pending_permissions.map((entry) => entry.permission_id)).toContain(permission.permission_id);

    const answer = await client.call<{ selected_option: { kind: string } }>("respond_permission", {
      permission_id: permission.permission_id,
      decision: "allow",
    });
    expect(answer.data.selected_option.kind).toBe("allow_once");

    let updates: UpdatesResult | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      updates = (await client.call<UpdatesResult>("get_session_updates", { session_id: session.data.session_id, wait_seconds: 2 })).data;
      if (updates.events.some((event) => event.type === "turn_end")) {
        // turn_end und status=idle kommen im selben Abruf an.
        expect(updates.status).toBe("idle");
      }
      if (updates.status === "idle") break;
    }
    expect(updates?.status).toBe("idle");
    expect(updates?.last_turn?.stop_reason).toBe("end_turn");
    expect(updates?.last_turn?.tool_calls[0].status).toBe("completed");
    expect(updates?.last_turn?.response_text).toContain("Fertig");
    expect(readFileSync(join(workDir, "hello.txt"), "utf8")).toBe("hi");
  });

  it("deny schreibt nichts", async () => {
    const session = await client.call<StartSessionResult>("start_session", { cwd: workDir });
    const turn = await client.call<TurnResult>("send_prompt", { session_id: session.data.session_id, text: "write denied.txt nope" });
    await client.call("respond_permission", { permission_id: turn.data.pending_permissions[0].permission_id, decision: "deny" });
    const updates = await client.call<UpdatesResult>("get_session_updates", { session_id: session.data.session_id, wait_seconds: 5 });
    const types = updates.data.events.map((event) => event.type);
    expect(types).toContain("permission_resolved");
    expect(existsSync(join(workDir, "denied.txt"))).toBe(false);
  });

  it("acceptEdits braucht keine Freigabe", async () => {
    const session = await client.call<StartSessionResult>("start_session", { cwd: workDir, mode: "acceptEdits" });
    expect(session.data.current_mode).toBe("acceptEdits");
    const turn = await client.call<TurnResult>("send_prompt", { session_id: session.data.session_id, text: "write auto.txt ok" });
    expect(turn.data.status).toBe("idle");
    expect(readFileSync(join(workDir, "auto.txt"), "utf8")).toBe("ok");
  });

  it("wait=false blockiert nicht; Polling und cancel funktionieren", async () => {
    const session = await client.call<StartSessionResult>("start_session", { cwd: workDir });
    const started = Date.now();
    const turn = await client.call<TurnResult>("send_prompt", { session_id: session.data.session_id, text: "slow", wait: false });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(turn.data.status).toBe("running");

    const updates = await client.call<UpdatesResult>("get_session_updates", { session_id: session.data.session_id, wait_seconds: 2 });
    expect(updates.data.events.some((event) => event.type === "message")).toBe(true);

    const second = await client.call<TurnResult>("send_prompt", { session_id: session.data.session_id, text: "noch einer" });
    expect(second.isError).toBe(true);

    const cancelled = await client.call<TurnResult>("cancel", { session_id: session.data.session_id });
    expect(cancelled.data.status).toBe("idle");
    expect(cancelled.data.stop_reason).toBe("cancelled");
  });

  it("cancel zieht offene Freigaben zurück", async () => {
    const session = await client.call<StartSessionResult>("start_session", { cwd: workDir });
    const turn = await client.call<TurnResult>("send_prompt", { session_id: session.data.session_id, text: "write never.txt x" });
    expect(turn.data.status).toBe("awaiting_permission");
    const cancelled = await client.call<TurnResult>("cancel", { session_id: session.data.session_id });
    expect(cancelled.data.stop_reason).toBe("cancelled");
    expect(cancelled.data.pending_permissions).toHaveLength(0);
    expect(existsSync(join(workDir, "never.txt"))).toBe(false);
  });

  it("close_session beendet die Session", async () => {
    const session = await client.call<StartSessionResult>("start_session", { cwd: workDir });
    const closed = await client.call<{ closed: boolean }>("close_session", { session_id: session.data.session_id });
    expect(closed.data.closed).toBe(true);
    const after = await client.call("send_prompt", { session_id: session.data.session_id, text: "hallo" });
    expect(after.isError).toBe(true);
  });

  it("auth_status meldet die Identität ohne E-Mail", async () => {
    const status = await client.call<AuthStatusResult>("auth_status", { agent: "fake" });
    expect(status.data.agent_reported).toEqual({ kind: "account", label: "Fake Max", plan: "max" });
    expect(status.text).not.toContain("secret@example.com");
    expect(status.data.auth_methods.map((method) => method.id)).toEqual(["fake-login", "fake-agent-auth"]);
  });

  it("authenticate: Terminal-Methode liefert nur den Befehl, Agent-Methode wird ausgeführt", async () => {
    const terminal = await client.call<{ command: string }>("authenticate", { agent: "fake", method_id: "fake-login" });
    expect(terminal.data.command).toContain("--login");
    const direct = await client.call<{ result: string }>("authenticate", { agent: "fake", method_id: "fake-agent-auth" });
    expect(direct.data.result).toBe("authenticate erfolgreich");
  });

  it("auth_status: api_key-Modus ohne Key startet Claude nicht", async () => {
    const status = await client.call<AuthStatusResult>("auth_status", { agent: "claude" });
    expect(status.data.auth_mode).toBe("api_key");
    expect(status.data.hide_claude_auth).toBe(true);
    expect(status.data.credentials.anthropic_api_key_set).toBe(false);
    expect(status.data.problem).toContain("ANTHROPIC_API_KEY");
    const session = await client.call("start_session", { cwd: workDir, agent: "claude" });
    expect(session.isError).toBe(true);
  });

  it("lehnt relative cwd ab", async () => {
    const session = await client.call("start_session", { cwd: "relativ/pfad" });
    expect(session.isError).toBe(true);
  });
});
