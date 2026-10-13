// Guide: https://recallmem.dev/guides/coding-agents
// A coding agent of your own: the developer's preferences, the repository's rules and its past
// decisions. Run by packages/sdk/test/guides.test.ts against a real server.
import { Recall } from "@recall-memory/sdk";

export async function main(recall = new Recall({ workspaceId: "acme-eng" })) {
  // #region setup
  const dev = recall.peer("dev-4821");
  // Recall learns about the developer, not from the agent's own replies.
  const agent = recall.peer("coding-agent");
  await agent.setConfiguration({ observeMe: false });
  // The repository's rules live on a peer of their own. Nobody speaks as it.
  const repo = recall.peer("repo-billing-api");
  await repo.setConfiguration({ observeMe: false });

  // One session per coding session, filed under the repository's scope.
  const session = recall.session("cs-20261010-7f2c", {
    peers: [dev, agent],
    scopes: ["billing-api"],
  });
  // #endregion

  // #region rules
  // Rules the team states outright: write them as facts, so they hold from the first session.
  await repo.conclusions.create([
    "Migrations are generated with `pnpm db:generate`; never edit them by hand.",
    "billing-api runs on Node 22 and uses pnpm, not npm.",
    "Money amounts are integers in cents; never floats.",
  ]);
  // #endregion

  // #region start
  // At session start: what is known about the developer and the rules that touch the task.
  // Two reads: no answer is generated, so they are fast and included in the price.
  const task = "Add a refund_reason column to the payments table";
  const [ctx, rules] = await Promise.all([
    session.context({ peerTarget: dev, searchQuery: task, tokens: 1500 }),
    repo.context({ searchQuery: task }),
  ]);
  const messages = [
    { role: "system", content: `Rules of this repository:\n${rules.representation ?? ""}` },
    ...ctx.toOpenAI(agent),
  ];
  // #endregion

  // #region record
  // After each turn: the developer's prompt and the agent's final answer. No tool output, no file
  // contents, no secrets (this pattern is crude: run your own secret scanner too).
  const redact = (text: string) =>
    text.replace(/\b(?:sk|pk|ghp|xox[bp])[-_][\w-]{16,}/g, "[redacted]").slice(0, 24_000);
  const prompt = "Add refund_reason to payments. Nullable for now, we backfill next sprint.";
  // Your model wrote this answer from `messages`.
  const answer = "Added a nullable refund_reason column and generated migration 0042.";
  await session.addMessages([dev.message(redact(prompt)), agent.message(redact(answer))]);
  // #endregion

  // #region decisions
  // Weeks later, from any session: what was decided in this repository? Only sessions in its
  // scope are read. (waitForIdle is for this demo; an agent rarely blocks on learning.)
  await recall.waitForIdle();
  const decided = await recall.chat("Is refund_reason nullable, and why?", {
    scope: "billing-api",
    reasoningLevel: "low",
  });
  // #endregion

  // #region forget
  // A rule that changed: delete the old fact and write the new one.
  const stale: string[] = [];
  for await (const rule of await repo.conclusions.list()) {
    if (rule.content.includes("Node 22")) stale.push(rule.id);
  }
  for (const id of stale) await repo.conclusions.delete(id);
  await repo.conclusions.create("billing-api runs on Node 24 and uses pnpm, not npm.");
  // A developer who leaves: erase them and everything learned from or about them.
  await dev.delete();
  // #endregion
  return { messages, decided };
}
