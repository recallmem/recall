import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../../context.js";
import { type McpSession, toolAdder } from "../kit.js";
import { registerConclusionTools } from "./conclusions.js";
import { registerPeerTools } from "./peers.js";
import { registerScopeTools } from "./scopes.js";
import { registerSessionTools } from "./sessions.js";
import { registerWorkspaceTools } from "./workspace.js";

/**
 * The `full` MCP profile: the complete 40-tool surface of the reference's MCP
 * server (workspaces, peers, sessions, scopes, conclusions, system), with its
 * tool and argument names, opt-in through `X-Recall-MCP-Profile: full` or
 * `?profile=full`. Differences from the reference are all in the safe
 * direction: read-only tools never create anything (an unknown workspace,
 * peer or session is an error), `workspace_id` is always optional, and a few
 * tools accept extra optional arguments (e.g. `idempotency_key`).
 */
export function registerFullTools(server: McpServer, ctx: AppContext, s: McpSession): void {
  const add = toolAdder(server, ctx, s);
  registerWorkspaceTools(add, ctx);
  registerPeerTools(add, ctx);
  registerSessionTools(add, ctx);
  registerScopeTools(add, ctx);
  registerConclusionTools(add, ctx);
}
