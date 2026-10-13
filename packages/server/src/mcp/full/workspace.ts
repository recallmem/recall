import { z } from "zod";
import { scheduleManualDream } from "../../consolidate/index.js";
import type { AppContext } from "../../context.js";
import { listPeers, selectPeerRow, updatePeer } from "../../core/peers.js";
import { metadata as metadataSchema, newName } from "../../core/schemas.js";
import { findActiveSession, listSessions, updateSession } from "../../core/sessions.js";
import {
  findWorkspace,
  getOrCreateWorkspace,
  listWorkspaces,
  updateWorkspace,
} from "../../core/workspaces.js";
import { compileFilters } from "../../http/filters.js";
import { queueStatus } from "../../http/routes/queue.js";
import { workspaceOut } from "../../http/serialize.js";
import { searchMessagesApi } from "../../recall/api.js";
import { getPeer } from "../../recall/lookup.js";
import { queryVectors } from "../../recall/pack.js";
import { pairCond, searchConclusions } from "../../recall/search.js";
import { and } from "../../recall/util.js";
import {
  type AddTool,
  conclusionBrief,
  defineTool,
  existingId,
  fail,
  pagingOf,
  reasoningLevel,
  requirePeer,
  requireSession,
  requireWorkspace,
  totalOf,
  workspaceArg,
  workspaceFor,
} from "../kit.js";
import { chatAnswer, exclusive, filtersArg } from "./shared.js";

const pageOnly = {
  page: z.number().int().min(1).optional().describe("Page number, from 1."),
  size: z.number().int().min(1).max(100).optional().describe("Items per page (default 20)."),
};

export function registerWorkspaceTools(add: AddTool, ctx: AppContext): void {
  add(
    defineTool({
      name: "list_workspaces",
      title: "List workspaces",
      action: "list workspaces",
      description:
        "List the workspaces this connection can use, with their ids, metadata and creation time. A token limited to one workspace sees only that one. Read-only.",
      readOnly: true,
      schema: z.object(pageOnly),
      async run(a, s) {
        const paging = pagingOf(a);
        if (s.auth.admin) return listWorkspaces(ctx, s.auth.account, paging, null);
        // A scoped token sees its workspace (an OAuth grant: each of its workspaces) that exists.
        const names = s.auth.workspaces ?? (s.auth.claims.w ? [s.auth.claims.w] : []);
        const items = [];
        for (const name of names) {
          const row = await findWorkspace(ctx.db, { account: s.auth.account, name });
          if (row) items.push(workspaceOut(row));
        }
        return {
          items,
          total: items.length,
          page: 1,
          size: paging.size,
          pages: items.length ? 1 : 0,
        };
      },
    }),
  );

  add(
    defineTool({
      name: "create_workspace",
      title: "Create a workspace",
      action: "create the workspace",
      description:
        "Create a workspace, or return it if it already exists (an existing workspace keeps its metadata). A workspace is the top-level container for peers, sessions and memory.",
      readOnly: false,
      idempotent: true,
      schema: z.object({
        workspace_id: newName.describe("Id for the workspace."),
        metadata: metadataSchema.optional().describe("Free-form JSON stored on a new workspace."),
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        const { workspace, created } = await getOrCreateWorkspace(ctx, key.account, {
          id: a.workspace_id,
          metadata: a.metadata ?? null,
        });
        return { ...workspace, created };
      },
    }),
  );

  add(
    defineTool({
      name: "inspect_workspace",
      title: "Inspect a workspace",
      action: "inspect the workspace",
      description:
        "Overview of a workspace: its metadata and configuration, how many peers and sessions it holds, and the ids of the first ones. Read-only.",
      readOnly: true,
      schema: z.object({ workspace_id: workspaceArg }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        await requireWorkspace(ctx, key);
        const row = (await findWorkspace(ctx.db, key))!;
        const [peers, sessions] = await Promise.all([
          listPeers(ctx, key, pagingOf({ size: 100 }), {}),
          listSessions(ctx, key, pagingOf({ size: 100 }), null),
        ]);
        return {
          workspace_id: row.name,
          metadata: row.metadata ?? {},
          configuration: row.configuration ?? {},
          peer_count: totalOf(peers),
          peers: peers.items.map((p) => ({ id: p.id })),
          session_count: totalOf(sessions),
          sessions: sessions.items.map((x) => ({ id: x.id })),
        };
      },
    }),
  );

  add(
    defineTool({
      name: "search",
      title: "Search memory",
      action: "search",
      description:
        "Find raw evidence: messages matching the query (hybrid keyword and semantic search) plus, when peer_id is given, the facts memory holds about that peer. Messages are searched within scope, else session_id, else peer_id, else the whole workspace; with scope and peer_id together, the peer narrows the scope's messages. Use chat for a written answer instead. Read-only.",
      readOnly: true,
      schema: z.object({
        query: z.string().min(1).max(10_000).describe("What to look for."),
        peer_id: existingId
          .optional()
          .describe("Search this peer's messages, and return the facts memory holds about them."),
        session_id: existingId
          .optional()
          .describe("Only search messages of this session. Exclusive with scope."),
        scope: z
          .string()
          .min(1)
          .optional()
          .describe("Only search messages of this scope's sessions. Exclusive with session_id."),
        message_limit: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Max messages (default 10; 0 skips message search)."),
        message_filters: filtersArg("Extra filters for the message search.").optional(),
        conclusion_top_k: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Max facts about peer_id (default 10; 0 skips them)."),
        conclusion_filters: filtersArg("Extra filters for the fact search.").optional(),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        exclusive({ scope: a.scope, session_id: a.session_id });
        const key = workspaceFor(s, a.workspace_id);
        const ws = await requireWorkspace(ctx, key);
        if (a.session_id) await requireSession(ctx, ws, a.session_id);
        const limit = a.message_limit ?? 10;
        const topK = a.conclusion_top_k ?? 10;

        let found: Awaited<ReturnType<typeof searchMessagesApi>> = [];
        if (limit > 0) {
          const base = { workspace: key, query: a.query, limit };
          if (a.scope) {
            const filters = a.peer_id
              ? { ...a.message_filters, peer_id: a.peer_id }
              : a.message_filters;
            found = await searchMessagesApi(ctx, { ...base, scope: a.scope, filters });
          } else if (a.session_id) {
            found = await searchMessagesApi(ctx, {
              ...base,
              session: a.session_id,
              filters: a.message_filters,
            });
          } else if (a.peer_id) {
            found = await searchMessagesApi(ctx, {
              ...base,
              peer: a.peer_id,
              filters: a.message_filters,
            });
          } else {
            found = await searchMessagesApi(ctx, { ...base, filters: a.message_filters });
          }
        }
        const messages = found.map((m) => ({
          id: m.id,
          peer_id: m.peer_id,
          session_id: m.session_id,
          content: m.content,
          created_at: m.created_at,
        }));

        // Bad filters are the caller's mistake and are reported even when the peer is unknown.
        const { workspace_id: _ignored, ...factFilters } = a.conclusion_filters ?? {};
        const filterCond = compileFilters("conclusions", factFilters);
        let conclusions: ReturnType<typeof conclusionBrief>[] = [];
        const peer = a.peer_id && topK > 0 ? await getPeer(ctx, ws.id, a.peer_id) : null;
        if (peer && !peer.isScope) {
          const hits = await searchConclusions(ctx, {
            workspaceId: ws.id,
            query: a.query,
            vectors: await queryVectors(ctx, ws.id, a.query, false),
            pool: topK,
            cond: and(pairCond(ws.id, peer.id, peer.id), filterCond),
            state: "current",
          });
          conclusions = hits.map((h) => conclusionBrief(h.row));
        }
        return { messages, conclusions };
      },
    }),
  );

  add(
    defineTool({
      name: "workspace_chat",
      title: "Ask the whole workspace",
      action: "ask the workspace",
      description:
        'Ask a natural-language question across everything recorded in the workspace, optionally limited to one session or to scopes, e.g. "What did the team decide about pricing?". Returns the answer text ("None" when memory has nothing), or JSON with the evidence when include_evidence is true. Read-only.',
      readOnly: true,
      schema: z.object({
        query: z.string().min(1).max(10_000).describe("The question."),
        session_id: existingId
          .optional()
          .describe("Prefer this session's messages. Exclusive with scope."),
        scope: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(100)])
          .optional()
          .describe("Limit to the sessions of one scope, or of up to 100 scopes."),
        reasoning_level: reasoningLevel,
        include_evidence: z
          .boolean()
          .optional()
          .describe("Return the facts and messages the answer rests on, as JSON."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        exclusive({ scope: a.scope, session_id: a.session_id });
        const key = workspaceFor(s, a.workspace_id);
        await requireWorkspace(ctx, key);
        return chatAnswer(
          ctx,
          {
            workspace: key,
            peer: null,
            query: a.query,
            target: null,
            sessionId: a.session_id ?? null,
            filters: null,
            scope: a.scope ?? null,
            level: a.reasoning_level ?? "low",
            responseFormat: null,
            includeEvidence: a.include_evidence ?? false,
            auth: s.auth,
          },
          a.include_evidence ?? false,
        );
      },
    }),
  );

  add(
    defineTool({
      name: "get_metadata",
      title: "Get metadata",
      action: "get metadata",
      description:
        "Read the free-form metadata of a session (when session_id is given), else a peer (peer_id), else the workspace. Read-only.",
      readOnly: true,
      schema: z.object({
        peer_id: existingId.optional().describe("Read this peer's metadata."),
        session_id: existingId
          .optional()
          .describe("Read this session's metadata (wins over peer_id)."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        const ws = await requireWorkspace(ctx, key);
        if (a.session_id) {
          const row = await findActiveSession(ctx.db, key, a.session_id);
          if (!row) return fail(`Session '${a.session_id}' not found in workspace '${ws.name}'.`);
          return row.metadata ?? {};
        }
        if (a.peer_id) {
          const row = await selectPeerRow(ctx.db, ws.id, a.peer_id);
          if (!row) return fail(`Peer '${a.peer_id}' not found in workspace '${ws.name}'.`);
          return row.metadata ?? {};
        }
        return (await findWorkspace(ctx.db, key))?.metadata ?? {};
      },
    }),
  );

  add(
    defineTool({
      name: "set_metadata",
      title: "Replace metadata",
      action: "set metadata",
      description:
        "Replace the metadata of a session (when session_id is given), else a peer (peer_id), else the workspace. The whole object is replaced, not merged: read it first with get_metadata to keep existing keys. The target must already exist.",
      readOnly: false,
      destructive: true,
      idempotent: true,
      schema: z.object({
        metadata: metadataSchema.describe("The new metadata object."),
        peer_id: existingId.optional().describe("Replace this peer's metadata."),
        session_id: existingId
          .optional()
          .describe("Replace this session's metadata (wins over peer_id)."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        const ws = await requireWorkspace(ctx, key);
        if (a.session_id) {
          await requireSession(ctx, ws, a.session_id);
          const updated = await updateSession(ctx, key, a.session_id, { metadata: a.metadata });
          return { session_id: updated.id, metadata: updated.metadata };
        }
        if (a.peer_id) {
          await requirePeer(ctx, ws, a.peer_id);
          const updated = await updatePeer(ctx, key, a.peer_id, { metadata: a.metadata });
          return { peer_id: updated.id, metadata: updated.metadata };
        }
        const updated = await updateWorkspace(ctx, key, { metadata: a.metadata });
        return { workspace_id: updated.id, metadata: updated.metadata };
      },
    }),
  );

  // ---- system -----------------------------------------------------------------
  add(
    defineTool({
      name: "schedule_dream",
      title: "Schedule a dream",
      action: "schedule a dream",
      description:
        "Ask memory to consolidate what it knows about a peer now (merge duplicates, draw conclusions, refresh the card) instead of waiting for it to happen on its own. Runs in the background and may rewrite existing conclusions.",
      readOnly: false,
      destructive: true,
      schema: z.object({
        peer_id: existingId.describe("The observer whose memory should be consolidated."),
        target_peer_id: existingId
          .optional()
          .describe("Consolidate what peer_id knows about this peer. Defaults to peer_id itself."),
        session_id: existingId.optional().describe("Focus the dream on this session."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        if (!ctx.config.features.dreams) fail("Dreams are not enabled on this server.");
        const key = workspaceFor(s, a.workspace_id);
        const ws = await requireWorkspace(ctx, key);
        const observer = await requirePeer(ctx, ws, a.peer_id);
        const observed = a.target_peer_id ? await requirePeer(ctx, ws, a.target_peer_id) : observer;
        if (observer.isScope || observed.isScope) fail("A scope cannot take part in a dream.");
        if (a.session_id) await requireSession(ctx, ws, a.session_id);
        await scheduleManualDream(ctx, {
          workspaceId: ws.id,
          observer: observer.name,
          observed: observed.name,
          type: "omni",
          sessionName: a.session_id ?? null,
          rebuild: false,
        });
        return {
          scheduled: true,
          observer_id: observer.name,
          observed_id: observed.name,
          session_id: a.session_id ?? null,
        };
      },
    }),
  );

  add(
    defineTool({
      name: "get_queue_status",
      title: "Get processing status",
      action: "get the queue status",
      description:
        "How much background work (learning from new messages, summaries, dreams) is pending, running or done in the workspace. Use it to tell whether recent messages have been absorbed yet. Read-only.",
      readOnly: true,
      schema: z.object({ workspace_id: workspaceArg }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        const ws = await requireWorkspace(ctx, key);
        return queueStatus(ctx, ws.id, { sessionId: null, observerId: null, senderId: null });
      },
    }),
  );
}
