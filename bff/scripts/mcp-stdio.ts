/** stdio MCP server. Usage: MCP_TOKEN=mcp_test_... npx tsx scripts/mcp-stdio.ts. Uses the same database as the BFF. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "../src/mcp.js";
import * as SP from "../src/sparky.js";

const a = SP.mcpAuth(String(process.env.MCP_TOKEN ?? ""));
if ("error" in a) { console.error(`MCP_TOKEN rejected: ${a.error}`); process.exit(1); }
await buildMcpServer(a.token, a.user).connect(new StdioServerTransport());
