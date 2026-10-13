// Guide: https://recallmem.dev/guides/cost-and-speed
// The settings and calls that keep Recall cheap and fast: an assistant Recall does not learn
// about, chats it only stores, context on every turn, and one question at the cheapest level.
// Run by packages/sdk/test/guides.test.ts against a real server.
import { Recall } from "@recall-memory/sdk";

export async function main(recall = new Recall({ workspaceId: "assistant-prod" })) {
  // #region settings
  const user = recall.peer("user-8412");
  // Your prompt defines the assistant: Recall reads its replies but does not learn from them.
  const assistant = recall.peer("assistant", { configuration: { observeMe: false } });
  const chat = recall.session("chat-6120");

  // A visitor who is not signed in: keep the chat as context, learn nothing from it.
  const visitor = recall.peer("visitor-3b9e");
  const noLearning = { configuration: { reasoning: { enabled: false } } };
  const guest = recall.session("guest-3b9e", noLearning);
  await guest.addMessages([visitor.message("Do you ship to Belgium?")]);

  // The same setting on one message: stored for context, not learned from, like a pasted log.
  await chat.addMessages([user.message("Error log: payment timed out (504)", noLearning)]);
  // #endregion

  // #region calls
  // Every reply: one request stores the user's line and returns the prompt context.
  // It makes no model call and is included in the price.
  const { context } = await chat.turn(
    [user.message("Book the hotel by Ghent station again, like last time.")],
    { peerTarget: user, tokens: 3000 },
  );
  const prompt = context.toOpenAI(assistant);
  // Your model writes the reply from `prompt`; store it so the next context includes it.
  await chat.addMessages([assistant.message("Happy to. Which dates?")]);

  // Ask only when your code needs an answer, at the cheapest level that gives a good one, and
  // keep it for the conversation instead of asking again on every turn.
  await recall.waitForIdle(); // for this demo; real apps rarely wait for learning
  const hotel = await user.chat("Which hotel did I stay at last time?", {
    reasoningLevel: "minimal",
  });
  // #endregion
  return { prompt, hotel };
}
