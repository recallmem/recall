// Guide: https://recallmem.dev/guides/levels-and-models
// The three ways to read memory, cheapest first: context, search, chat (at a level you choose).
// Run by packages/sdk/test/guides.test.ts against a real server.
import { Recall } from "@recall-memory/sdk";

export async function main(recall = new Recall({ workspaceId: "my-app" })) {
  // #region setup
  const user = recall.peer("user-8412");
  const assistant = recall.peer("assistant", { configuration: { observeMe: false } });
  const session = recall.session("chat-311", { peers: ["user-8412", "assistant"] });
  await session.addMessages([
    user.message("I moved from Seattle to Denver in March. I cycle to work most days."),
    assistant.message("Denver is a great city for cycling."),
    user.message("I'm allergic to peanuts, and I've started learning Dutch."),
  ]);
  await recall.waitForIdle(); // for this demo only: real apps do not wait for learning
  // #endregion

  // #region context
  // 1. Context: no model call, a few hundred milliseconds, included in the price.
  //    Use it to build every prompt.
  const context = await session.context({ peerTarget: user, tokens: 3000, searchQuery: "dinner" });
  const messages = context.toOpenAI(assistant);
  // #endregion

  // #region search
  // 2. Search: the stored messages that match, no model call. Use it to show sources or to
  //    let your own model read the raw text.
  const hits = await user.search("allergy", { limit: 5 });
  // #endregion

  // #region chat
  // 3. Chat: an answer written from memory, one model call. Pick the level per question.
  const city = await user.chat("Where do I live now?", { reasoningLevel: "minimal" });
  const plan = await user.chat("Suggest a weekend plan I'd enjoy, given what you know about me.", {
    reasoningLevel: "medium",
  });
  // #endregion

  // #region evidence
  // With evidence: the facts and messages behind the answer, a confidence, and whether it
  // declined to answer. Show sources, or fall back when it abstains.
  const answer = await user.chat("Which foods must I avoid?", {
    reasoningLevel: "low",
    includeEvidence: true,
  });
  const safe = answer.abstained ? "Not sure: please check with the user." : answer.content;
  // #endregion

  // #region structured
  // Structured: a JSON Schema in, matching JSON out, for code rather than people.
  const profile = await user.chat("Summarise this user's diet and languages.", {
    reasoningLevel: "low",
    responseFormat: {
      type: "object",
      properties: {
        allergies: { type: "array", items: { type: "string" } },
        languages: { type: "array", items: { type: "string" } },
      },
      required: ["allergies", "languages"],
      additionalProperties: false,
    },
  });
  // #endregion
  return { messages, hits, city, plan, safe, profile };
}
