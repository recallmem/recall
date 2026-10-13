// Guide: https://recallmem.dev/guides/coaching
// A running coach that remembers a client's goals, setbacks and what worked: intake answers from a
// form, a check-in, a weekly review as JSON, a "what my coach remembers" page and deletion.
// Run by packages/sdk/test/guides.test.ts against a real server.
import { Recall } from "@recall-memory/sdk";

export async function main(recall = new Recall({ workspaceId: "coach-app" })) {
  // #region setup
  const client = recall.peer("client-3087");
  // The coach is your app, so Recall learns about the client, not from the coach's own lines.
  const coach = recall.peer("coach", { configuration: { observeMe: false } });
  // One session per check-in.
  const checkin = recall.session("checkin-71204", { peers: [client, coach] });
  // #endregion

  // #region intake
  // What the client typed into your intake form is already a fact: write it directly. It is
  // searchable at once, with no model in between. Store only what coaching needs, with consent.
  await client.conclusions.create([
    "Goal: run a 10 km race in March.",
    "Trains on weekday mornings, before work.",
    "Knee injury last year; cleared to run by their physiotherapist.",
  ]);
  // #endregion

  // #region checkin
  // Each client message: store it and get back what the coach should know, in one request.
  const { context } = await checkin.turn(
    [client.message("Missed two runs this week, work was brutal. Did my Sunday 5 km though.")],
    { peerTarget: client, tokens: 2000 },
  );
  const prompt = context.toOpenAI(coach); // intake facts and past check-ins, then this one
  // Your model writes the coach's reply from `prompt`; store it with the check-in.
  await checkin.addMessages([
    coach.message("Sunday counts. Shall we move Thursday's run to the morning too?"),
  ]);
  // #endregion

  // #region weekly-review
  // Once a week: a review as JSON that your app turns into next week's plan.
  // (waitForIdle is for this demo; a weekly job runs long after learning has finished.)
  await recall.waitForIdle();
  type WeeklyReview = { progress: string[]; setbacks: string[]; worked: string[]; focus: string };
  const list = { type: "array", items: { type: "string" } };
  const review = await client.chat(
    "Review this client's last week against their goals: progress, setbacks, what worked, " +
      "and the one thing to focus on next week.",
    {
      reasoningLevel: "low",
      responseFormat: {
        jsonSchema: {
          type: "object",
          properties: { progress: list, setbacks: list, worked: list, focus: { type: "string" } },
          required: ["progress", "setbacks", "worked", "focus"],
        },
        parse: (data: unknown) => data as WeeklyReview, // or a zod schema's parse
      },
    },
  );
  // #endregion

  // #region remembers
  // A "what my coach remembers" page for the client, served by your backend: these routes need a
  // workspace key. The list includes facts that have since changed, not only current ones.
  const page = await client.conclusions.list({ size: 50 });
  const remembered = page.items.map((c) => ({ id: c.id, fact: c.content, learned: c.createdAt }));
  // The client taps "forget" next to a fact:
  const tapped = remembered[0]!.id;
  await client.conclusions.delete(tapped);
  // #endregion

  // #region forget
  // The client deletes their account: their check-ins first (the coach's replies quote them),
  // then the client and everything learned about them.
  for (const s of await (await client.sessions()).toArray()) await s.delete();
  const removed = await client.delete();
  // #endregion
  return { prompt, review, remembered, removed };
}
