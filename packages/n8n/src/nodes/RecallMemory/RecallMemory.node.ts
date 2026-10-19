import { supplyMemory } from "@n8n/ai-node-sdk";
import {
  type INodeType,
  type INodeTypeDescription,
  type ISupplyDataFunctions,
  NodeConnectionTypes,
  NodeOperationError,
  type SupplyData,
} from "n8n-workflow";
import { CREDENTIAL, recallClient, safeId } from "../../shared/api.js";
import { RecallAgentMemory } from "./memory.js";

const DEFAULT_TOKENS = 2_000;

export class RecallMemory implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Recall Memory",
    name: "recallMemory",
    icon: { light: "file:../Recall/recall.svg", dark: "file:../Recall/recall.svg" },
    group: ["transform"],
    version: 1,
    subtitle: "Long-term memory in Recall",
    description:
      "Long-term memory for the AI Agent: remembers each user across conversations, with the messages every fact came from",
    defaults: { name: "Recall Memory" },
    codex: {
      categories: ["AI"],
      subcategories: { AI: ["Memory"], Memory: ["Other memories"] },
      resources: { primaryDocumentation: [{ url: "https://recallmem.dev/guides/n8n" }] },
    },
    inputs: [],
    outputs: [NodeConnectionTypes.AiMemory],
    outputNames: ["Memory"],
    credentials: [{ name: CREDENTIAL, required: true }],
    properties: [
      {
        displayName: "Session ID",
        name: "sessionId",
        type: "string",
        default: "={{ $json.sessionId }}",
        required: true,
        description:
          "The conversation. The default reads the Chat Trigger's session; for Telegram, WhatsApp or email use the chat or thread ID.",
      },
      {
        displayName: "User ID",
        name: "userId",
        type: "string",
        default: "={{ $json.sessionId }}",
        required: true,
        placeholder: "e.g. an email address, or the Telegram sender's user ID",
        description:
          "Who the agent is talking to. Recall learns facts about this person and brings them into every conversation with them, new ones too. Use a stable ID such as an email address or a chat app's user ID. The default (the session) only remembers within one conversation.",
      },
      {
        displayName: "Options",
        name: "options",
        type: "collection",
        placeholder: "Add Option",
        default: {},
        options: [
          {
            displayName: "Agent ID",
            name: "assistantId",
            type: "string",
            default: "assistant",
            description:
              "The agent's ID in Recall. Its replies are kept as context, never as facts about anyone.",
          },
          {
            displayName: "Context Tokens",
            name: "tokens",
            type: "number",
            default: DEFAULT_TOKENS,
            typeOptions: { minValue: 200 },
            description:
              "Budget for this conversation's history: a summary of older turns plus the latest messages",
          },
          {
            displayName: "Include What Recall Knows",
            name: "knowledge",
            type: "boolean",
            default: true,
            description:
              "Whether to add what Recall knows about the user from every earlier conversation",
          },
          {
            displayName: "Memory Placement",
            name: "placement",
            type: "options",
            default: "system",
            options: [
              { name: "System Message", value: "system" },
              { name: "User Message", value: "user" },
            ],
            description:
              "Role of the message that carries what Recall knows. Choose User Message for Anthropic and Gemini chat models, which accept a system message only first.",
          },
          {
            displayName: "Relevant To",
            name: "query",
            type: "string",
            default: "={{ $json.chatInput }}",
            description:
              "Recall brings the facts most relevant to this text, usually the incoming message",
          },
        ],
      },
    ],
  };

  async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
    const sessionId = safeId(String(this.getNodeParameter("sessionId", itemIndex, "") ?? ""));
    const userId = safeId(String(this.getNodeParameter("userId", itemIndex, "") ?? ""));
    if (!sessionId) {
      throw new NodeOperationError(this.getNode(), "Session ID is empty", {
        itemIndex,
        description: "Connect a Chat Trigger, or set Session ID to the conversation's ID.",
      });
    }
    if (!userId) {
      throw new NodeOperationError(this.getNode(), "User ID is empty", {
        itemIndex,
        description: "Set User ID to who the agent is talking to, such as an email address.",
      });
    }
    const options = this.getNodeParameter("options", itemIndex, {}) as {
      assistantId?: string;
      tokens?: number;
      knowledge?: boolean;
      placement?: "system" | "user";
      query?: string;
    };
    const tokens = Number(options.tokens);
    const memory = new RecallAgentMemory({
      recall: await recallClient(this, itemIndex),
      sessionId,
      userId,
      assistantId: safeId(options.assistantId ?? "", "assistant"),
      tokens: Number.isFinite(tokens) && tokens >= 200 ? Math.floor(tokens) : DEFAULT_TOKENS,
      knowledge: options.knowledge !== false,
      query: String(options.query ?? ""),
      placement: options.placement === "user" ? "user" : "system",
    });
    return supplyMemory(this, memory);
  }
}
