import { z } from "zod";
import type { AppContext } from "../../context.js";
import {
  conclusionHistory,
  createConclusions,
  deleteConclusion,
  getConclusion,
  listConclusions,
  pinConclusion,
  queryConclusions,
  setConclusionExpiry,
} from "../../core/conclusions.js";
import { parseEventDate } from "../../lib/event-time.js";
import type { App } from "../app.js";
import { guard, wsOf } from "../auth.js";
import { FiltersBody, optionalBody } from "../common.js";
import { CREATED_KEY_TYPES, readPaging } from "../pagination.js";
import { parseBody } from "../validate.js";

const IsoTime = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "Expected an ISO 8601 date or date-time");

const EventDate = z
  .string()
  .refine((v) => parseEventDate(v) !== null, "Expected a date: YYYY, YYYY-MM or YYYY-MM-DD");

const ConclusionCreate = z
  .object({
    content: z.string().min(1).max(65_535),
    observer_id: z.string().min(1),
    observed_id: z.string().min(1),
    session_id: z.string().min(1).nullish(),
    // Recall: when what the fact describes happened or began, and the last day of a span.
    event_start: EventDate.nullish(),
    event_end: EventDate.nullish(),
    tags: z.array(z.string().min(1).max(40)).max(6).nullish(),
    pinned: z.boolean().nullish(),
    expires_at: IsoTime.nullish(),
  })
  .superRefine((c, ctx) => {
    if (c.event_end && !c.event_start)
      ctx.addIssue({ code: "custom", path: ["event_end"], message: "event_end needs event_start" });
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

/** Recall: `as_of` lists what held on that date (begun by then, not yet replaced). */
const ConclusionList = FiltersBody.extend({
  as_of: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "Expected an ISO 8601 date or date-time")
    .nullish(),
});

const ConclusionPatch = z
  .object({ pinned: z.boolean().optional(), expires_at: IsoTime.nullable().optional() })
  .refine((b) => b.pinned !== undefined || b.expires_at !== undefined, {
    message: "Send pinned or expires_at",
  });

const ConclusionQuery = z.object({
  query: z.string().min(1).max(10_000),
  top_k: z.number().int().min(1).max(100).default(10),
  distance: z.number().min(0).max(1).nullish(),
  filters: z.record(z.string(), z.unknown()).nullish(),
  // Recall: each result gives its rank and distance.
  explain: z.boolean().optional(),
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
    const body = await optionalBody(c, ConclusionList);
    const asOf = body?.as_of ? new Date(body.as_of) : null;
    const paging = readPaging(c, {
      fingerprint: ["conclusions", workspace, body?.filters ?? null, body?.as_of ?? null],
      keyTypes: CREATED_KEY_TYPES,
    });
    return c.json(await listConclusions(ctx, workspace, paging, body?.filters, asOf));
  });

  app.post("/v3/workspaces/:workspace_id/conclusions/query", guard(ctx), async (c) => {
    const body = await parseBody(c, ConclusionQuery);
    return c.json(await queryConclusions(ctx, wsOf(c), body));
  });

  app.get("/v3/workspaces/:workspace_id/conclusions/:conclusion_id", guard(ctx), async (c) => {
    return c.json(await getConclusion(ctx, wsOf(c), c.req.param("conclusion_id")));
  });

  // Recall: pin or unpin a fact.
  app.patch("/v3/workspaces/:workspace_id/conclusions/:conclusion_id", guard(ctx), async (c) => {
    const body = await parseBody(c, ConclusionPatch);
    const id = c.req.param("conclusion_id");
    if (body.expires_at !== undefined)
      await setConclusionExpiry(
        ctx,
        wsOf(c),
        id,
        body.expires_at ? new Date(body.expires_at) : null,
      );
    if (body.pinned !== undefined)
      return c.json(await pinConclusion(ctx, wsOf(c), id, body.pinned));
    return c.json(await getConclusion(ctx, wsOf(c), id));
  });

  // Recall: what happened to a fact, who did it and why.
  app.get(
    "/v3/workspaces/:workspace_id/conclusions/:conclusion_id/history",
    guard(ctx),
    async (c) => c.json(await conclusionHistory(ctx, wsOf(c), c.req.param("conclusion_id"))),
  );

  app.delete("/v3/workspaces/:workspace_id/conclusions/:conclusion_id", guard(ctx), async (c) => {
    await deleteConclusion(ctx, wsOf(c), c.req.param("conclusion_id"));
    return c.body(null, 204);
  });
}
