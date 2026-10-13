// Guide: https://recallmem.dev/guides/privacy
// A team assistant for one business customer: opting a person out, giving them a copy of their
// data, forgetting one fact, forgetting the person, retention and closing the account.
// Run by packages/sdk/test/guides.test.ts against a real server.
import { Recall } from "@recall-memory/sdk";

export async function main(recall = new Recall({ workspaceId: "cust-1042" })) {
  // #region setup
  const sanne = recall.peer("user-8412");
  const colleague = recall.peer("user-5120");
  const assistant = recall.peer("assistant", { configuration: { observeMe: false } });
  const standup = recall.session("chat-7731");
  await standup.addMessages([
    sanne.message("I prefer short answers, and I work on the billing team."),
    colleague.message("I am covering the billing queue this week while Sanne is away."),
    assistant.message("Got it. Billing questions go to you this week."),
  ]);
  // #endregion

  // #region opt-out
  // Someone who does not want to be modelled: their messages are still stored and shown in
  // context, but nothing is learned from them, by Recall or by any other peer. It applies to
  // new messages; facts already learned stay until you delete them.
  await colleague.setConfiguration({ observeMe: false });
  // Or for one conversation only, such as a call they did not agree to have analysed.
  const call = recall.session("call-2291", {
    peers: { "user-8412": { observeMe: false }, assistant: {} },
  });
  await call.addMessages([sanne.message("Can you move my one-to-one to Friday?")]);
  // #endregion

  // #region access
  // A person asks for a copy of their data: what they said, and what Recall concluded.
  // (waitForIdle is for this demo; real apps rarely wait for learning to finish.)
  await recall.waitForIdle();
  const said = [];
  for (const session of await (await sanne.sessions()).toArray()) {
    const page = await session.messages({ filters: { peer_id: sanne.id } });
    said.push(...(await page.toArray()));
  }
  const copy = {
    said,
    facts: await (await sanne.conclusions.list()).toArray(),
    card: await sanne.getCard(),
  };
  // #endregion

  // #region forget-fact
  // "Forget that I'm on the billing team." Show people what Recall holds about them (a settings
  // page works well) and delete what they pick.
  const picked = copy.facts.find((fact) => fact.content.includes("billing team"));
  if (picked) await sanne.conclusions.delete(picked.id);
  // The peer card is kept separately: write it back without that line.
  const card = copy.card ?? [];
  const kept = card.filter((line) => !line.includes("billing team"));
  if (kept.length < card.length) await sanne.setCard(kept);
  // #endregion

  // #region forget-person
  // Erase the person: their messages and memberships, every fact and card about them or from
  // their point of view, the summaries that quoted them, and cached answers.
  const erased = await sanne.delete();
  // Other people's messages stay, and so do facts about other people that mention her.
  // Delete the ones that must go.
  const facts = await (await colleague.conclusions.list()).toArray();
  for (const fact of facts.filter((f) => f.content.includes("Sanne"))) {
    await colleague.conclusions.delete(fact.id);
  }
  // To remove what others said in that conversation too, delete the whole session.
  await standup.delete();
  // #endregion

  // #region retention
  // Your own retention rule, run daily: delete conversations older than 90 days. Their
  // messages, summaries and the facts learned in them go too.
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const old = await recall.sessions({ filters: { created_at: { lt: cutoff } } });
  for (const session of await old.toArray()) await session.delete();
  // #endregion

  // #region delete-workspace
  // The customer closes their account: delete every session first, then the workspace
  // (deleting a workspace that still has sessions answers 409).
  for (const session of await (await recall.sessions()).toArray()) await session.delete();
  await recall.deleteWorkspace();
  // #endregion
  return { copy, erased };
}
