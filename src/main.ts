#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConnectorConfig } from "./config/connector-config.js";
import { createMcpServer } from "./mcp/mcp-server.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info.js";
import { SessionManager } from "./sessions/session-manager.js";

async function main(): Promise<void> {
    // stdout belongs to the MCP protocol alone. If a library writes via
    // console.log, it ends up on stderr instead of in the JSON-RPC stream.
    // oxlint-disable-next-line no-console
    console.log = console.error;

    const config = loadConnectorConfig();
    const debug = process.env.ACP_CONNECTOR_DEBUG === "1";
    const manager = new SessionManager(config, debug);
    // Only for tests: a short interval, so progress notifications show up within seconds.
    const progressIntervalMs = Number(process.env.ACP_CONNECTOR_PROGRESS_INTERVAL_MS) || undefined;
    const server = createMcpServer(manager, { progressIntervalMs, debug });

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
    // Last line of defense in case the process ends some other way (e.g. an error): no orphaned agents.
    process.on("exit", () => {
        manager.killAll();
    });
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    process.stdin.on("close", () => void shutdown());

    await server.connect(new StdioServerTransport());
    console.error(
        `${PACKAGE_NAME} ${PACKAGE_VERSION} ready (agents: ${Object.keys(config.agent_servers).join(", ")}, auth_mode=${config.auth_mode})`,
    );
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}
