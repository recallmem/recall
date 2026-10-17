// Guide: https://recallmem.dev/guides/assistants
// A personal assistant that remembers one user across conversations: settings as facts, the
// peer card, one call per message, questions, and fixing a wrong fact. Run by
// packages/sdk/test/guides.test.ts against a real server.
import { Recall } from "@recall-memory/sdk";

export async function main(recall = new Recall({ workspaceId: "assistant-prod" })) {
  // #region setup
  // The user is a peer, keyed by your own stable user id (not their email address).
  const user = recall.peer("user-8412", { metadata: { locale: "nl-NL" } });
  // You write the assistant's persona, so Recall should not learn from its replies.
  const assistant = recall.peer("assistant", { configuration: { observeMe: false } });
  // One session per conversation. Memory of the user is shared across all of them.
  const chat = recall.session("chat-20261010-a91f");
  // #endregion

  // #region settings
  // What the user entered in your app's settings is fact, not inference: store it as such.
  // It is searchable at once, without waiting for background learning.
  await user.conclusions.create(["Is vegetarian.", "Prefers short answers."]);
  // #endregion

  // #region card
  // The peer card: a short list of facts for every prompt. Recall writes and updates it as it
  // learns; you can add lines yourself, e.g. from onboarding. setCard replaces the whole card.
  const card = (await user.getCard()) ?? [];
  await user.setCard([
    ...card,
    "Prefers to be called Sam.",
    "Vegetarian.",
    "Timezone America/New_York.",
  ]);
  // #endregion

  // #region turn
  // Every user message: one request stores it and returns the context for the reply: this
  // conversation so far, a summary of older turns, the card and what Recall knows about Sam.
  const { context } = await chat.turn(
    [user.message("My parents visit on Saturday. Can you plan a dinner for four?")],
    { peerTarget: user, tokens: 3000 },
  );
  const messages = context.toOpenAI(assistant); // or context.toAnthropicParams(assistant)
  // Your model writes the reply from `messages`; store it so the conversation is complete.
  const reply = "How about a mushroom risotto with a big salad? Here is a shopping list.";
  await chat.addMessages([assistant.message(reply)]);
  // #endregion

  // #region ask
  // A question about the user, for a reminder or a suggestion outside the chat. One model call
  // of a few seconds. (waitForIdle is for this demo; real apps rarely block on learning.)
  await recall.waitForIdle();
  const answer = await user.chat("What should I keep in mind when suggesting a weekend plan?", {
    reasoningLevel: "low",
  });
  // #endregion

  // #region correct
  // A "What I remember" page: list the facts and let the user delete a wrong or outdated one.
  // Deleting a fact does not edit the card, so remove it there too, and store the new value.
  const { items: facts } = await user.conclusions.list({ size: 50 });
  const flagged = facts.find((f) => f.content.toLowerCase().includes("vegetarian")); // user's pick
  if (flagged) await user.conclusions.delete(flagged.id);
  const current = (await user.getCard()) ?? [];
  await user.setCard(current.filter((line) => !line.toLowerCase().includes("vegetarian")));
  await user.conclusions.create("Eats fish, but no meat.");
  // #endregion

  // #region forget
  // The user deletes their account: erase them (their messages, every fact and the card), then
  // their conversations, which still hold the assistant's replies to them.
  const chats = await (await user.sessions()).toArray();
  await user.delete();
  for (const c of chats) await c.delete();
  // #endregion
  return { messages, answer, facts };
}
