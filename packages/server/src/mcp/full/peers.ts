import { z } from "zod";
import type { AppContext } from "../../context.js";
import { getOrCreatePeer, getPeerCard, listPeers, setPeerCard } from "../../core/peers.js";
import { peerContext, representation } from "../../recall/api.js";
import {
  type AddTool,
  defineTool,
  existingId,
  pageArgs,
  pagingOf,
  reasoningLevel,
  requirePeer,
  requireWorkspace,
  workspaceArg,
  workspaceFor,
} from "../kit.js";
import {
  chatAnswer,
  exclusive,
  newPeerIdArg,
  scopeListArg,
  sessionsAllowlistArg,
} from "./shared.js";

const maxConclusions = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe("Max facts to include (default 25).");

export function registerPeerTools(add: AddTool, ctx: AppContext): void {
  add(
    defineTool({
      name: "create_peer",
      title: "Create a peer",
      action: "create the peer",
      description:
        "Create a peer (a person, agent or bot that takes part in conversations), or return it if it exists. Use one stable id per real person. Set observeMe to false for deterministic bots whose behaviour is not worth learning.",
      readOnly: false,
      idempotent: true,
      schema: z.object({
        peer_id: newPeerIdArg.describe("Id for the peer."),
        configuration: z
          .object({
            observeMe: z
              .boolean()
              .nullable()
              .optional()
              .describe("Whether memory should learn from this peer's messages (default true)."),
          })
          .optional()
          .describe("Peer settings."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        const observeMe = a.configuration?.observeMe;
        const { peer, created } = await getOrCreatePeer(ctx, key, {
          id: a.peer_id,
          configuration: typeof observeMe === "boolean" ? { observe_me: observeMe } : null,
        });
        return { ...peer, created };
      },
    }),
  );

  add(
    defineTool({
      name: "list_peers",
      title: "List peers",
      action: "list peers",
      description: "List the peers in a workspace. Read-only.",
      readOnly: true,
      schema: z.object({ ...pageArgs, workspace_id: workspaceArg }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        await requireWorkspace(ctx, key);
        return listPeers(ctx, key, pagingOf(a), {});
      },
    }),
  );

  add(
    defineTool({
      name: "chat",
      title: "Ask a peer's memory",
      action: "ask memory",
      description:
        'Ask a natural-language question about what a peer knows, e.g. "Where does the user live?". With target_peer_id, ask what peer_id knows about that other peer. Returns the answer text ("None" when memory has nothing), or JSON with the evidence when include_evidence is true. session_id, scope and sessions narrow what memory draws on and are mutually exclusive. Read-only.',
      readOnly: true,
      schema: z.object({
        peer_id: existingId.describe("Whose memory to consult (the observer)."),
        query: z.string().min(1).max(10_000).describe("The question."),
        target_peer_id: existingId
          .optional()
          .describe("Ask what peer_id knows about this other peer."),
        session_id: existingId.optional().describe("Prefer this session's messages."),
        scope: scopeListArg.optional(),
        sessions: sessionsAllowlistArg.optional(),
        reasoning_level: reasoningLevel,
        include_evidence: z
          .boolean()
          .optional()
          .describe("Return the facts and messages the answer rests on, as JSON."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        exclusive({ session_id: a.session_id, scope: a.scope, sessions: a.sessions });
        const key = workspaceFor(s, a.workspace_id);
        const ws = await requireWorkspace(ctx, key);
        await requirePeer(ctx, ws, a.peer_id);
        if (a.target_peer_id) await requirePeer(ctx, ws, a.target_peer_id);
        return chatAnswer(
          ctx,
          {
            workspace: key,
            peer: a.peer_id,
            query: a.query,
            target: a.target_peer_id ?? null,
            sessionId: a.session_id ?? null,
            filters: a.sessions ? { session_id: a.sessions } : null,
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
      name: "get_peer_card",
      title: "Get peer card",
      action: "get the peer card",
      description:
        "Get the peer card: a short list of the most stable facts about a person (name, location, role, preferences). Cheap; a good first call. peer_card is null when there is none yet. Read-only.",
      readOnly: true,
      schema: z.object({
        peer_id: existingId.describe("The peer whose memory holds the card."),
        target_peer_id: existingId
          .optional()
          .describe("Get peer_id's card about this other peer instead of about themself."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        const ws = await requireWorkspace(ctx, key);
        await requirePeer(ctx, ws, a.peer_id);
        const card = await getPeerCard(ctx, key, a.peer_id, a.target_peer_id);
        return {
          peer_id: a.peer_id,
          target_peer_id: a.target_peer_id ?? a.peer_id,
          peer_card: card,
        };
      },
    }),
  );

  add(
    defineTool({
      name: "set_peer_card",
      title: "Replace peer card",
      action: "set the peer card",
      description:
        "Replace a peer's card with the given list of short facts. The whole card is overwritten, not merged: read it first with get_peer_card to keep existing lines. Creates the peers on first use.",
      readOnly: false,
      destructive: true,
      idempotent: true,
      schema: z.object({
        peer_id: existingId.describe("The peer whose memory holds the card."),
        peer_card: z
          .array(z.string().max(4000))
          .max(500)
          .describe("The new card, one fact per entry."),
        target_peer_id: existingId
          .optional()
          .describe("Set peer_id's card about this other peer instead of about themself."),
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        const card = await setPeerCard(ctx, key, a.peer_id, a.target_peer_id, a.peer_card);
        return {
          peer_id: a.peer_id,
          target_peer_id: a.target_peer_id ?? a.peer_id,
          peer_card: card,
        };
      },
    }),
  );

  add(
    defineTool({
      name: "get_peer_context",
      title: "Get peer context",
      action: "get the peer context",
      description:
        "What memory knows about a peer in one call: a written representation of the facts it holds, plus the peer card. search_query biases the representation toward facts relevant to that text. Cheap (no language model). Read-only.",
      readOnly: true,
      schema: z.object({
        peer_id: existingId.describe("The peer whose memory to read (the observer)."),
        target_peer_id: existingId
          .optional()
          .describe("What peer_id knows about this other peer. Defaults to peer_id itself."),
        search_query: z
          .string()
          .min(1)
          .max(10_000)
          .optional()
          .describe("Bias the representation toward facts relevant to this text."),
        max_conclusions: maxConclusions,
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        const key = workspaceFor(s, a.workspace_id);
        const ws = await requireWorkspace(ctx, key);
        await requirePeer(ctx, ws, a.peer_id);
        return peerContext(ctx, {
          workspace: key,
          peer: a.peer_id,
          target: a.target_peer_id ?? null,
          searchQuery: a.search_query ?? null,
          searchTopK: null,
          searchMaxDistance: null,
          includeMostFrequent: true,
          maxConclusions: a.max_conclusions ?? 100,
        });
      },
    }),
  );

  add(
    defineTool({
      name: "get_representation",
      title: "Get representation",
      action: "get the representation",
      description:
        "A written summary of the facts memory holds about a peer, optionally limited to one session, a scope or a list of sessions (mutually exclusive) and biased toward a search query. Cheap (no language model). Read-only.",
      readOnly: true,
      schema: z.object({
        peer_id: existingId.describe("The peer whose memory to read (the observer)."),
        target_peer_id: existingId
          .optional()
          .describe("What peer_id knows about this other peer. Defaults to peer_id itself."),
        session_id: existingId.optional().describe("Only facts learned in this session."),
        scope: scopeListArg.optional(),
        sessions: sessionsAllowlistArg.optional(),
        search_query: z
          .string()
          .min(1)
          .max(10_000)
          .optional()
          .describe("Bias the representation toward facts relevant to this text."),
        max_conclusions: maxConclusions,
        workspace_id: workspaceArg,
      }),
      async run(a, s) {
        exclusive({ session_id: a.session_id, scope: a.scope, sessions: a.sessions });
        const key = workspaceFor(s, a.workspace_id);
        const ws = await requireWorkspace(ctx, key);
        await requirePeer(ctx, ws, a.peer_id);
        if (a.target_peer_id) await requirePeer(ctx, ws, a.target_peer_id);
        const text = await representation(ctx, {
          workspace: key,
          peer: a.peer_id,
          auth: s.auth,
          sessionId: a.session_id ?? null,
          filters: a.sessions ? { session_id: a.sessions } : null,
          scope: a.scope ?? null,
          target: a.target_peer_id ?? null,
          searchQuery: a.search_query ?? null,
          searchTopK: null,
          searchMaxDistance: null,
          includeMostFrequent: false,
          maxConclusions: a.max_conclusions ?? 25,
        });
        return text || "Memory holds no facts for this selection yet.";
      },
    }),
  );
}
