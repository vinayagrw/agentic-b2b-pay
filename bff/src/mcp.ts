/** MCP server for external agents (Claude, ChatGPT and others). Read-only copilot tools only, no write tools.
 * Auth is a scoped tenant token (mcp_test_...) with an expiry, created on the Developers page. Every call goes to the evidence chain. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as CP from "./copilot.js";
import * as SP from "./sparky.js";
import type * as P from "./platform.js";

/** One server per token. Only the tools the token is scoped for are listed. */
export function buildMcpServer(token: SP.McpToken, user: P.User) {
  const server = new McpServer({ name: "agentic-b2b-pay-copilot", version: "0.1.0" });
  for (const t of CP.TOOLS.filter((x) => !x.operator && token.tools.includes(x.name))) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const a of t.args) shape[a] = z.string().describe("Record id, for example pi-12 or sup-northwind");
    for (const a of t.opt ?? []) shape[a] = z.string().optional();
    server.registerTool(t.name, { title: t.name, description: `${t.description}. Read-only, tenant ${token.tenantId} only.`, inputSchema: shape, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, async (args: Record<string, unknown>) => {
      const r = SP.mcpCall(token, user, t.name, Object.fromEntries(Object.entries(args ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
      return r.error ? { isError: true, content: [{ type: "text" as const, text: r.error }] } : { content: [{ type: "text" as const, text: JSON.stringify({ summary: r.summary, rows: r.rows.slice(0, 50), sources: r.source }) }] };
    });
  }
  return server;
}
