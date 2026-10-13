// Guide: https://recallmem.dev/guides/workplace
// A team assistant: meetings, threads and DMs as sessions, a scope per project, past material
// imported, and what happens when someone leaves.
// Run by packages/sdk/test/guides.test.ts against a real server.
import { Recall } from "@recall-memory/sdk";

export async function main(recall = new Recall({ workspaceId: "acme-corp" })) {
  // #region setup
  // People are peers keyed by their directory id, which outlives name and email changes.
  const lead = recall.peer("emp-1042");
  const designer = recall.peer("emp-2210");
  // The assistant's own replies teach Recall nothing about the team.
  const assistant = recall.peer("team-assistant");
  await assistant.setConfiguration({ observeMe: false });

  // One session per meeting, thread or DM. Work on a project joins the project's scope.
  const kickoff = recall.session("meet-20261006-checkout", {
    peers: [lead, designer, assistant],
    scopes: ["proj-checkout"],
  });
  // Your notetaker or chat integration records what each person said.
  await kickoff.addMessages([
    lead.message("I own the pricing page. Annual plans get two months free: decided."),
    designer.message("Then I'll have the new checkout mockups ready by 20 October."),
  ]);
  // #endregion

  // #region import
  // Past material: an exported thread, oldest first, with the time each message was written,
  // so Recall dates what it learns. Over 100 messages go in ordered batches of 100.
  const exported = [
    { user: "emp-1042", at: "2026-03-02T09:14:00Z", text: "We drop PayPal in Q4." },
    { user: "emp-2210", at: "2026-03-02T09:20:00Z", text: "Fine, it is 2% of orders." },
  ];
  const thread = recall.session("slack-c04p2qk-1709370840", { scopes: ["proj-checkout"] });
  await thread.addMessages(
    exported.map((m) => recall.peer(m.user).message(m.text, { createdAt: m.at })),
  );
  // Documents (PDF, JSON or any text format) become messages from the peer you name: here a
  // peer for the wiki, so they outlive the person who wrote them.
  const wiki = recall.session("doc-checkout-decisions", { scopes: ["proj-checkout"] });
  const doc = "# Checkout decisions\n\n- PayPal goes in Q4.\n- Annual plans: two months free.";
  await wiki.uploadFile(
    { filename: "checkout-decisions.md", content: new TextEncoder().encode(doc) },
    "wiki",
  );
  // #endregion

  // #region ask
  // A question about the project, answered only from the sessions in its scope.
  // (waitForIdle is for this demo; a real assistant does not block on learning.)
  await recall.waitForIdle();
  const answer = await recall.chat("Who owns the pricing page, and what is decided on PayPal?", {
    scope: "proj-checkout",
    reasoningLevel: "low",
  });
  // Only what one person could have seen: search through their perspective (no answer is
  // generated; your model answers from the messages).
  const seen = await recall.search("PayPal", {
    filters: { peer_perspective: designer.id },
    limit: 5,
  });
  // #endregion

  // #region dm
  // A direct message: one session per person, with what is known about them in the context.
  const dm = recall.session("dm-emp-2210", { peers: [designer, assistant] });
  const text = "What did I promise for the checkout project?";
  const { context } = await dm.turn([designer.message(text)], {
    peerTarget: designer,
    searchQuery: text,
    tokens: 2000,
  });
  const prompt = context.toOpenAI(assistant); // your model writes the reply from `prompt`
  // #endregion

  // #region leave
  // Someone leaves and is to be forgotten: their messages and every fact about them or from
  // their view go. Other people's messages, the wiki and facts that only mention them stay.
  const removed = await lead.delete();
  // #endregion
  return { answer, seen, prompt, removed };
}
