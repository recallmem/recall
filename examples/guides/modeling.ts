// Guide: https://recallmem.dev/guides/modeling
// One user, two agents, two conversations. Each agent's view of the user holds only what it
// witnessed; Recall's own view holds everything. Run by packages/sdk/test/guides.test.ts against a real server.
import { Recall } from "@recall-memory/sdk";

export async function main(recall = new Recall({ workspaceId: "trips-prod" })) {
  // #region setup
  // One peer per real person or agent, with the id your own database already uses.
  const user = recall.peer("user-8412", { metadata: { plan: "pro" } });
  // Your code defines the agents, so Recall need not learn about them from their own lines.
  const agent = { configuration: { observeMe: false } };
  const planner = recall.peer("agent-planner", agent);
  const billing = recall.peer("agent-billing", agent);
  // #endregion

  // #region sessions
  // One session per conversation. Each agent joins with observeOthers, so it builds its own
  // view of the people it talks to, from this conversation only.
  const trip = recall.session("chat-5531", {
    metadata: { channel: "web" },
    peers: { "user-8412": {}, "agent-planner": { observeOthers: true } },
  });
  await trip.addMessages([
    user.message("I live in Utrecht and I am vegetarian."),
    planner.message("Noted. I'll only suggest restaurants with good vegetarian menus."),
  ]);

  const invoice = recall.session("chat-5532", {
    metadata: { channel: "email" },
    peers: { "user-8412": {}, "agent-billing": { observeOthers: true } },
  });
  await invoice.addMessages([
    user.message("I moved to Amersfoort last week, please update my billing address."),
    billing.message("Done. Your next invoice goes to your new address in Amersfoort."),
  ]);
  // #endregion

  // #region views
  // (waitForIdle is for this demo; real apps rarely wait for learning to finish.)
  await recall.waitForIdle();
  // Recall's view of the user, built from everything they said in any session: Amersfoort.
  const recallView = await user.chat("Where do I live?", { reasoningLevel: "minimal" });
  // The planner's view holds only what it witnessed. It never heard about the move: Utrecht.
  const plannerView = await planner.chat("Where does the user live?", {
    target: user,
    reasoningLevel: "minimal",
  });
  // In a prompt, read the user through the eyes of the agent that is talking.
  const context = await trip.context({ peerTarget: user, peerPerspective: planner, tokens: 2000 });
  // #endregion

  // #region filters
  // Metadata is yours to filter on.
  const emailChats = await (
    await recall.sessions({ filters: { metadata: { channel: "email" } } })
  ).toArray();
  // Search only what the billing agent saw: the trip chat is not in the results.
  const billingSaw = await recall.search("restaurants", {
    filters: { peer_perspective: "agent-billing" },
  });
  // #endregion
  return { recallView, plannerView, context, emailChats, billingSaw };
}
