import { z } from "zod";
import type { AppContext } from "../../context.js";
import {
  createConclusions,
  deleteConclusion,
  getConclusion,
  listConclusions,
  queryConclusions,
} from "../../core/conclusions.js";
import { ensurePeers } from "../../core/peers.js";
import { ensureWorkspace } from "../../core/workspaces.js";
import { ApiError } from "../../lib/errors.js";
import {
  type AddTool,
  defineTool,
  existingId,
  fail,
  pageArgs,
  pagingOf,
  requirePeer,
  requireSession,
  requireWorkspace,
  workspaceArg,
  workspaceFor,
} from "../kit.js";
import { filtersArg, newPeerIdArg } from "./shared.js";

export function registerConclusionTools(add: AddTool, ctx: AppContext): void {
  add(
    defineTool({
      name: "list_conclusions",
      title: "List conclusions",
      action: "list conclusions",
      description:
        "List the facts (conclusions) one peer holds about another (or about themself), newest first. Each has an id usable with get_conclusions, get_derived_conclusions and delete_conclusion. Read-only.",
      readOnly: true,
      schema: z.object({
        peer_id: existingId.describe("The observer whose memory to read."),
        target_peer_id: existingId
          .optional()
          .describe("Facts peer_id holds about this other peer. Defaults to peer_id itself."),
        session_id: existingId.optional().describe("Only facts learned in this session."),
        filters: filtersArg('Extra filters, e.g. {"level": "explicit"}.').optional(),
        ...pageArgs,
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        const ws = await requireWorkspace(ctx, key);
        await requirePeer(ctx, ws, a.peer_id);
        if (a.target_peer_id) await requirePeer(ctx, ws, a.target_peer_id);
        if (a.session_id) await requireSession(ctx, ws, a.session_id);
        return listConclusions(ctx, key, pagingOf(a), {
          ...a.filters,
          observer_id: a.peer_id,
          observed_id: a.target_peer_id ?? a.peer_id,
          ...(a.session_id ? { session_id: a.session_id } : {}),
        });
      },
    }),
  );

  add(
    defineTool({
      name: "query_conclusions",
      title: "Search conclusions",
      action: "search conclusions",
      description:
        "Find the facts one peer holds about another (or about themself) that best match a query, by meaning. Read-only.",
      readOnly: true,
      schema: z.object({
        peer_id: existingId.describe("The observer whose memory to search."),
        query: z.string().min(1).max(10_000).describe("What to look for."),
        target_peer_id: existingId
          .optional()
          .describe("Facts peer_id holds about this other peer. Defaults to peer_id itself."),
        top_k: z.number().int().min(1).max(100).optional().describe("Max results (default 10)."),
        filters: filtersArg('Extra filters, e.g. {"level": "explicit"}.').optional(),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        const ws = await requireWorkspace(ctx, key);
        await requirePeer(ctx, ws, a.peer_id);
        if (a.target_peer_id) await requirePeer(ctx, ws, a.target_peer_id);
        const items = await queryConclusions(ctx, key, {
          query: a.query,
          top_k: a.top_k ?? 10,
          filters: {
            ...a.filters,
            observer_id: a.peer_id,
            observed_id: a.target_peer_id ?? a.peer_id,
          },
        });
        return { items };
      },
    }),
  );

  add(
    defineTool({
      name: "get_conclusions",
      title: "Get conclusions by id",
      action: "get the conclusions",
      description:
        "Fetch conclusions by id (up to 100). Ids that do not exist are listed in not_found. Read-only.",
      readOnly: true,
      schema: z.object({
        conclusion_ids: z.array(existingId).min(1).max(100).describe("Conclusion ids."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        await requireWorkspace(ctx, key);
        const found = [];
        const missing: string[] = [];
        for (const id of new Set(a.conclusion_ids)) {
          try {
            found.push(await getConclusion(ctx, key, id));
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) missing.push(id);
            else throw err;
          }
        }
        return { conclusions: found, not_found: missing };
      },
    }),
  );

  add(
    defineTool({
      name: "get_derived_conclusions",
      title: "Get derived conclusions",
      action: "get the derived conclusions",
      description:
        "List the conclusions that were derived from a given conclusion (its children in the reasoning tree), newest first. Read-only.",
      readOnly: true,
      schema: z.object({
        conclusion_id: existingId.describe("The parent conclusion."),
        page: pageArgs.page,
        size: pageArgs.size,
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        await requireWorkspace(ctx, key);
        await getConclusion(ctx, key, a.conclusion_id);
        return listConclusions(ctx, key, pagingOf(a), { source_ids: a.conclusion_id });
      },
    }),
  );

  add(
    defineTool({
      name: "create_conclusions",
      title: "Save facts",
      action: "create conclusions",
      description:
        'Save facts you were told outright so memory has them straight away, e.g. "Prefers vegetarian food". peer_id is who holds the belief and target_peer_id who it is about (the same peer for self-knowledge). Write each as a short, self-contained statement. Creates the peers on first use.',
      readOnly: false,
      schema: z.object({
        peer_id: newPeerIdArg.describe("Who holds the belief (the observer)."),
        target_peer_id: newPeerIdArg.describe("Who the facts are about."),
        conclusions: z
          .array(z.string().min(1).max(65_535))
          .min(1)
          .max(100)
          .describe("One fact per entry."),
        session_id: existingId.optional().describe("File the facts under this session."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        const { row } = await ensureWorkspace(ctx.db, key);
        await ensurePeers(ctx.db, row.internal_id, [a.peer_id, a.target_peer_id]);
        const created = await createConclusions(
          ctx,
          key,
          a.conclusions.map((content) => ({
            content,
            observer_id: a.peer_id,
            observed_id: a.target_peer_id,
            session_id: a.session_id ?? null,
          })),
        );
        return { created: created.length, conclusions: created };
      },
    }),
  );

  add(
    defineTool({
      name: "delete_conclusion",
      title: "Delete a fact",
      action: "delete the conclusion",
      description:
        "Permanently remove one conclusion that is wrong or that the user asked to forget. It must be held by peer_id about target_peer_id; get the id from list_conclusions.",
      readOnly: false,
      destructive: true,
      idempotent: true,
      schema: z.object({
        peer_id: existingId.describe("The observer who holds the conclusion."),
        target_peer_id: existingId.describe("Who the conclusion is about."),
        conclusion_id: existingId.describe("The conclusion to delete."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        await requireWorkspace(ctx, key);
        const c = await getConclusion(ctx, key, a.conclusion_id);
        if (c.observer_id !== a.peer_id || c.observed_id !== a.target_peer_id) {
          fail(
            `Conclusion ${a.conclusion_id} is not held by '${a.peer_id}' about '${a.target_peer_id}'.`,
          );
        }
        await deleteConclusion(ctx, key, a.conclusion_id);
        return { deleted: a.conclusion_id };
      },
    }),
  );
}
