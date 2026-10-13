// Guide: https://recallmem.dev/guides/switch-from-honcho
// Code written for the v3 memory API runs on Recall as it is. This file makes the usual calls with
// Recall's own SDK, then the calls Recall adds. Run by packages/sdk/test/guides.test.ts against a
// real server.
import { Recall } from "@recall-memory/sdk";

export async function main(recall = new Recall({ workspaceId: "my-app" })) {
  // #region same
  // The same objects and calls as before: peers, sessions, messages, context and chat.
  const alice = recall.peer("alice");
  const assistant = recall.peer("assistant");
  const session = recall.session("support-42");
  await session.addPeers([alice, assistant]);
  await session.addMessages([
    alice.message("We moved from Amsterdam to Utrecht last week."),
    assistant.message("Congratulations on the move!"),
  ]);
  const context = await session.context({ tokens: 2000, peerTarget: alice });
  const messages = context.toOpenAI(assistant);
  await recall.waitForIdle(); // for this demo only: real apps do not wait for learning
  const city = await alice.chat("Where does alice live now?", { reasoningLevel: "low" });
  const hits = await alice.search("Utrecht");
  // #endregion

  // #region extras
  // What Recall adds. An answer with its sources, a confidence and an honest "I don't know".
  const answer = await alice.chat("Where does alice live now?", { includeEvidence: true });
  const reply = answer.abstained ? "I'm not sure yet." : answer.content;
  const sources = answer.citations;
  // One request that stores a message and returns the context for the reply.
  const { context: next } = await session.turn([alice.message("Any good cafés near me?")], {
    peerTarget: alice,
    tokens: 2000,
  });
  // Forget a person: her messages, the facts about her and her peer cards.
  const erased = await alice.delete();
  // #endregion
  return { messages, city, hits, reply, sources, next: next.toOpenAI(assistant), erased };
}
