import { z } from "zod";
import type { AppContext } from "../../context.js";
import { createMessages, getMessage, listMessages } from "../../core/messages.js";
import {
  MAX_MESSAGE_CHARS,
  metadata as metadataSchema,
  newName,
  scopeName,
} from "../../core/schemas.js";
import {
  addSessionPeers,
  cloneSession,
  deleteSession,
  findActiveSession,
  getOrCreateSession,
  listSessionPeers,
  listSessions,
  removeSessionPeers,
} from "../../core/sessions.js";
import { sessionContext, sessionSummaries } from "../../recall/session-context.js";
import {
  type AddTool,
  defineTool,
  existingId,
  fail,
  pageArgs,
  pagingOf,
  requireSession,
  requireWorkspace,
  totalOf,
  workspaceArg,
  workspaceFor,
} from "../kit.js";
import { filtersArg, sessionIdOf } from "./shared.js";

const sessionArg = (what: string) =>
  existingId.optional().describe(`${what} Defaults to this connection's session when it has one.`);

const peerEntry = z.union([
  newName,
  z.object({
    peer_id: newName,
    observe_me: z.boolean().nullish().describe("Learn from this peer's messages (default true)."),
    observe_others: z
      .boolean()
      .nullish()
      .describe("Build this peer's own view of the others in the session (default false)."),
  }),
]);

export function registerSessionTools(add: AddTool, ctx: AppContext): void {
  add(
    defineTool({
      name: "create_session",
      title: "Create a session",
      action: "create the session",
      description:
        "Create a session (one coherent conversation or context), or return it if it exists. Optionally join it to scopes, which group sessions for shared recall.",
      readOnly: false,
      idempotent: true,
      schema: z.object({
        session_id: newName.describe("Id for the session."),
        scopes: z.array(scopeName).min(1).max(100).optional().describe("Scopes to join."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        const { session, created } = await getOrCreateSession(ctx, key, {
          id: a.session_id,
          scopes: a.scopes ?? null,
        });
        return { ...session, created };
      },
    }),
  );

  add(
    defineTool({
      name: "list_sessions",
      title: "List sessions",
      action: "list sessions",
      description: "List the sessions in a workspace. Read-only.",
      readOnly: true,
      schema: z.object({ ...pageArgs, workspace_id: workspaceArg }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        await requireWorkspace(ctx, key);
        return listSessions(ctx, key, pagingOf(a), null);
      },
    }),
  );

  add(
    defineTool({
      name: "delete_session",
      title: "Delete a session",
      action: "delete the session",
      description:
        "Permanently delete a session with its messages and the summaries made from them. Facts already learned from it stay. Deletion finishes in the background.",
      readOnly: false,
      destructive: true,
      idempotent: true,
      schema: z.object({
        session_id: existingId.describe("The session to delete."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        await requireWorkspace(ctx, key);
        await deleteSession(ctx, key, a.session_id);
        return { deleted: a.session_id };
      },
    }),
  );

  add(
    defineTool({
      name: "clone_session",
      title: "Clone a session",
      action: "clone the session",
      description:
        "Copy a session, optionally only up to and including one message, into a new session with a generated id. Useful to branch a conversation. The copy is not re-analysed.",
      readOnly: false,
      schema: z.object({
        session_id: existingId.describe("The session to copy."),
        message_id: existingId.optional().describe("Copy only up to and including this message."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        const ws = await requireWorkspace(ctx, key);
        await requireSession(ctx, ws, a.session_id);
        return cloneSession(ctx, key, a.session_id, a.message_id);
      },
    }),
  );

  add(
    defineTool({
      name: "add_peers_to_session",
      title: "Add peers to a session",
      action: "add peers to the session",
      description:
        "Add peers to a session, creating the session and the peers when needed. Each entry is a peer id, or an object with observe_me / observe_others to override how memory treats that peer in this session.",
      readOnly: false,
      idempotent: true,
      schema: z.object({
        peers: z.array(peerEntry).min(1).max(100).describe("Peers to add."),
        session_id: sessionArg("The session."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        const sessionName = sessionIdOf(a.session_id, s);
        const members: Record<
          string,
          { observe_me?: boolean | null; observe_others?: boolean | null }
        > = {};
        for (const p of a.peers) {
          if (typeof p === "string") members[p] = {};
          else members[p.peer_id] = { observe_me: p.observe_me, observe_others: p.observe_others };
        }
        const session = await addSessionPeers(ctx, key, sessionName, members);
        return { session_id: session.id, added: Object.keys(members) };
      },
    }),
  );

  add(
    defineTool({
      name: "remove_peers_from_session",
      title: "Remove peers from a session",
      action: "remove peers from the session",
      description:
        "Remove peers from a session. Their past messages stay; they stop being members.",
      readOnly: false,
      destructive: true,
      idempotent: true,
      schema: z.object({
        peer_ids: z.array(existingId).min(1).max(100).describe("Peers to remove."),
        session_id: sessionArg("The session."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        const sessionName = sessionIdOf(a.session_id, s);
        await requireWorkspace(ctx, key);
        const session = await removeSessionPeers(ctx, key, sessionName, a.peer_ids);
        return { session_id: session.id, removed: a.peer_ids };
      },
    }),
  );

  add(
    defineTool({
      name: "get_session_peers",
      title: "Get session peers",
      action: "get the session peers",
      description: "List the peers that are currently members of a session. Read-only.",
      readOnly: true,
      schema: z.object({
        session_id: existingId.describe("The session."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        const ws = await requireWorkspace(ctx, key);
        await requireSession(ctx, ws, a.session_id);
        return listSessionPeers(ctx, key, a.session_id, pagingOf({ size: 100 }));
      },
    }),
  );

  add(
    defineTool({
      name: "inspect_session",
      title: "Inspect a session",
      action: "inspect the session",
      description:
        "Overview of a session: its metadata and configuration, the ids of its member peers, how many messages it holds and its summaries. Use get_session_messages to read the messages. Read-only.",
      readOnly: true,
      schema: z.object({
        session_id: existingId.describe("The session."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        await requireWorkspace(ctx, key);
        const row = await findActiveSession(ctx.db, key, a.session_id);
        if (!row) return fail(`Session '${a.session_id}' not found in workspace '${key.name}'.`);
        const [peers, messages, summaries] = await Promise.all([
          listSessionPeers(ctx, key, a.session_id, pagingOf({ size: 100 })),
          listMessages(ctx, key, a.session_id, pagingOf({ size: 1 }), null),
          sessionSummaries(ctx, key, a.session_id),
        ]);
        return {
          session_id: row.name,
          metadata: row.metadata ?? {},
          configuration: row.configuration ?? {},
          created_at: new Date(row.created_at as string | Date).toISOString(),
          peer_count: totalOf(peers),
          peers: peers.items.map((p) => ({ id: p.id })),
          message_count: totalOf(messages),
          summaries,
        };
      },
    }),
  );

  add(
    defineTool({
      name: "add_messages_to_session",
      title: "Record messages",
      action: "add messages",
      description:
        "Record what was said in a session so memory can learn from it. Creates the session and the speakers on first use. Learning runs in the background; do not wait for it. Pass idempotency_key when a retry is possible, so the same batch is never stored twice.",
      readOnly: false,
      schema: z.object({
        messages: z
          .array(
            z.object({
              peer_id: newName.describe("Who said it."),
              content: z.string().max(MAX_MESSAGE_CHARS).describe("The message text."),
              metadata: metadataSchema
                .optional()
                .describe("Free-form JSON stored with the message."),
            }),
          )
          .min(1)
          .max(100)
          .describe("Messages in the order they were said."),
        session_id: sessionArg("The session to record into."),
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
        const key = workspaceFor(s, a.workspace_id);
        const session = sessionIdOf(a.session_id, s);
        const { messages, replayed } = await createMessages(ctx, {
          workspace: key,
          session,
          messages: a.messages.map((m) => ({
            content: m.content,
            peer_id: m.peer_id,
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

  add(
    defineTool({
      name: "get_session_messages",
      title: "Get session messages",
      action: "get the session messages",
      description:
        "Read the messages of a session in order (oldest first; reverse flips it), a page at a time, optionally filtered. Read-only.",
      readOnly: true,
      schema: z.object({
        session_id: sessionArg("The session."),
        filters: filtersArg(
          'Filter, e.g. {"peer_id": "alice"} or {"created_at": {"gte": "2026-01-01"}}.',
        ).optional(),
        ...pageArgs,
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        const sessionName = sessionIdOf(a.session_id, s);
        await requireWorkspace(ctx, key);
        if (!(await findActiveSession(ctx.db, key, sessionName))) {
          fail(`Session '${sessionName}' not found in workspace '${key.name}'.`);
        }
        return listMessages(ctx, key, sessionName, pagingOf(a), a.filters ?? null);
      },
    }),
  );

  add(
    defineTool({
      name: "get_session_message",
      title: "Get one message",
      action: "get the message",
      description: "Read a single message of a session by id. Read-only.",
      readOnly: true,
      schema: z.object({
        session_id: existingId.describe("The session."),
        message_id: existingId.describe("The message id."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        await requireWorkspace(ctx, key);
        return getMessage(ctx, key, a.session_id, a.message_id);
      },
    }),
  );

  add(
    defineTool({
      name: "get_session_context",
      title: "Get session context",
      action: "get the session context",
      description:
        "Everything needed to continue a conversation, sized to a token budget: a summary of older turns, the most recent messages, and (with peer_target) what memory knows about that person plus their card. peer_perspective views the target through another peer's memory; scope and limit_to_session restrict which facts are used. Read-only.",
      readOnly: true,
      schema: z.object({
        session_id: sessionArg("The session."),
        summary: z
          .boolean()
          .optional()
          .describe("Include a summary of older turns (default true)."),
        tokens: z
          .number()
          .int()
          .min(0)
          .max(100_000)
          .optional()
          .describe("Token budget for the whole result (default: everything, up to 100000)."),
        peer_target: existingId
          .optional()
          .describe(
            "Include what memory knows about this peer. Defaults to this connection's user.",
          ),
        peer_perspective: existingId
          .optional()
          .describe("View the target through this other peer's memory."),
        scope: existingId
          .optional()
          .describe("Use facts from this scope's sessions (needs peer_target)."),
        limit_to_session: z
          .boolean()
          .optional()
          .describe("Only use facts learned in this session."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        const sessionName = sessionIdOf(a.session_id, s);
        const ws = await requireWorkspace(ctx, key);
        await requireSession(ctx, ws, sessionName);
        return sessionContext(ctx, {
          workspace: key,
          session: sessionName,
          tokens: a.tokens ?? null,
          summary: a.summary ?? true,
          peerTarget: a.peer_target ?? s.user,
          peerPerspective: a.peer_perspective ?? null,
          scope: a.scope ?? null,
          sessions: null,
          limitToSession: a.limit_to_session ?? false,
          searchQuery: null,
          searchTopK: null,
          searchMaxDistance: null,
          includeMostFrequent: false,
          maxConclusions: 100,
          auth: s.auth,
        });
      },
    }),
  );
}
