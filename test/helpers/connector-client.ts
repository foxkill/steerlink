import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const FAKE_AGENT_PATH = join(root, "test", "fixtures", "fake-agent.ts");

export interface ToolCallOutcome<T> {
  isError: boolean;
  text: string;
  data: T;
}

/** MCP-Client, der den Connector als stdio-Subprozess startet – genau wie Grok Bot. */
export class ConnectorClient {
  private readonly client = new Client({ name: "connector-test", version: "1.0.0" });
  private transport: StdioClientTransport | undefined;

  async connect(env: Record<string, string>, useDist: boolean = false): Promise<void> {
    const args = useDist ? [join(root, "dist", "main.js")] : ["--import", "tsx", join(root, "src", "main.ts")];
    const baseEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        baseEnv[key] = value;
      }
    }
    this.transport = new StdioClientTransport({
      command: process.execPath,
      args,
      env: { ...baseEnv, ...env },
      cwd: root,
      stderr: "pipe",
    });
    await this.client.connect(this.transport);
  }

  async listToolNames(): Promise<string[]> {
    const result = await this.client.listTools();
    return result.tools.map((tool) => tool.name);
  }

  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<ToolCallOutcome<T>> {
    const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.map((item) => item.text ?? "").join("\n");
    const isError = result.isError === true;
    let data = {} as T;
    if (!isError) {
      data = JSON.parse(text) as T;
    }
    return { isError, text, data };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
