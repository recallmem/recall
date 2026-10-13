import { z } from "zod";
import type { AppContext } from "../../context.js";
import { configuration, metadata, newName } from "../../core/schemas.js";
import {
  deleteWorkspace,
  getOrCreateWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
} from "../../core/workspaces.js";
import { unauthorized } from "../../lib/errors.js";
import type { App } from "../app.js";
import { guard, wsOf } from "../auth.js";
import { FiltersBody, optionalBody } from "../common.js";
import { CREATED_KEY_TYPES, readPaging } from "../pagination.js";
import { parseBody } from "../validate.js";

const WorkspaceCreate = z.object({
  id: newName,
  metadata: metadata.nullish(),
  configuration: configuration.nullish(),
});

const WorkspaceUpdate = z.object({
  metadata: metadata.nullish(),
  configuration: configuration.nullish(),
});

export function register(app: App, ctx: AppContext): void {
  // Self-authorizing: the resource id is in the body.
  app.post("/v3/workspaces", guard(ctx, { selfAuthorizing: true }), async (c) => {
    const body = await parseBody(c, WorkspaceCreate);
    const { admin, claims } = c.get("auth");
    if (!admin && claims.w !== body.id) throw unauthorized("Unauthorized access to resource");
    const { workspace, created } = await getOrCreateWorkspace(ctx, c.get("auth").account, body);
    return c.json(workspace, created ? 201 : 200);
  });

  app.post("/v3/workspaces/list", guard(ctx, { admin: true }), async (c) => {
    const body = await optionalBody(c, FiltersBody);
    const paging = readPaging(c, {
      fingerprint: ["workspaces", body?.filters ?? null],
      keyTypes: CREATED_KEY_TYPES,
    });
    // Only the caller's account: an admin key (or the self-hosted admin JWT) lists its own tenant.
    return c.json(await listWorkspaces(ctx, c.get("auth").account, paging, body?.filters));
  });

  // Recall extension: a read with no side effects (POST /v3/workspaces creates on a typo).
  app.get("/v3/workspaces/:workspace_id", guard(ctx), async (c) => {
    return c.json(await getWorkspace(ctx, wsOf(c)));
  });

  app.put("/v3/workspaces/:workspace_id", guard(ctx), async (c) => {
    const body = await parseBody(c, WorkspaceUpdate);
    return c.json(await updateWorkspace(ctx, wsOf(c), body));
  });

  app.delete("/v3/workspaces/:workspace_id", guard(ctx), async (c) => {
    await deleteWorkspace(ctx, wsOf(c));
    return c.json({ message: "Workspace deletion accepted" }, 202);
  });
}
