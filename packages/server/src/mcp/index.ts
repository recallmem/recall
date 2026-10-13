import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context, MiddlewareHandler } from "hono";
import type { AppContext } from "../context.js";
import type { App } from "../http/app.js";
import { type AppEnv, canUseWorkspace, guard } from "../http/auth.js";
import { ApiError, badRequest, unauthorized } from "../lib/errors.js";
import { NAME_MAX, NAME_PATTERN } from "../lib/ids.js";
import { VERSION } from "../version.js";
import { registerFullTools } from "./full/index.js";
import { FULL_INSTRUCTIONS, MCP_INSTRUCTIONS, MCP_INSTRUCTIONS_AUTO } from "./instructions.js";
import type { McpSession } from "./kit.js";
import { registerTools } from "./tools.js";

/**
 * MCP endpoint (Streamable HTTP) served by the same process as the REST API.
 *
 *   POST /mcp   JSON-RPC in, JSON out. Stateless: every request gets its own
 *               server and transport, so there is no session map to expire,
 *               nothing to share between instances, and a restart loses nothing.
 *
 * Auth is the API's bearer token (a workspace or admin JWT; peer and session
 * tokens are refused because they cannot name a workspace). With auth disabled
 * the endpoint is open, like the rest of the API. In hosted mode with OAuth on
 * (http/routes/oauth.ts) it also accepts OAuth access tokens, and its 401s point
 * clients at the protected resource metadata (RFC 9728) so they can sign in.
 *
 * Connection defaults come from headers:
 *   X-Recall-Workspace-ID  (or X-Honcho-Workspace-ID)  default workspace; else the token's, else "default"
 *   X-Recall-User-Name     (or X-Honcho-User-Name)     default peer_id; else the OAuth grant's
 *   X-Recall-Session-ID    default session_id
 *   X-Recall-MCP-Profile   "full" (or ?profile=full) serves all 40 tools of the reference's MCP
 *                            server instead of the curated eight; see ./full/index.ts
 */

export type McpProfile = "default" | "full";

const DEFAULT_WORKSPACE = "default";

function idHeader(c: Context, names: string[]): string | undefined {
  for (const name of names) {
    const value = c.req.header(name)?.trim();
    if (!value) continue;
    if (value.length > NAME_MAX || !NAME_PATTERN.test(value)) {
      throw badRequest(
        `Invalid ${name}: ids are 1-${NAME_MAX} characters of a-z, A-Z, 0-9, _ and -`,
      );
    }
    return value;
  }
  return undefined;
}

/** `X-Recall-MCP-Profile` header, else `?profile=`; unset means the curated default. */
function profileOf(c: Context): McpProfile {
  const raw = (c.req.header("x-recall-mcp-profile") ?? c.req.query("profile") ?? "")
    .trim()
    .toLowerCase();
  if (raw === "" || raw === "default") return "default";
  if (raw === "full") return "full";
  throw badRequest(
    `Unknown MCP profile '${raw}': use 'full' for every tool, or leave it out for the default eight`,
  );
}

/**
 * The protected resource metadata URL for this request (RFC 9728 3.1: the
 * well-known suffix goes between the host and the path, a query stays at the end).
 */
export function resourceMetadataUrl(ctx: AppContext, c: Context): string {
  const { issuer } = ctx.config.hosted.oauth;
  const full = c.req.query("profile")?.trim().toLowerCase() === "full";
  return `${issuer}/.well-known/oauth-protected-resource/mcp${full ? "?profile=full" : ""}`;
}

/**
 * A 401 with a `WWW-Authenticate` challenge, so MCP clients know a bearer token
 * is expected. With OAuth on, every 401 of this endpoint carries one that names
 * the protected resource metadata (and `error="invalid_token"` when a token was
 * sent but refused), which is how clients discover where to sign in.
 */
function challengeHeader(ctx: AppContext, c: Context, error?: string): string {
  return ctx.config.hosted.oauth.enabled
    ? `Bearer realm="recall", resource_metadata="${resourceMetadataUrl(ctx, c)}", scope="memory"${
        error ? `, error="${error}"` : ""
      }`
    : 'Bearer realm="recall"';
}

function challenge(ctx: AppContext): MiddlewareHandler<AppEnv> {
  const oauth = ctx.config.hosted.oauth.enabled;
  const header = (c: Context, error?: string) => challengeHeader(ctx, c, error);
  return async (c, next) => {
    if (ctx.config.auth.enabled && !/^Bearer\s+\S/i.test(c.req.header("authorization") ?? "")) {
      return c.json({ detail: "No access token provided" }, 401, {
        "WWW-Authenticate": header(c),
      });
    }
    await next();
    if (oauth && c.res.status === 401 && !c.res.headers.has("WWW-Authenticate"))
      c.res.headers.set("WWW-Authenticate", header(c, "invalid_token"));
  };
}

export function createMcpServer(
  ctx: AppContext,
  session: McpSession,
  profile: McpProfile = "default",
): McpServer {
  const server = new McpServer(
    { name: "Recall", version: VERSION },
    {
      instructions:
        profile === "full"
          ? FULL_INSTRUCTIONS
          : session.auth.defaults?.autoRemember
            ? MCP_INSTRUCTIONS_AUTO
            : MCP_INSTRUCTIONS,
      capabilities: { tools: {} },
    },
  );
  (profile === "full" ? registerFullTools : registerTools)(server, ctx, session);
  return server;
}

/** The transport insists on both media types in `Accept`; be lenient with clients that omit one. */
function withAccept(req: Request): Request {
  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("application/json") && accept.includes("text/event-stream")) return req;
  const headers = new Headers(req.headers);
  headers.set("accept", "application/json, text/event-stream");
  return new Request(req, { headers });
}

export function register(app: App, ctx: AppContext): void {
  const handle = async (c: Context<AppEnv>) => {
    const auth = c.get("auth");
    const profile = profileOf(c);
    const workspace =
      idHeader(c, ["x-recall-workspace-id", "x-honcho-workspace-id"]) ??
      auth.defaults?.workspace ??
      auth.claims.w ??
      DEFAULT_WORKSPACE;
    if (!canUseWorkspace(auth, workspace)) {
      // With OAuth discovery on, a valid token that does not reach the workspace is a 403
      // (RFC 6750 insufficient_scope): a 401 would read as a bad token and send clients round
      // the sign-in loop again. Without OAuth, a 401 as before.
      if (!ctx.config.hosted.oauth.enabled) throw unauthorized();
      throw new ApiError(
        403,
        `This ${auth.via === "oauth" ? "connection" : "credential"} cannot use workspace '${workspace}'`,
        { "WWW-Authenticate": challengeHeader(ctx, c, "insufficient_scope") },
      );
    }
    const session: McpSession = {
      workspace,
      user:
        idHeader(c, ["x-recall-user-name", "x-honcho-user-name"]) ?? auth.defaults?.peer ?? null,
      session: idHeader(c, ["x-recall-session-id"]) ?? null,
      auth,
    };

    // One JSON-RPC message per request: the rate limit is charged per HTTP request, and a batch
    // of a hundred tool calls would multiply it. MCP itself dropped batches (2025-06-18).
    if ((await c.req.raw.clone().text()).trimStart().startsWith("["))
      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32600,
            message: "Batch requests are not supported; send one message per request",
          },
          id: null,
        },
        400,
      );
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = createMcpServer(ctx, session, profile);
    await server.connect(transport);
    try {
      return await transport.handleRequest(withAccept(c.req.raw));
    } finally {
      // JSON mode has fully written the response by the time handleRequest resolves.
      await server.close();
    }
  };

  const notAllowed = (c: Context) =>
    c.json({ detail: "This MCP endpoint is stateless: POST JSON-RPC messages to it" }, 405, {
      Allow: "POST",
    });

  for (const path of ["/mcp", "/mcp/"]) {
    app.post(path, challenge(ctx), guard(ctx, { oauth: true }), handle);
    app.on(["GET", "DELETE"], path, notAllowed);
  }
}
