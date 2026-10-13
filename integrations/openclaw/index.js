// OpenClaw plugin: long-term memory from Recall.
//
// - before_prompt_build adds what Recall knows about the user to the turn.
// - agent_end records the user's message and the agent's final reply.
// - recall_search / recall_ask / recall_remember / recall_forget let the agent
//   look things up and correct memory.
//
// It runs next to OpenClaw's own memory (it does not take the memory slot). Both
// hooks read conversation content, so OpenClaw only runs them after the operator
// sets plugins.entries.recall-memory.hooks.allowConversationAccess to true.

import { lastExchange, RecallClient, resolveSettings, safeId } from "./recall.js";

const PLUGIN_ID = "recall-memory";
const AUTOMATED_TRIGGERS = new Set(["heartbeat", "cron"]);
const MAX_PENDING = 500;

const text = (value) => ({ content: [{ type: "text", text: value }] });

/** The Recall session an OpenClaw conversation is recorded into. */
export const sessionIdFor = (ctx) =>
  `oc-${safeId(ctx?.sessionKey ?? ctx?.sessionId ?? "main", "main")}`.slice(0, 100);

function peerFor(settings, ctx) {
  if (settings.peerFromSender && ctx?.senderId) {
    return safeId(`${ctx.channel ?? ctx.messageProvider ?? "chat"}-${ctx.senderId}`, settings.peer);
  }
  return settings.peer;
}

const isAutomated = (ctx) => AUTOMATED_TRIGGERS.has(String(ctx?.trigger ?? "").toLowerCase());

function tools(client) {
  const peer = () => client.settings.peer;
  return [
    {
      name: "recall_search",
      label: "Search memory",
      description:
        "Search long-term memory (Recall) for facts about the user and past messages that match a query. Returns fact ids that recall_forget accepts. No model call; fast.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, description: "What to look for." },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Max results (default 8).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        const found = await client.search(peer(), params.query, params.limit ?? 8);
        const lines = [];
        lines.push(found.conclusions.length ? "Facts:" : "Facts: none found.");
        for (const c of found.conclusions) lines.push(`- [${c.id}] ${c.content}`);
        lines.push(found.messages.length ? "Messages:" : "Messages: none found.");
        for (const m of found.messages) {
          lines.push(
            `- ${String(m.created_at).slice(0, 10)} ${m.peer_id}: ${String(m.content).slice(0, 300)}`,
          );
        }
        return { ...text(lines.join("\n")), details: found };
      },
    },
    {
      name: "recall_ask",
      label: "Ask memory",
      description:
        "Ask long-term memory (Recall) a question about the user and get an answer grounded in earlier conversations, e.g. 'What did we decide about the trip?'. Costs one model call on the memory server; prefer recall_search for simple lookups.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", minLength: 1, description: "The question." },
          level: {
            type: "string",
            enum: ["minimal", "low", "medium", "high", "max"],
            description: "How hard to think (default low).",
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        const answer = await client.ask(peer(), params.question, params.level ?? "low");
        return { ...text(answer ?? "Memory has no answer to that."), details: { answer } };
      },
    },
    {
      name: "recall_remember",
      label: "Save to memory",
      description:
        "Save facts the user stated outright to long-term memory (Recall), each as a short self-contained statement, e.g. 'Prefers window seats'. Do not save secrets.",
      parameters: {
        type: "object",
        properties: {
          facts: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            maxItems: 20,
            description: "One fact per entry.",
          },
        },
        required: ["facts"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        const created = await client.remember(peer(), params.facts);
        return {
          ...text(created.map((c) => `Saved [${c.id}] ${c.content}`).join("\n")),
          details: { conclusions: created.map((c) => ({ id: c.id, content: c.content })) },
        };
      },
    },
    {
      name: "recall_forget",
      label: "Forget",
      description:
        "Delete one fact from long-term memory (Recall) by its id, when it is wrong or the user asks to forget it. Find ids with recall_search.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", minLength: 1, description: "The fact id." } },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        await client.forget(params.id);
        return { ...text(`Deleted ${params.id}.`), details: { deleted: params.id } };
      },
    },
  ];
}

export function register(api) {
  const mode = api.registrationMode ?? "full";
  if (mode === "cli-metadata" || mode === "setup-only") return;
  const logger = api.logger ?? console;
  // Settings are read on first use, never during registration (discovery loads stay inert).
  const client = new RecallClient(() => resolveSettings(api.pluginConfig ?? {}), logger);
  for (const tool of tools(client)) api.registerTool(tool);
  if (mode === "tool-discovery") return;

  /** The user's own words for a run, from before_prompt_build (keyed by run, else session). */
  const pending = new Map();
  const injected = new Set();
  const keyOf = (ctx) => ctx?.runId ?? ctx?.sessionKey ?? ctx?.sessionId ?? "main";

  api.on("before_prompt_build", async (event, ctx) => {
    try {
      const s = client.settings;
      if (isAutomated(ctx)) return;
      const ask =
        typeof event?.currentUserMessage === "string" ? event.currentUserMessage.trim() : "";
      if (ask) {
        pending.set(keyOf(ctx), ask);
        if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
      }
      if (s.lookup === "off") return;
      const session = sessionIdFor(ctx);
      if (s.lookup === "first-turn" && injected.has(session)) return;
      const query = ask || (typeof event?.prompt === "string" ? event.prompt : "");
      const memory = await client.memoryFor(peerFor(s, ctx), query.trim());
      if (!memory) return;
      injected.add(session);
      return { prependContext: memory };
    } catch (err) {
      logger.warn?.(`[recall] before_prompt_build failed: ${err?.message ?? err}`);
    }
  });

  api.on("agent_end", async (event, ctx) => {
    try {
      const s = client.settings;
      const key = keyOf(ctx);
      const ownWords = pending.get(key);
      pending.delete(key);
      if (!s.record || !event?.success) return;
      if (isAutomated(ctx) && !s.recordAutomated) return;
      const exchange = lastExchange(event.messages);
      const user = ownWords ?? exchange.user;
      await client.recordTurn({
        session: sessionIdFor(ctx),
        peer: peerFor(s, ctx),
        user,
        assistant: exchange.assistant,
        runId: event.runId ?? ctx?.runId,
        metadata: {
          session_key: ctx?.sessionKey ?? null,
          agent_id: ctx?.agentId ?? null,
          channel: ctx?.channel ?? ctx?.messageProvider ?? null,
        },
      });
    } catch (err) {
      logger.warn?.(`[recall] agent_end failed: ${err?.message ?? err}`);
    }
  });

  // Give turns that are still queued one more chance before the Gateway stops.
  api.on("gateway_stop", async () => {
    if (client.queue.length) await client.flush().catch(() => {});
  });
}

export default {
  id: PLUGIN_ID,
  name: "Recall Memory",
  description:
    "Long-term memory from Recall: adds what it knows about the user to each turn, records conversations, and adds memory tools.",
  register,
};
