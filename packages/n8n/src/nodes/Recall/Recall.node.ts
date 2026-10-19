import {
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
  NodeConnectionTypes,
  NodeOperationError,
} from "n8n-workflow";
import {
  CREDENTIAL,
  newKey,
  type Recall as RecallApi,
  recallClient,
  safeId,
  split,
} from "../../shared/api.js";

type Operation = "ask" | "remember" | "search" | "profile" | "addMessage";

interface Fact {
  id?: string;
  content?: string;
  created_at?: string;
  valid_from?: string | null;
  source_ids?: string[];
}

interface WireMessage {
  id?: string;
  peer_id?: string;
  session_id?: string;
  content?: string;
  created_at?: string;
}

const userIdField = (operations: Operation[]) => ({
  displayName: "User ID",
  name: "userId",
  type: "string" as const,
  default: "",
  required: true,
  placeholder: "jane@example.com",
  description: "Who the memory is about: the same ID the Recall Memory node uses for this person",
  displayOptions: { show: { operation: operations } },
});

export class Recall implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Recall",
    name: "recall",
    icon: { light: "file:recall.svg", dark: "file:recall.svg" },
    group: ["transform"],
    version: 1,
    subtitle: '={{ $parameter["operation"] }}',
    description: "Ask, search and update what Recall remembers about a person",
    defaults: { name: "Recall" },
    usableAsTool: true,
    codex: {
      categories: ["AI"],
      subcategories: { AI: ["Tools"] },
      resources: { primaryDocumentation: [{ url: "https://recallmem.dev/guides/n8n" }] },
    },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: CREDENTIAL, required: true }],
    properties: [
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        default: "ask",
        options: [
          {
            name: "Add Message",
            value: "addMessage",
            action: "Add a message to a conversation",
            description:
              "Store a message (a support ticket, an email) so Recall learns from it, outside an AI Agent",
          },
          {
            name: "Ask Memory",
            value: "ask",
            action: "Ask memory a question about a person",
            description:
              "Answer a question in plain language from everything Recall remembers about the person",
          },
          {
            name: "Get Profile",
            value: "profile",
            action: "Get the profile of a person",
            description: "The short list of stable facts Recall keeps about the person",
          },
          {
            name: "Remember a Fact",
            value: "remember",
            action: "Remember a fact about a person",
            description: "Save a fact about the person, for example one they asked you to remember",
          },
          {
            name: "Search Memory",
            value: "search",
            action: "Search memory about a person",
            description: "Find the facts and messages about the person that match a query",
          },
        ],
      },
      userIdField(["ask", "remember", "search", "profile", "addMessage"]),
      {
        displayName: "Question",
        name: "question",
        type: "string",
        default: "",
        required: true,
        placeholder: "What diet does this person follow?",
        displayOptions: { show: { operation: ["ask"] } },
      },
      {
        displayName: "Reasoning Level",
        name: "reasoningLevel",
        type: "options",
        default: "low",
        options: [
          { name: "High", value: "high" },
          { name: "Low", value: "low" },
          { name: "Max", value: "max" },
          { name: "Medium", value: "medium" },
          { name: "Minimal", value: "minimal" },
        ],
        description:
          "How hard Recall thinks before answering. Higher levels combine more facts and cost more per question.",
        displayOptions: { show: { operation: ["ask"] } },
      },
      {
        displayName: "Fact",
        name: "fact",
        type: "string",
        default: "",
        required: true,
        placeholder: "Is allergic to peanuts",
        description: "One fact, in a short sentence",
        displayOptions: { show: { operation: ["remember"] } },
      },
      {
        displayName: "Query",
        name: "query",
        type: "string",
        default: "",
        required: true,
        placeholder: "allergies",
        displayOptions: { show: { operation: ["search"] } },
      },
      {
        displayName: "Limit",
        name: "limit",
        type: "number",
        default: 50,
        typeOptions: { minValue: 1 },
        description: "Max number of results to return",
        displayOptions: { show: { operation: ["search"] } },
      },
      {
        displayName: "Session ID",
        name: "sessionId",
        type: "string",
        default: "",
        required: true,
        placeholder: "ticket-4821",
        description: "The conversation the message belongs to",
        displayOptions: { show: { operation: ["addMessage"] } },
      },
      {
        displayName: "From",
        name: "role",
        type: "options",
        default: "user",
        options: [
          { name: "The Person", value: "user", description: "Recall learns facts from it" },
          {
            name: "The Agent or Staff",
            value: "assistant",
            description: "Kept as context, never as facts about anyone",
          },
        ],
        displayOptions: { show: { operation: ["addMessage"] } },
      },
      {
        displayName: "Message",
        name: "message",
        type: "string",
        typeOptions: { rows: 4 },
        default: "",
        required: true,
        displayOptions: { show: { operation: ["addMessage"] } },
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];
    let recall: RecallApi | undefined;
    for (let i = 0; i < items.length; i++) {
      try {
        recall ??= await recallClient(this, i);
        const operation = this.getNodeParameter("operation", i) as Operation;
        const userId = safeId(String(this.getNodeParameter("userId", i, "")));
        if (!userId)
          throw new NodeOperationError(this.getNode(), "User ID is empty", { itemIndex: i });
        const json = await run.call(this, recall, operation, userId, i);
        out.push({ json, pairedItem: { item: i } });
      } catch (error) {
        if (this.continueOnFail()) {
          out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
          continue;
        }
        throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
      }
    }
    return [out];
  }
}

async function run(
  this: IExecuteFunctions,
  recall: RecallApi,
  operation: Operation,
  userId: string,
  i: number,
): Promise<IDataObject> {
  const user = `/peers/${encodeURIComponent(userId)}`;
  switch (operation) {
    case "ask": {
      const question = String(this.getNodeParameter("question", i)).trim();
      if (!question)
        throw new NodeOperationError(this.getNode(), "Question is empty", { itemIndex: i });
      const answer = await recall<{ content?: string | null }>("POST", `${user}/chat`, {
        body: {
          query: question,
          stream: false,
          reasoning_level: String(this.getNodeParameter("reasoningLevel", i, "low")),
        },
        allowNotFound: true,
        // A retried question is answered, and charged, once.
        idempotencyKey: newKey("chat"),
      });
      // A person Recall has never seen has no memory yet: that is an empty answer, not an error.
      return { userId, question, answer: answer?.content ?? null };
    }
    case "remember": {
      const fact = String(this.getNodeParameter("fact", i)).trim();
      if (!fact) throw new NodeOperationError(this.getNode(), "Fact is empty", { itemIndex: i });
      const body = { conclusions: [{ content: fact, observer_id: userId, observed_id: userId }] };
      // Saving a fact has no idempotency key: a retry after a server error could save it twice.
      let created = await recall<Fact[]>("POST", "/conclusions", {
        body,
        allowNotFound: true,
        once: true,
      });
      if (!created) {
        // The person is new to Recall: create them, then save the fact.
        await recall("POST", "/peers", { body: { id: userId } });
        created = await recall<Fact[]>("POST", "/conclusions", { body, once: true });
      }
      const saved = created?.[0];
      return { userId, saved: Boolean(saved), id: saved?.id ?? null, fact };
    }
    case "search": {
      const query = String(this.getNodeParameter("query", i)).trim();
      if (!query) throw new NodeOperationError(this.getNode(), "Query is empty", { itemIndex: i });
      const limit = Math.min(
        50,
        Math.max(1, Math.floor(Number(this.getNodeParameter("limit", i, 8)) || 8)),
      );
      const [facts, messages] = await Promise.all([
        recall<Fact[]>("POST", "/conclusions/query", {
          body: { query, top_k: limit, filters: { observer_id: userId, observed_id: userId } },
          allowNotFound: true,
        }),
        recall<WireMessage[]>("POST", `${user}/search`, {
          body: { query, limit },
          allowNotFound: true,
        }),
      ]);
      return {
        userId,
        query,
        facts: (facts ?? []).map((f) => ({
          id: f.id ?? null,
          content: f.content ?? "",
          since: f.valid_from ?? f.created_at ?? null,
          sources: f.source_ids ?? [],
        })),
        messages: (messages ?? []).map((m) => ({
          id: m.id ?? null,
          sessionId: m.session_id ?? null,
          content: m.content ?? "",
          at: m.created_at ?? null,
        })),
      };
    }
    case "profile": {
      const card = await recall<{ peer_card?: string[] | null }>("GET", `${user}/card`, {
        allowNotFound: true,
      });
      return { userId, profile: card?.peer_card ?? [] };
    }
    case "addMessage": {
      const sessionId = safeId(String(this.getNodeParameter("sessionId", i, "")));
      if (!sessionId)
        throw new NodeOperationError(this.getNode(), "Session ID is empty", { itemIndex: i });
      const role = String(this.getNodeParameter("role", i, "user"));
      const text = String(this.getNodeParameter("message", i, ""));
      if (!text.trim())
        throw new NodeOperationError(this.getNode(), "Message is empty", { itemIndex: i });
      const author = role === "assistant" ? "assistant" : userId;
      await recall("PUT", "/peers/assistant", { body: { configuration: { observe_me: false } } });
      await recall("POST", "/sessions", {
        body: {
          id: sessionId,
          peers: { [userId]: { observe_me: true }, assistant: { observe_me: false } },
        },
      });
      const stored = await recall<WireMessage[]>(
        "POST",
        `/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          body: {
            messages: split(text).map((content) => ({
              peer_id: author,
              content,
              metadata: { source: "n8n" },
            })),
          },
          idempotencyKey: newKey("message"),
        },
      );
      return {
        userId,
        sessionId,
        stored: stored?.length ?? 0,
        ids: (stored ?? []).map((m) => m.id ?? ""),
      };
    }
  }
}
