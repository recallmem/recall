// Guide: https://recallmem.dev/guides/mastra
// Recall memory for Mastra agents: one processor that adds what Recall knows about the user to each
// run and stores every turn, and tools the agent can call. Run by packages/mastra/test/mastra.test.ts
// against a real server, with a scripted model.
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";
import { RecallMemory, recallTools } from "@recall-memory/mastra";
import { Recall } from "@recall-memory/sdk";

export async function main(recall = new Recall({ workspaceId: "my-app" })) {
  const model = await scriptedModel();

  // #region setup
  // Who the memory is about (your own stable user id) and the conversation it belongs to.
  const userId = "user-8412";
  const sessionId = "chat-20261013-a91f";
  // A fact from your app's settings, stored as given and searchable at once.
  await recall.peer(userId).conclusions.create("Is vegetarian.");
  // #endregion

  // #region agent
  // `model` is any model Mastra accepts. One RecallMemory serves as input processor (it adds what
  // Recall knows about the user to the run) and as output processor (it stores the turn).
  const memory = new RecallMemory({ recall });
  const agent = new Agent({
    id: "assistant",
    name: "Assistant",
    instructions: "You are a helpful assistant.",
    model,
    tools: { ...recallTools({ recall }) },
    inputProcessors: [memory],
    outputProcessors: [memory],
  });
  // #endregion

  // #region run
  // The run's resource is the user and its thread the conversation. Your auth middleware usually
  // sets the resource, so one user can never read another's memory.
  const requestContext = new RequestContext();
  requestContext.set(MASTRA_RESOURCE_ID_KEY, userId);
  requestContext.set(MASTRA_THREAD_ID_KEY, sessionId);
  const result = await agent.generate("Can you plan a dinner for four on Saturday?", {
    requestContext,
  });
  // #endregion
  return { text: result.text };
}

/** A scripted stand-in for your model, so CI runs this guide without a provider key. */
async function scriptedModel(): Promise<MastraModelConfig> {
  const { createMockModel } = await import("@mastra/core/test-utils/llm-mock");
  return createMockModel({ mockText: "How about a mushroom risotto for four?", version: "v2" });
}
