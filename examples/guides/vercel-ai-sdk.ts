// Guide: https://recallmem.dev/guides/vercel-ai-sdk
// Recall memory in the Vercel AI SDK: middleware that adds what Recall knows about the user to each
// request and stores every turn, tools the model can call, and both in a ToolLoopAgent. Run by
// packages/ai-sdk/test/ai-sdk.test.ts against a real server, with a scripted model.
import { recallMiddleware, recallTools } from "@recall-memory/ai-sdk";
import { Recall } from "@recall-memory/sdk";
import { generateText, isStepCount, ToolLoopAgent, wrapLanguageModel } from "ai";
import type { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

export async function main(recall = new Recall({ workspaceId: "my-app" })) {
  const model = await scriptedModel();

  // #region setup
  // Who the memory is about (your own stable user id) and the conversation it belongs to.
  const userId = "user-8412";
  const sessionId = "chat-20261013-a91f";
  // A fact from your app's settings, stored as given and searchable at once.
  await recall.peer(userId).conclusions.create("Is vegetarian.");
  // #endregion

  // #region middleware
  // `model` is any AI SDK language model. The middleware adds what Recall knows about the user to
  // the request, then stores the user's message and the reply in the session.
  const { text: dinner } = await generateText({
    model: wrapLanguageModel({
      model,
      middleware: recallMiddleware({ recall, userId, sessionId }),
    }),
    system: "You are a helpful assistant.",
    prompt: "My parents visit on Saturday. Can you plan a dinner for four?",
  });
  // #endregion

  // #region tools
  // Tools let the model look things up (searchMemory, askMemory) and save what the user shares
  // (rememberFact) on its own.
  const { text: answer } = await generateText({
    model,
    tools: recallTools({ recall, userId }),
    stopWhen: isStepCount(5),
    prompt: "What do I eat, again?",
  });
  // #endregion

  // #region agent
  // An agent defined once, with memory per call: who and which conversation come in as call options.
  const agent = new ToolLoopAgent({
    model,
    instructions: "You are a helpful assistant.",
    callOptionsSchema: z.object({ userId: z.string(), sessionId: z.string() }),
    prepareCall: ({ options, ...settings }) => ({
      ...settings,
      model: wrapLanguageModel({ model, middleware: recallMiddleware({ recall, ...options }) }),
      tools: recallTools({ recall, userId: options.userId }),
    }),
  });
  const { text: reply } = await agent.generate({
    prompt: "Remember that my sister Ana is coming too.",
    options: { userId, sessionId },
  });
  // #endregion
  return { dinner, answer, reply };
}

/**
 * A scripted stand-in for your model, so CI runs this guide without a provider key. Offered tools,
 * it saves a fact when asked to remember one and searches memory otherwise, then answers.
 */
async function scriptedModel(): Promise<MockLanguageModelV4> {
  const { MockLanguageModelV4: Mock } = await import("ai/test");
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
  return new Mock({
    doGenerate: async ({ prompt, tools }) => {
      const last = prompt.at(-1);
      if (tools?.length && last?.role === "user") {
        const said = last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
        const [toolName, input] = said.startsWith("Remember")
          ? ["rememberFact", { fact: "Sister Ana joins the dinner on Saturday." }]
          : ["searchMemory", { query: said }];
        return {
          content: [
            { type: "tool-call", toolCallId: "call-1", toolName, input: JSON.stringify(input) },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text", text: "Here is a vegetarian menu for four." }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}
