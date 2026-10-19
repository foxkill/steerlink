#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConnectorConfig } from "./config/connector-config.js";
import { createMcpServer } from "./mcp/mcp-server.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info.js";
import { SessionManager } from "./sessions/session-manager.js";

async function main(): Promise<void> {
    // stdout gehört allein dem MCP-Protokoll. Schreibt eine Bibliothek per
    // console.log, landet das auf stderr statt im JSON-RPC-Strom.
    // oxlint-disable-next-line no-console
    console.log = console.error;

    const config = loadConnectorConfig();
    const manager = new SessionManager(config, process.env.ACP_CONNECTOR_DEBUG === "1");
    const server = createMcpServer(manager);

    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        await manager.shutdown();
        await server.close();
        process.exit(0);
    };
    // Letzte Sicherung, falls der Prozess anders endet (z. B. ein Fehler): keine verwaisten Agents.
    process.on("exit", () => {
        manager.killAll();
    });
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    process.stdin.on("close", () => void shutdown());

    await server.connect(new StdioServerTransport());
    console.error(
        `${PACKAGE_NAME} ${PACKAGE_VERSION} bereit (Agents: ${Object.keys(config.agent_servers).join(", ")}, auth_mode=${config.auth_mode})`,
    );
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}
