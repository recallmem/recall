// Guide: https://recallmem.dev/guides/langchain-js
// Recall memory in LangChain.js: a chat message history stored in Recall sessions, a retriever over
// what Recall remembers about the user, and tools for agents. Run by
// packages/langchain/test/langchain.test.ts against a real server, with a scripted chat model.
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { RunnableWithMessageHistory } from "@langchain/core/runnables";
import type { FakeListChatModel } from "@langchain/core/utils/testing";
import { RecallChatMessageHistory, RecallRetriever, recallTools } from "@recall-memory/langchain";
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

  // #region history
  // `model` is any LangChain chat model. Each conversation's messages live in a Recall session,
  // and Recall learns about the user from them.
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "You are a helpful assistant.\n{memory}"],
    new MessagesPlaceholder("history"),
    ["human", "{input}"],
  ]);
  const chat = new RunnableWithMessageHistory({
    runnable: prompt.pipe(model),
    getMessageHistory: (id: string) =>
      new RecallChatMessageHistory({ recall, sessionId: id, userId }),
    inputMessagesKey: "input",
    historyMessagesKey: "history",
  });
  // #endregion

  // #region retriever
  // The retriever finds what Recall knows about the user that bears on the message: facts first,
  // then things they said. Put it in the prompt.
  const retriever = new RecallRetriever({ recall, userId, k: 4 });
  const input = "My parents visit on Saturday. Can you plan a dinner for four?";
  const memory = (await retriever.invoke(input)).map((d) => `- ${d.pageContent}`).join("\n");
  const reply = await chat.invoke({ input, memory }, { configurable: { sessionId } });
  // #endregion

  // #region tools
  // Tools let an agent search memory, ask it a question and save a fact on its own. Bind them to
  // a model that supports tool calling, or give them to createAgent from the langchain package.
  const tools = recallTools({ recall, userId });
  const withTools = model.bindTools(tools);
  // They are plain tools, so you can also call one yourself.
  const [searchMemory] = tools;
  const found = await searchMemory.invoke({ query: "diet" });
  // #endregion
  return { reply: reply.text, found, withTools };
}

/** A scripted stand-in for your chat model, so CI runs this guide without a provider key. */
async function scriptedModel(): Promise<FakeListChatModel> {
  const { FakeListChatModel: Fake } = await import("@langchain/core/utils/testing");
  return new Fake({ responses: ["How about a mushroom risotto for four?"] });
}
