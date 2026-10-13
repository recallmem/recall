import { z } from "zod";
import type { AppContext } from "../../context.js";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  listWebhookEndpoints,
  sendTestWebhook,
} from "../../core/webhooks.js";
import { tooManyRequests } from "../../lib/errors.js";
import type { App } from "../app.js";
import { guard, wsOf } from "../auth.js";
import { CREATED_KEY_TYPES, readPaging } from "../pagination.js";
import { parseBody } from "../validate.js";

const WebhookEndpointCreate = z.object({ url: z.string().min(1) });
const TESTS_PER_MIN = 6;

/** Workspace or admin token required: no peer/session parameter on these routes, so the default guard denies the rest. */
export function register(app: App, ctx: AppContext): void {
  app.post("/v3/workspaces/:workspace_id/webhooks", guard(ctx), async (c) => {
    const body = await parseBody(c, WebhookEndpointCreate);
    const { endpoint, created } = await createWebhookEndpoint(ctx, wsOf(c), body.url);
    return c.json(endpoint, created ? 201 : 200);
  });

  app.get("/v3/workspaces/:workspace_id/webhooks", guard(ctx), async (c) => {
    const workspace = wsOf(c);
    const paging = readPaging(c, {
      fingerprint: ["webhooks", workspace],
      keyTypes: CREATED_KEY_TYPES,
      reverse: false,
    });
    return c.json(await listWebhookEndpoints(ctx, workspace, paging));
  });

  // Registered before the parameterised route so "test" is never read as an endpoint id.
  app.get("/v3/workspaces/:workspace_id/webhooks/test", guard(ctx), async (c) => {
    // Each call queues a delivery per endpoint: a few a minute is plenty for a test.
    const ws = wsOf(c);
    const wait = ctx.tenancy.limiter.take(`webhook-test:${JSON.stringify(ws)}`, TESTS_PER_MIN);
    if (wait > 0)
      throw tooManyRequests(
        wait,
        `At most ${TESTS_PER_MIN} test deliveries a minute per workspace`,
      );
    await sendTestWebhook(ctx, ws);
    return c.json(null);
  });

  app.delete("/v3/workspaces/:workspace_id/webhooks/:endpoint_id", guard(ctx), async (c) => {
    await deleteWebhookEndpoint(ctx, wsOf(c), c.req.param("endpoint_id"));
    return c.body(null, 204);
  });
}
