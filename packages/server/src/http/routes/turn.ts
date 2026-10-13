import { z } from "zod";
import type { AppContext } from "../../context.js";
import { createMessages } from "../../core/messages.js";
import { messageBatchCreate } from "../../core/schemas.js";
import { sessionContext, validateContextParams } from "../../recall/session-context.js";
import type { App } from "../app.js";
import { guard, wsOf } from "../auth.js";
import { parseBody } from "../validate.js";

/**
 * `POST /v3/workspaces/{ws}/sessions/{sid}/turn` (Recall extension).
 *
 * One round trip for an agent turn: store the new messages, then return the
 * session context (summary, recent messages, and the peer representation/card
 * when `peer_target` is given) so the caller can build its next prompt. The
 * messages go through the same service as `POST …/messages`, so the
 * `Idempotency-Key` header makes a retried turn safe, and the same token rules
 * apply (a peer token cannot write; a session token may for its own session).
 */

const TurnContext = z.object({
  tokens: z.number().int().min(0).max(100_000).nullish(),
  summary: z.boolean().nullish(),
  peer_target: z.string().min(1).nullish(),
  peer_perspective: z.string().min(1).nullish(),
  limit_to_session: z.boolean().nullish(),
  search_query: z.string().min(1).max(10_000).nullish(),
  max_conclusions: z.number().int().min(1).max(100).nullish(),
});

const TurnBody = messageBatchCreate.extend({ context: TurnContext.nullish() });

export function register(app: App, ctx: AppContext): void {
  app.post("/v3/workspaces/:workspace_id/sessions/:session_id/turn", guard(ctx), async (c) => {
    const workspace = wsOf(c);
    const session = c.req.param("session_id");
    const body = await parseBody(c, TurnBody);
    const opts = body.context ?? {};
    const contextParams = {
      workspace,
      session,
      tokens: opts.tokens ?? null,
      summary: opts.summary ?? true,
      peerTarget: opts.peer_target ?? null,
      peerPerspective: opts.peer_perspective ?? null,
      scope: null,
      sessions: null,
      limitToSession: opts.limit_to_session ?? false,
      searchQuery: opts.search_query ?? null,
      searchTopK: null,
      searchMaxDistance: null,
      includeMostFrequent: false,
      maxConclusions: opts.max_conclusions ?? 100,
      auth: c.get("auth"),
    };
    // Reject a bad context request before anything is written.
    validateContextParams(contextParams);

    const { messages } = await createMessages(ctx, {
      workspace,
      session,
      messages: body.messages,
      idempotencyKey: c.req.header("idempotency-key"),
    });
    return c.json({ messages, context: await sessionContext(ctx, contextParams) }, 201);
  });
}
