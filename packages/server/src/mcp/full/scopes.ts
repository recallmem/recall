import { z } from "zod";
import type { AppContext } from "../../context.js";
import { metadata as metadataSchema } from "../../core/schemas.js";
import {
  addSessionsToScope,
  getOrCreateScope,
  getScopeStatus,
  listScopeSessions,
  listScopes,
  removeSessionFromScope,
} from "../../core/scopes.js";
import {
  type AddTool,
  defineTool,
  existingId,
  pageArgs,
  pagingOf,
  requireWorkspace,
  workspaceArg,
  workspaceFor,
} from "../kit.js";
import { newScopeIdArg } from "./shared.js";

const pageOnly = {
  page: pageArgs.page,
  size: pageArgs.size,
};

export function registerScopeTools(add: AddTool, ctx: AppContext): void {
  add(
    defineTool({
      name: "list_scopes",
      title: "List scopes",
      action: "list scopes",
      description:
        "List the scopes in a workspace. A scope groups sessions so questions can draw on all of them at once. Read-only.",
      readOnly: true,
      schema: z.object({ ...pageOnly, workspace_id: workspaceArg }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        await requireWorkspace(ctx, key);
        return listScopes(ctx, key, pagingOf(a));
      },
    }),
  );

  add(
    defineTool({
      name: "create_scope",
      title: "Create a scope",
      action: "create the scope",
      description:
        "Create a scope (a named group of sessions), or return it if it exists. Add sessions with add_sessions_to_scope, then pass the scope id to chat, search or get_representation to draw on all of them.",
      readOnly: false,
      idempotent: true,
      schema: z.object({
        scope_id: newScopeIdArg,
        metadata: metadataSchema.optional().describe("Free-form JSON stored on the scope."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        const { scope, created } = await getOrCreateScope(ctx, key, {
          id: a.scope_id,
          metadata: a.metadata ?? null,
        });
        return { ...scope, created };
      },
    }),
  );

  add(
    defineTool({
      name: "add_sessions_to_scope",
      title: "Add sessions to a scope",
      action: "add sessions to the scope",
      description:
        "Put existing sessions into a scope. Facts from those sessions become reachable through the scope; the existing messages are folded in in the background (see get_scope_status).",
      readOnly: false,
      idempotent: true,
      schema: z.object({
        scope_id: existingId.describe("The scope."),
        session_ids: z.array(existingId).min(1).max(100).describe("Sessions to add."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        await requireWorkspace(ctx, key);
        await addSessionsToScope(ctx, key, a.scope_id, a.session_ids);
        return { scope_id: a.scope_id, added: a.session_ids };
      },
    }),
  );

  add(
    defineTool({
      name: "remove_session_from_scope",
      title: "Remove a session from a scope",
      action: "remove the session from the scope",
      description:
        "Take a session out of a scope. The session and its messages stay; the scope stops drawing on them.",
      readOnly: false,
      destructive: true,
      idempotent: true,
      schema: z.object({
        scope_id: existingId.describe("The scope."),
        session_id: existingId.describe("The session to remove."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        await requireWorkspace(ctx, key);
        await removeSessionFromScope(ctx, key, a.scope_id, a.session_id);
        return { scope_id: a.scope_id, removed: a.session_id };
      },
    }),
  );

  add(
    defineTool({
      name: "get_scope_status",
      title: "Get scope status",
      action: "get the scope status",
      description:
        "Progress of folding sessions into a scope (backfill status per session). Read-only.",
      readOnly: true,
      schema: z.object({ scope_id: existingId.describe("The scope."), workspace_id: workspaceArg }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        await requireWorkspace(ctx, key);
        return getScopeStatus(ctx, key, a.scope_id);
      },
    }),
  );

  add(
    defineTool({
      name: "get_scope_sessions",
      title: "Get scope sessions",
      action: "get the scope sessions",
      description: "List the sessions that belong to a scope. Read-only.",
      readOnly: true,
      schema: z.object({
        scope_id: existingId.describe("The scope."),
        ...pageOnly,
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        await requireWorkspace(ctx, key);
        return listScopeSessions(ctx, key, a.scope_id, pagingOf(a));
      },
    }),
  );
}
