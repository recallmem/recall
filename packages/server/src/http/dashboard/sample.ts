import { sql } from "drizzle-orm";
import type { AppContext } from "../../context.js";
import { createMessages, type NewMessage } from "../../core/messages.js";
import { findActiveSession } from "../../core/sessions.js";
import { wsKey } from "../../core/tenancy.js";
import { rows } from "../../db/client.js";

/**
 * "Try it on a sample conversation": the dashboard's first run for someone who has not written
 * a line of code. One click stores a short, dated conversation in a workspace of the user's own
 * account, through the same path as POST .../messages (billed the same way, a fraction of a
 * cent), and the Playground then suggests questions that show what Recall does: the current
 * answer with its sources, the history of a fact that changed, and saying so when memory holds
 * nothing. Loading it again is a no-op.
 */

export const SAMPLE_WS = "try-recall";
export const SAMPLE_SESSION = "chats-with-alex";
export const SAMPLE_PEER = "alex";

/** Questions the Playground offers for the sample, each showing one thing Recall does. */
export const SAMPLE_QUESTIONS: readonly { q: string; shows: string }[] = [
  { q: "Where does Alex live now?", shows: "the current fact, with the message it came from" },
  { q: "Where has Alex lived, and when did that change?", shows: "history kept, not overwritten" },
  { q: "What should I cook for Alex?", shows: "a preference applied to a new question" },
  { q: "Who is visiting Alex, and when?", shows: "people and dates" },
  { q: "What is Alex's favourite band?", shows: "no guess when memory holds nothing" },
];

const DAY = 86_400_000;

/** The conversation, spread over four months that end a few days ago. */
export function sampleMessages(now: Date): NewMessage[] {
  const at = (daysAgo: number, minute: number) =>
    new Date(
      Math.floor(now.getTime() / DAY) * DAY - daysAgo * DAY + 9 * 3_600_000 + minute * 60_000,
    );
  const alex = (daysAgo: number, minute: number, content: string): NewMessage => ({
    peer_id: SAMPLE_PEER,
    content,
    created_at: at(daysAgo, minute),
  });
  const bot = (daysAgo: number, minute: number, content: string): NewMessage => ({
    peer_id: "assistant",
    content,
    created_at: at(daysAgo, minute),
  });
  return [
    alex(
      121,
      0,
      "Hi! I'm Alex (they/them). I live in Chicago and work night shifts as a nurse at a children's hospital.",
    ),
    bot(121, 1, "Nice to meet you, Alex. Night shifts are tough. How can I help?"),
    alex(
      121,
      2,
      "Meal ideas, mostly. I'm vegetarian, and I need things I can cook on Sunday and eat all week.",
    ),
    bot(
      121,
      3,
      "Got it: vegetarian batch cooking. A lentil chili or a chickpea curry keeps well for five days.",
    ),
    alex(
      94,
      0,
      "The chickpea curry was a hit. My sister Maya loved it too, and she never likes my cooking.",
    ),
    bot(94, 1, "That's a win. Want a second recipe in the same style?"),
    alex(
      38,
      0,
      "Big news: I moved to Lisbon last month! Still nursing, but now day shifts at a small clinic.",
    ),
    bot(38, 1, "Congratulations on the move to Lisbon. Day shifts should make cooking easier."),
    alex(38, 2, "They do. I've also started Portuguese lessons twice a week."),
    alex(
      6,
      0,
      "Maya is coming to visit me in Lisbon in May. Any vegetarian places I should take her to?",
    ),
    bot(
      6,
      1,
      "Lovely. I'll look for vegetarian restaurants in Lisbon for when Maya visits in May.",
    ),
  ];
}

/** Stores the sample in the user's account unless it is there already. */
export async function loadSample(ctx: AppContext, accountId: string): Promise<void> {
  const key = wsKey(accountId, SAMPLE_WS);
  if (await findActiveSession(ctx.db, key, SAMPLE_SESSION)) return;
  await createMessages(ctx, {
    workspace: key,
    session: SAMPLE_SESSION,
    messages: sampleMessages(new Date()),
    idempotencyKey: "recall-sample-conversation-v1",
  });
}

/** Live facts Recall has concluded about a peer of a workspace (0 while it is still reading). */
export async function factCount(ctx: AppContext, wsId: string, peer: string): Promise<number> {
  const [r] = await rows<{ n: number }>(
    ctx.db,
    sql`SELECT count(*)::int AS n FROM conclusions c JOIN peers p ON p.id = c.observed_id
        WHERE c.workspace_id = ${wsId} AND p.name = ${peer} AND c.deleted_at IS NULL`,
  );
  return r?.n ?? 0;
}
