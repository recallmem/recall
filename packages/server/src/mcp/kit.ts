import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { WsKey } from "../core/tenancy.js";
import { rows } from "../db/client.js";
import { type AuthState, canUseWorkspace } from "../http/auth.js";
import type { Paging } from "../http/pagination.js";
import { ValidationError } from "../http/validate.js";
import { ApiError } from "../lib/errors.js";
import { iso } from "../lib/time.js";
import { LlmError } from "../llm/types.js";
import {
  getPeer,
  getSession,
  getWorkspace,
  type PeerRef,
  type SessionRef,
  type WsRef,
} from "../recall/lookup.js";
import type { ConclusionRow } from "../recall/search.js";

/**
 * Pieces shared by both MCP toolsets (the curated default in `tools.ts` and the
 * full profile in `full/`): the per-connection session, error handling, common
 * argument schemas, tenancy-checked resolution helpers and tool registration.
 */

export interface McpSession {
  workspace: string;
  /** Default `peer_id`, from `X-Recall-User-Name`. */
  user: string | null;
  /** Default `session_id`, from `X-Recall-Session-ID`. */
  session: string | null;
  auth: AuthState;
}

/** A failure the model can act on; its message is shown verbatim. */
export class ToolError extends Error {}

export const fail = (message: string): never => {
  throw new ToolError(message);
};

export function describeError(ctx: AppContext, err: unknown): string {
  if (err instanceof ToolError) return err.message;
  if (err instanceof ApiError) return err.detail;
  if (err instanceof ValidationError) {
    return err.detail.map((d) => `${d.loc.slice(1).join(".") || "input"}: ${d.msg}`).join("; ");
  }
  if (err instanceof LlmError) {
    if (err.kind === "refusal") return "The model declined to answer this request";
    return "The language model provider is unavailable";
  }
  ctx.log.error({ err }, "mcp tool failed");
  return "An unexpected error occurred";
}

export const asText = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
});

// ---------------------------------------------------------------------------
// Shared argument schemas
// ---------------------------------------------------------------------------

export const existingId = z.string().min(1).max(512);
export const workspaceArg = existingId
  .optional()
  .describe("Workspace to use. Defaults to this connection's workspace.");
export const peerArg = (what: string) =>
  existingId.optional().describe(`${what} Defaults to this connection's user.`);
export const sessionArg = (what: string) =>
  existingId.optional().describe(`${what} Defaults to this connection's session when it has one.`);
export const reasoningLevel = z
  .enum(["minimal", "low", "medium", "high", "max"])
  .optional()
  .describe("How hard to think. minimal/low are fast and cheap; high/max dig deeper. Default low.");
export const pageArgs = {
  page: z.number().int().min(1).optional().describe("Page number, from 1."),
  size: z.number().int().min(1).max(100).optional().describe("Items per page (default 20)."),
  reverse: z.boolean().optional().describe("Oldest first instead of newest first."),
};

/** Row count of a page: offset pages carry the total, anything else falls back to what it holds. */
export const totalOf = (page: { total: number | null; items: unknown[] }): number =>
  page.total ?? page.items.length;

/** A `Paging` for the offset-paginated core listings (MCP has no cursors). */
export function pagingOf(a: { page?: number; size?: number; reverse?: boolean }): Paging {
  return {
    page: a.page ?? 1,
    size: a.size ?? 20,
    reverse: a.reverse ?? false,
    cursorMode: false,
    cursorRaw: null,
    cursor: null,
    fingerprint: "mcp",
  };
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/** The workspace a call acts on, checked against the token's workspace claim. */
export function workspaceFor(s: McpSession, arg: string | undefined): WsKey {
  const workspace = arg ?? s.workspace;
  if (!canUseWorkspace(s.auth, workspace)) {
    throw new ToolError(`This token cannot access workspace '${workspace}'`);
  }
  // Always within the caller's account: an admin key reaches every workspace of its own account only.
  return { account: s.auth.account, name: workspace };
}

export async function requireWorkspace(ctx: AppContext, key: WsKey): Promise<WsRef> {
  return (
    (await getWorkspace(ctx, key)) ??
    fail(
      `Workspace '${key.name}' not found. Record something first with add_messages_to_session, or check the workspace id.`,
    )
  );
}

export async function requirePeer(ctx: AppContext, ws: WsRef, name: string): Promise<PeerRef> {
  const peer = await getPeer(ctx, ws.id, name);
  if (!peer) fail(`Peer '${name}' not found in workspace '${ws.name}'.`);
  return peer!;
}

export async function requireSession(
  ctx: AppContext,
  ws: WsRef,
  name: string,
): Promise<SessionRef> {
  const session = await getSession(ctx, ws.id, name);
  if (!session) fail(`Session '${name}' not found in workspace '${ws.name}'.`);
  return session!;
}

export const needPeer = (value: string | undefined | null): string =>
  value ??
  fail(
    "peer_id is required: pass the person this is about, or reconnect Recall and fill in Default peer.",
  );

/** The person a call is about when nothing names one and the workspace has nobody yet. */
export const DEFAULT_PERSON = "user";

/**
 * Who a call is about: the peer_id argument, else the connection's default person, else the only
 * person the workspace remembers facts about, else "user" (a first write starts that memory). Chat
 * apps cannot set X-Recall-User-Name, and a connection may have no default person: with several
 * people the error names them, so the model can pick one.
 */
export async function personFor(
  ctx: AppContext,
  s: McpSession,
  key: WsKey,
  explicit: string | null | undefined,
): Promise<string>;
/** With `several: "none"`, several people yield null (the caller then works across all of them). */
export async function personFor(
  ctx: AppContext,
  s: McpSession,
  key: WsKey,
  explicit: string | null | undefined,
  opts: { several: "none" },
): Promise<string | null>;
export async function personFor(
  ctx: AppContext,
  s: McpSession,
  key: WsKey,
  explicit: string | null | undefined,
  opts?: { several: "none" },
): Promise<string | null> {
  const named = explicit ?? s.user;
  if (named) return named;
  const ws = await getWorkspace(ctx, key);
  if (!ws) return DEFAULT_PERSON;
  const people = await rows<{ name: string }>(
    ctx.db,
    sql`SELECT p.name FROM peers p
        WHERE p.workspace_id = ${ws.id} AND NOT p.is_scope
          AND EXISTS (SELECT 1 FROM conclusions c
                      WHERE c.workspace_id = p.workspace_id AND c.observer_id = p.id
                        AND c.observed_id = p.id AND c.deleted_at IS NULL)
        ORDER BY p.name LIMIT 6`,
  );
  if (people.length === 0) return DEFAULT_PERSON;
  if (people.length === 1) return people[0]!.name;
  if (opts?.several === "none") return null;
  const names = people.slice(0, 5).map((p) => p.name);
  return fail(
    `This memory has facts about several people (${names.join(", ")}${people.length > 5 ? ", ..." : ""}). Pass peer_id with the person you mean.`,
  );
}

export const conclusionBrief = (r: ConclusionRow) => ({
  id: r.id,
  content: r.content,
  level: r.level,
  observer_id: r.observerName,
  observed_id: r.observedName,
  session_id: r.sessionName,
  times_derived: r.timesDerived,
  created_at: iso(r.createdAt),
});

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export interface ToolDef<S extends z.ZodObject> {
  name: string;
  title: string;
  /** Used in the error text: "Failed to <action>: ...". */
  action: string;
  description: string;
  schema: S;
  readOnly: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  run(args: z.infer<S>, s: McpSession): Promise<unknown>;
}

export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/** Registers one tool. Failures come back as `isError` results, never as protocol errors. */
export type AddTool = <S extends z.ZodObject>(def: ToolDef<S>) => void;

export function toolAdder(server: McpServer, ctx: AppContext, s: McpSession): AddTool {
  return <S extends z.ZodObject>(def: ToolDef<S>) => {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.schema as z.ZodObject,
        annotations: {
          title: def.title,
          // Every hint as an explicit boolean: directories (OpenAI's) reject tools that leave one out.
          readOnlyHint: def.readOnly,
          destructiveHint: !def.readOnly && (def.destructive ?? false),
          idempotentHint: def.readOnly || (def.idempotent ?? false),
          openWorldHint: false,
        },
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          return asText(await def.run(args as z.infer<S>, s));
        } catch (err) {
          return {
            isError: true,
            content: [
              { type: "text", text: `Failed to ${def.action}: ${describeError(ctx, err)}` },
            ],
          };
        }
      },
    );
  };
}
