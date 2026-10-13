import { z } from "zod";
import type { AppContext } from "../../context.js";
import {
  createConclusions,
  deleteConclusion,
  getConclusion,
  listConclusions,
  queryConclusions,
} from "../../core/conclusions.js";
import type { App } from "../app.js";
import { guard, wsOf } from "../auth.js";
import { FiltersBody, optionalBody } from "../common.js";
import { CREATED_KEY_TYPES, readPaging } from "../pagination.js";
import { parseBody } from "../validate.js";

const ConclusionCreate = z.object({
  content: z.string().min(1).max(65_535),
  observer_id: z.string().min(1),
  observed_id: z.string().min(1),
  session_id: z.string().min(1).nullish(),
});

/** `conclusions` is the key; `observations` is the legacy alias older clients still send. */
const ConclusionBatchCreate = z
  .object({
    conclusions: z.array(ConclusionCreate).min(1).max(100).optional(),
    observations: z.array(ConclusionCreate).min(1).max(100).optional(),
  })
  .transform((body, ctx) => {
    const items = body.conclusions ?? body.observations;
    if (!items) {
      ctx.addIssue({ code: "custom", path: ["conclusions"], message: "Field required" });
      return z.NEVER;
    }
    return items;
  });

const ConclusionQuery = z.object({
  query: z.string().min(1).max(10_000),
  top_k: z.number().int().min(1).max(100).default(10),
  distance: z.number().min(0).max(1).nullish(),
  filters: z.record(z.string(), z.unknown()).nullish(),
});

export function register(app: App, ctx: AppContext): void {
  // Conclusion routes need a workspace or admin token: the default guard denies
  // peer and session tokens because these routes declare no peer/session parameter.
  app.post("/v3/workspaces/:workspace_id/conclusions", guard(ctx), async (c) => {
    const items = await parseBody(c, ConclusionBatchCreate);
    return c.json(await createConclusions(ctx, wsOf(c), items), 201);
  });

  app.post("/v3/workspaces/:workspace_id/conclusions/list", guard(ctx), async (c) => {
    const workspace = wsOf(c);
    const body = await optionalBody(c, FiltersBody);
    const paging = readPaging(c, {
      fingerprint: ["conclusions", workspace, body?.filters ?? null],
      keyTypes: CREATED_KEY_TYPES,
    });
    return c.json(await listConclusions(ctx, workspace, paging, body?.filters));
  });

  app.post("/v3/workspaces/:workspace_id/conclusions/query", guard(ctx), async (c) => {
    const body = await parseBody(c, ConclusionQuery);
    return c.json(await queryConclusions(ctx, wsOf(c), body));
  });

  app.get("/v3/workspaces/:workspace_id/conclusions/:conclusion_id", guard(ctx), async (c) => {
    return c.json(await getConclusion(ctx, wsOf(c), c.req.param("conclusion_id")));
  });

  app.delete("/v3/workspaces/:workspace_id/conclusions/:conclusion_id", guard(ctx), async (c) => {
    await deleteConclusion(ctx, wsOf(c), c.req.param("conclusion_id"));
    return c.body(null, 204);
  });
}
