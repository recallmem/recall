import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { createConclusions, deleteConclusion, listConclusions } from "../core/conclusions.js";
import { createMessages } from "../core/messages.js";
import { ensurePeers, getPeerCard } from "../core/peers.js";
import { MAX_MESSAGE_CHARS, metadata, newName } from "../core/schemas.js";
import { ensureWorkspace } from "../core/workspaces.js";
import { limitChat } from "../http/auth.js";
import type { Paging } from "../http/pagination.js";
import { searchMessagesApi } from "../recall/api.js";
import { prepareChat, runChat } from "../recall/chat.js";
import { getPeer, getSession, getWorkspace } from "../recall/lookup.js";
import { queryVectors } from "../recall/pack.js";
import { pairCond, searchConclusions } from "../recall/search.js";
import { sessionContext } from "../recall/session-context.js";
import { and } from "../recall/util.js";
import {
  conclusionBrief,
  defineTool,
  existingId,
  fail,
  type McpSession,
  pageArgs,
  peerArg,
  personFor,
  reasoningLevel,
  requireSession,
  sessionArg,
  toolAdder,
  workspaceArg,
  workspaceFor,
} from "./kit.js";

/**
 * The default ("memory") MCP toolset: eight tools covering the record/recall
 * loop. Names and argument names follow the reference's catalogue so a client
 * written against it keeps working, but every id argument is optional and
 * falls back to the connection's defaults (workspace, user, session headers).
 *
 * Read-only tools are read-only for real: they look resources up and report a
 * missing workspace, peer or session as an error instead of creating it.
 */

/**
 * What the read tools say before anything was recorded (a new account, workspace, peer or
 * session): an empty result and this note, not an error, so a fresh connector starts cleanly.
 */
const NOTHING_YET =
  "Nothing is remembered here yet. When the user asks you to remember something, save it with create_conclusions.";

// Output schemas: what each tool returns, as structured content next to the JSON text. Loose
// objects, so a field added later never fails a call.
const item = z.looseObject({});
const note = z.string().optional().describe("Set when memory has nothing to go on yet.");
const OUTPUT = {
  add_messages_to_session: z.looseObject({
    session_id: z.string(),
    stored: z.number().describe("Messages stored by this call."),
    replayed: z.boolean().describe("True when an idempotent retry returned the first result."),
    messages: z.array(
      z.looseObject({ id: z.string(), peer_id: z.string(), created_at: z.string() }),
    ),
  }),
  chat: z.looseObject({
    content: z.string().describe("The answer."),
    confidence: z.unknown().optional(),
    abstained: z.boolean().optional().describe("True when memory did not know."),
    citations: z.array(z.unknown()).optional(),
    evidence: z.unknown().optional(),
  }),
  search: z.looseObject({ messages: z.array(item), conclusions: z.array(item), note }),
  get_session_context: z.looseObject({
    session_id: z.string(),
    summary: z.string().nullable(),
    peer_representation: z.string().nullable(),
    peer_card: z.array(z.string()).nullable(),
    messages: z.array(item),
    note,
  }),
  get_peer_card: z.looseObject({
    peer_id: z.string(),
    target_peer_id: z.string(),
    peer_card: z.array(z.string()).nullable(),
    note,
  }),
  list_conclusions: z.looseObject({ items: z.array(item), note }),
  create_conclusions: z.looseObject({
    created: z.number(),
    conclusions: z.array(z.looseObject({ id: z.string(), content: z.string() })),
  }),
  delete_conclusion: z.looseObject({
    deleted: z.string().describe("The deleted conclusion's id."),
  }),
};

export function registerTools(server: McpServer, ctx: AppContext, s: McpSession): void {
  const add = toolAdder(server, ctx, s);

  // ---- record ---------------------------------------------------------------
  add(
    defineTool({
      name: "add_messages_to_session",
      output: OUTPUT.add_messages_to_session,
      title: "Record messages",
      action: "add messages",
      description:
        "Store specific messages the user wants kept, as they were said, so memory can learn from them. Send only those messages, never the conversation history. Creates the session and the speakers on first use; learning runs in the background, so do not wait for it. Pass idempotency_key when a retry is possible, so the same batch is never stored twice.",
      readOnly: false,
      schema: z.object({
        session_id: newName
          .optional()
          .describe(
            "Conversation to record into. Reuse one id per conversation. Defaults to this connection's session when it has one.",
          ),
        messages: z
          .array(
            z.object({
              peer_id: newName
                .optional()
                .describe("Who said it. Defaults to this connection's user."),
              content: z.string().max(MAX_MESSAGE_CHARS).describe("The message text."),
              metadata: metadata.optional().describe("Free-form JSON stored with the message."),
            }),
          )
          .min(1)
          .max(100)
          .describe("Messages in the order they were said."),
        idempotency_key: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe(
            "Any unique string; a repeated call with the same key returns the first result.",
          ),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const workspace = workspaceFor(s, a.workspace_id);
        // Only looked up when some message names no speaker; "" is then never used.
        const speaker = a.messages.some((m) => !m.peer_id)
          ? await personFor(ctx, s, workspace, null)
          : "";
        const session =
          a.session_id ??
          s.session ??
          fail("session_id is required: pass it, or connect with the X-Recall-Session-ID header.");
        const { messages, replayed } = await createMessages(ctx, {
          workspace,
          session,
          messages: a.messages.map((m) => ({
            content: m.content,
            peer_id: m.peer_id ?? speaker,
            metadata: m.metadata ?? null,
          })),
          idempotencyKey: a.idempotency_key,
        });
        return {
          session_id: session,
          stored: messages.length,
          replayed,
          messages: messages.map((m) => ({
            id: m.id,
            peer_id: m.peer_id,
            created_at: m.created_at,
          })),
        };
      },
    }),
  );

  // ---- recall ---------------------------------------------------------------
  add(
    defineTool({
      name: "chat",
      output: OUTPUT.chat,
      // Without include_evidence the answer is plain text; as structured content it is { content }.
      structured: (v) => (typeof v === "string" ? { content: v } : v),
      title: "Ask memory",
      action: "ask memory",
      description:
        'Ask memory a natural-language question and get a written answer grounded in what was recorded, e.g. "Where does the user live?" or "What did we decide about the launch date?". Says so when memory does not know. Read-only.',
      readOnly: true,
      schema: z.object({
        query: z.string().min(1).max(10_000).describe("The question."),
        peer_id: peerArg("Whose memory to consult (the observer)."),
        target_peer_id: existingId
          .optional()
          .describe("Ask what peer_id knows about this other peer. Defaults to peer_id itself."),
        session_id: sessionArg("Prefer this conversation's messages."),
        reasoning_level: reasoningLevel,
        include_evidence: z
          .boolean()
          .optional()
          .describe("Return the facts and messages the answer rests on, as JSON."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const workspace = workspaceFor(s, a.workspace_id);
        const ws = await getWorkspace(ctx, workspace);
        const peerName = await personFor(ctx, s, workspace, a.peer_id, { several: "none" });
        // Nothing to reason over yet: say so, without a model call or a charge.
        if (!ws || (peerName && !(await getPeer(ctx, ws.id, peerName)))) return NOTHING_YET;
        const sessionName = a.session_id ?? s.session;
        limitChat(ctx, s.auth);
        const prepared = await prepareChat(ctx, {
          workspace,
          peer: peerName,
          query: a.query,
          target: a.target_peer_id ?? null,
          sessionId: sessionName,
          filters: null,
          scope: null,
          level: a.reasoning_level ?? "low",
          responseFormat: null,
          includeEvidence: a.include_evidence ?? false,
          auth: s.auth,
        });
        for await (const ev of runChat(ctx, prepared, false)) {
          if (ev.type !== "done") continue;
          const r = ev.result;
          if (!a.include_evidence) return r.content ?? "";
          return {
            content: r.content ?? "",
            confidence: r.confidence,
            abstained: r.abstained,
            citations: r.citations,
            evidence: r.evidence,
          };
        }
        return fail("memory produced no answer");
      },
    }),
  );

  add(
    defineTool({
      name: "search",
      output: OUTPUT.search,
      title: "Search memory",
      action: "search",
      description:
        "Find raw evidence: messages that match the query, plus (for a peer) the facts memory holds about them. Hybrid keyword and semantic search. Use chat when you want an answer instead of evidence. Read-only.",
      readOnly: true,
      schema: z.object({
        query: z.string().min(1).max(10_000).describe("What to look for."),
        peer_id: peerArg("Also return the facts memory holds about this peer."),
        session_id: existingId
          .optional()
          .describe("Only search messages of this conversation. Default: the whole workspace."),
        message_limit: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Max messages (default 8)."),
        conclusion_top_k: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Max facts (default 8)."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const workspace = workspaceFor(s, a.workspace_id);
        const ws = await getWorkspace(ctx, workspace);
        if (!ws || (a.session_id && !(await getSession(ctx, ws.id, a.session_id))))
          return { messages: [], conclusions: [], note: NOTHING_YET };
        const messageLimit = a.message_limit ?? 8;
        const topK = a.conclusion_top_k ?? 8;

        const found =
          messageLimit > 0
            ? await searchMessagesApi(ctx, {
                workspace,
                query: a.query,
                limit: messageLimit,
                ...(a.session_id ? { session: a.session_id } : {}),
              })
            : [];
        const messages = found.map((m) => ({
          id: m.id,
          peer_id: m.peer_id,
          session_id: m.session_id,
          content: m.content,
          created_at: m.created_at,
        }));

        let conclusions: ReturnType<typeof conclusionBrief>[] = [];
        const peerName = await personFor(ctx, s, workspace, a.peer_id, { several: "none" });
        const peer = peerName && topK > 0 ? await getPeer(ctx, ws.id, peerName) : null;
        if (peer && !peer.isScope) {
          const hits = await searchConclusions(ctx, {
            workspaceId: ws.id,
            query: a.query,
            vectors: await queryVectors(ctx, ws.id, a.query, false),
            pool: topK,
            cond: pairCond(ws.id, peer.id, peer.id),
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
      name: "get_session_context",
      output: OUTPUT.get_session_context,
      title: "Get session context",
      action: "get session context",
      description:
        "Get what you need to continue a conversation in one call, sized to a token budget: a summary of older turns, the most recent messages, and (with a peer) what memory knows about that person plus their peer card. Drop the result into your prompt. Read-only.",
      readOnly: true,
      schema: z.object({
        session_id: sessionArg("The conversation."),
        tokens: z
          .number()
          .int()
          .min(0)
          .max(100_000)
          .optional()
          .describe("Token budget for the whole result (default: everything, up to 100000)."),
        summary: z
          .boolean()
          .optional()
          .describe("Include a summary of older turns (default true)."),
        peer_target: peerArg("The person to include the representation and card of."),
        peer_perspective: existingId
          .optional()
          .describe("View the target through this other peer's memory instead of its own."),
        limit_to_session: z
          .boolean()
          .optional()
          .describe("Only use facts learned in this conversation."),
        search_query: z
          .string()
          .min(1)
          .max(10_000)
          .optional()
          .describe("Bias the representation towards facts relevant to this text."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const workspace = workspaceFor(s, a.workspace_id);
        const sessionName =
          a.session_id ??
          s.session ??
          fail("session_id is required: pass it, or connect with the X-Recall-Session-ID header.");
        const ws = await getWorkspace(ctx, workspace);
        if (!ws || !(await getSession(ctx, ws.id, sessionName)))
          return {
            session_id: sessionName,
            summary: null,
            peer_representation: null,
            peer_card: null,
            messages: [],
            note: NOTHING_YET,
          };
        const out = await sessionContext(ctx, {
          workspace,
          session: sessionName,
          tokens: a.tokens ?? null,
          summary: a.summary ?? true,
          peerTarget: a.peer_target ?? s.user,
          peerPerspective: a.peer_perspective ?? null,
          scope: null,
          sessions: null,
          limitToSession: a.limit_to_session ?? false,
          searchQuery: a.search_query ?? null,
          searchTopK: null,
          searchMaxDistance: null,
          includeMostFrequent: false,
          maxConclusions: 100,
          auth: s.auth,
        });
        return {
          session_id: out.id,
          summary: out.summary?.content ?? null,
          peer_representation: out.peer_representation || null,
          peer_card: out.peer_card,
          messages: out.messages.map((m) => ({
            id: m.id,
            peer_id: m.peer_id,
            content: m.content,
            created_at: m.created_at,
          })),
        };
      },
    }),
  );

  add(
    defineTool({
      name: "get_peer_card",
      output: OUTPUT.get_peer_card,
      title: "Get peer card",
      action: "get the peer card",
      description:
        "Get the peer card: a short list of the most stable facts about a person (name, location, role, preferences). Cheap; a good first call. Returns null when there is no card yet. Read-only.",
      readOnly: true,
      schema: z.object({
        peer_id: peerArg("The person whose memory holds the card."),
        target_peer_id: existingId
          .optional()
          .describe("Get peer_id's card about this other peer instead of about themself."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const workspace = workspaceFor(s, a.workspace_id);
        const peerName = await personFor(ctx, s, workspace, a.peer_id);
        const ws = await getWorkspace(ctx, workspace);
        if (!ws || !(await getPeer(ctx, ws.id, peerName)))
          return {
            peer_id: peerName,
            target_peer_id: a.target_peer_id ?? peerName,
            peer_card: null,
            note: NOTHING_YET,
          };
        const card = await getPeerCard(ctx, workspace, peerName, a.target_peer_id);
        return { peer_id: peerName, target_peer_id: a.target_peer_id ?? peerName, peer_card: card };
      },
    }),
  );

  // ---- maintain -------------------------------------------------------------
  add(
    defineTool({
      name: "list_conclusions",
      output: OUTPUT.list_conclusions,
      title: "List conclusions",
      action: "list conclusions",
      description:
        "List the facts (conclusions) memory holds about a person, newest first, or the best matches for a query. Each has an id you can pass to delete_conclusion. Read-only.",
      readOnly: true,
      schema: z.object({
        peer_id: peerArg("The observer whose memory to read."),
        target_peer_id: existingId
          .optional()
          .describe("Facts peer_id holds about this other peer. Defaults to peer_id itself."),
        session_id: existingId.optional().describe("Only facts learned in this conversation."),
        query: z
          .string()
          .min(1)
          .optional()
          .describe("Return the best matches for this text instead of a plain listing."),
        filters: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Extra filters, e.g. {"level": "explicit"}.'),
        ...pageArgs,
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const workspace = workspaceFor(s, a.workspace_id);
        const observer = await personFor(ctx, s, workspace, a.peer_id);
        const observed = a.target_peer_id ?? observer;
        const ws = await getWorkspace(ctx, workspace);
        if (!ws || !(await getPeer(ctx, ws.id, observer))) return { items: [], note: NOTHING_YET };

        if (a.query) {
          const [obs, obd] = await Promise.all([
            getPeer(ctx, ws.id, observer),
            getPeer(ctx, ws.id, observed),
          ]);
          if (!obs || !obd || obs.isScope || obd.isScope) return { items: [] };
          const session = a.session_id ? await requireSession(ctx, ws, a.session_id) : null;
          const size = a.size ?? 20;
          const hits = await searchConclusions(ctx, {
            workspaceId: ws.id,
            query: a.query,
            vectors: await queryVectors(ctx, ws.id, a.query, false),
            pool: size,
            cond: and(
              pairCond(ws.id, obs.id, obd.id),
              session ? sql`c.session_id = ${session.id}` : undefined,
            ),
            state: "current",
          });
          return { items: hits.map((h) => conclusionBrief(h.row)) };
        }

        const paging: Paging = {
          page: a.page ?? 1,
          size: a.size ?? 20,
          reverse: a.reverse ?? false,
          cursorMode: false,
          cursorRaw: null,
          cursor: null,
          fingerprint: "mcp",
        };
        return listConclusions(ctx, workspace, paging, {
          ...a.filters,
          observer_id: observer,
          observed_id: observed,
          ...(a.session_id ? { session_id: a.session_id } : {}),
        });
      },
    }),
  );

  add(
    defineTool({
      name: "create_conclusions",
      output: OUTPUT.create_conclusions,
      title: "Save facts",
      action: "create conclusions",
      description:
        'Save facts you were told outright, so memory has them straight away (for example "Prefers vegetarian food" or "Is moving to Berlin in March"). Write each as a short, self-contained statement. Creates the peers on first use.',
      readOnly: false,
      schema: z.object({
        conclusions: z
          .array(z.string().min(1).max(65_535))
          .min(1)
          .max(100)
          .describe("One fact per entry."),
        peer_id: newName
          .optional()
          .describe("Who holds the belief (the observer). Defaults to this connection's user."),
        target_peer_id: newName
          .optional()
          .describe("Who the facts are about. Defaults to peer_id itself."),
        session_id: existingId.optional().describe("File the facts under this conversation."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const workspace = workspaceFor(s, a.workspace_id);
        const observer = await personFor(ctx, s, workspace, a.peer_id);
        const observed = a.target_peer_id ?? observer;
        const { row } = await ensureWorkspace(ctx.db, workspace);
        await ensurePeers(ctx.db, row.internal_id, [observer, observed]);
        const created = await createConclusions(
          ctx,
          workspace,
          a.conclusions.map((content) => ({
            content,
            observer_id: observer,
            observed_id: observed,
            session_id: a.session_id ?? null,
          })),
        );
        return {
          created: created.length,
          conclusions: created.map((c) => ({ id: c.id, content: c.content })),
        };
      },
    }),
  );

  add(
    defineTool({
      name: "delete_conclusion",
      output: OUTPUT.delete_conclusion,
      title: "Delete a fact",
      action: "delete the conclusion",
      description:
        "Permanently remove one conclusion that is wrong or that the user asked to forget. This cannot be undone, so confirm with the user first. Get the id from list_conclusions or search.",
      readOnly: false,
      destructive: true,
      idempotent: true,
      schema: z.object({
        conclusion_id: existingId.describe("The id of the conclusion to delete."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const workspace = workspaceFor(s, a.workspace_id);
        await deleteConclusion(ctx, workspace, a.conclusion_id);
        return { deleted: a.conclusion_id };
      },
    }),
  );
}
