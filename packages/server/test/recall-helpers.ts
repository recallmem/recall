import { sql } from "drizzle-orm";
import type { AppContext } from "../src/context.js";
import { newId } from "../src/lib/ids.js";
import { countTokens } from "../src/lib/tokens.js";
import { vecLiteral } from "../src/recall/util.js";

/**
 * Seeds a small world straight into the tables (components A and B own the real
 * write paths): workspace "acme", peers alice and bob, sessions s1 (both) and s2
 * (alice), dated messages, alice's conclusions including a superseded pair and a
 * derived one, a peer card and session summaries.
 */
export interface World {
  ws: string;
  alice: string;
  bob: string;
  s1: string;
  s2: string;
  collection: string;
  conclusion: Record<string, string>;
}

const iso = (d: string) => new Date(`${d}T12:00:00Z`).toISOString();

async function embedAll(ctx: AppContext, ws: string, texts: string[]): Promise<string[]> {
  const vecs = await ctx.embeddings.embed(texts, ws);
  return vecs.map(vecLiteral);
}

export async function seedWorld(ctx: AppContext, opts: { fillers?: number } = {}): Promise<World> {
  const db = ctx.db;
  const ws = newId();
  const alice = newId();
  const bob = newId();
  const s1 = newId();
  const s2 = newId();
  await db.execute(
    sql`INSERT INTO workspaces (id, account_id, name) VALUES (${ws}, 'default', 'acme')`,
  );
  await db.execute(
    sql`INSERT INTO peers (id, workspace_id, name) VALUES (${alice}, ${ws}, 'alice'), (${bob}, ${ws}, 'bob')`,
  );
  await db.execute(
    sql`INSERT INTO sessions (id, workspace_id, name, next_seq) VALUES (${s1}, ${ws}, 's1', 13), (${s2}, ${ws}, 's2', 2)`,
  );
  await db.execute(
    sql`INSERT INTO session_peers (workspace_id, session_id, peer_id) VALUES
        (${ws}, ${s1}, ${alice}), (${ws}, ${s1}, ${bob}), (${ws}, ${s2}, ${alice})`,
  );

  const msgs: [string, string, string, string, number][] = [
    [
      s1,
      alice,
      "2026-01-10",
      "I just moved to Amsterdam and I work as a data engineer at Acme.",
      1,
    ],
    [s1, bob, "2026-01-10", "Nice! What do you do for fun?", 2],
    [s1, alice, "2026-01-11", "I love hiking in the Alps and I have a dog named Rover.", 3],
    [s1, bob, "2026-01-11", "How long have you had Rover?", 4],
    [s1, alice, "2026-01-12", "Since September 2025. He is a golden retriever.", 5],
    [s1, alice, "2026-03-02", "Big news: I relocated to Utrecht last week.", 6],
    [s1, bob, "2026-03-02", "Congrats! Do you still commute to Acme?", 7],
    [
      s1,
      alice,
      "2026-03-05",
      "I switched jobs, I am now a machine learning engineer at Globex.",
      8,
    ],
    [s1, alice, "2026-03-06", "My favorite color is green, by the way.", 9],
    [s1, bob, "2026-03-06", "Noted. Green it is.", 10],
    [s1, alice, "2026-03-20", "Thinking about adopting a second dog next spring.", 11],
    [s1, bob, "2026-03-21", "Rover would like that.", 12],
    [s2, alice, "2026-02-01", "Planning a trip to Japan in April 2026 with my sister Mila.", 1],
  ];
  const mv = await embedAll(
    ctx,
    ws,
    msgs.map((m) => m[3]),
  );
  for (const [i, [session, peer, date, content, seq]] of msgs.entries()) {
    await db.execute(
      sql`INSERT INTO messages (id, workspace_id, session_id, peer_id, seq_in_session, content, token_count, embedding, created_at)
          VALUES (${newId()}, ${ws}, ${session}, ${peer}, ${seq}, ${content}, ${countTokens(content)}, ${mv[i]!}::vector, ${iso(date)}::timestamptz)`,
    );
  }

  const collection = newId();
  await db.execute(
    sql`INSERT INTO collections (id, workspace_id, observer_id, observed_id, peer_card, version)
        VALUES (${collection}, ${ws}, ${alice}, ${alice},
          ${JSON.stringify(["Alice is a machine learning engineer", "Lives in Utrecht", "Has a dog named Rover"])}::jsonb, 3)`,
  );
  const bobView = newId();
  await db.execute(
    sql`INSERT INTO collections (id, workspace_id, observer_id, observed_id, version) VALUES (${bobView}, ${ws}, ${bob}, ${alice}, 1)`,
  );

  const ids: Record<string, string> = {};
  type C = {
    key: string;
    text: string;
    level?: string;
    session?: string;
    importance?: number;
    times?: number;
    from: string;
    to?: string;
    by?: string;
    sources?: string[];
    coll?: string;
    observer?: string;
  };
  const conclusions: C[] = [
    {
      key: "amsterdam",
      text: "Alice lived in Amsterdam",
      from: "2026-01-10",
      to: "2026-03-02",
      by: "utrecht",
      session: s1,
      importance: 0.6,
    },
    {
      key: "utrecht",
      text: "Alice lives in Utrecht",
      from: "2026-03-02",
      session: s1,
      importance: 0.8,
      times: 2,
    },
    {
      key: "dataeng",
      text: "Alice worked as a data engineer at Acme",
      from: "2026-01-10",
      to: "2026-03-05",
      by: "mleng",
      session: s1,
      importance: 0.6,
    },
    {
      key: "mleng",
      text: "Alice works as a machine learning engineer at Globex",
      from: "2026-03-05",
      session: s1,
      importance: 0.8,
    },
    {
      key: "rover",
      text: "Alice has a golden retriever named Rover, adopted in September 2025",
      from: "2026-01-11",
      session: s1,
      importance: 0.7,
      times: 3,
    },
    {
      key: "hiking",
      text: "Alice loves hiking in the Alps",
      from: "2026-01-11",
      session: s1,
      importance: 0.5,
    },
    {
      key: "color",
      text: "Alice's favorite color is green",
      from: "2026-03-06",
      session: s1,
      importance: 0.4,
    },
    {
      key: "japan",
      text: "Alice is planning a trip to Japan in April 2026 with her sister Mila",
      from: "2026-02-01",
      session: s2,
      importance: 0.6,
    },
    {
      key: "dog2",
      text: "Alice is thinking about adopting a second dog next spring",
      from: "2026-03-20",
      session: s1,
      importance: 0.5,
    },
    {
      key: "outdoors",
      text: "Alice is an outdoorsy person who enjoys nature and animals",
      level: "deductive",
      from: "2026-03-21",
      session: s1,
      importance: 0.5,
      sources: ["hiking", "rover"],
    },
    {
      key: "bobview",
      text: "Alice told Bob she has a dog",
      from: "2026-01-11",
      session: s1,
      importance: 0.5,
      coll: bobView,
      observer: bob,
    },
  ];
  const fillers = opts.fillers ?? 0;
  for (let i = 0; i < fillers; i++) {
    conclusions.push({
      key: `filler${i}`,
      text: `Alice mentioned topic number ${i} about gardening tomatoes and weather in week ${i % 7}`,
      from: "2026-02-15",
      session: s1,
      importance: 0.2,
    });
  }
  for (const c of conclusions) ids[c.key] = newId();
  const cv = await embedAll(
    ctx,
    ws,
    conclusions.map((c) => c.text),
  );
  for (const [i, c] of conclusions.entries()) {
    const observer = c.observer ?? alice;
    await db.execute(
      sql`INSERT INTO conclusions (id, workspace_id, collection_id, observer_id, observed_id, session_id, content, level,
            confidence, importance, times_derived, source_ids, valid_from, valid_to, superseded_by, embedding, created_at)
          VALUES (${ids[c.key]!}, ${ws}, ${c.coll ?? collection}, ${observer}, ${alice}, ${c.session ?? null}, ${c.text},
            ${c.level ?? "explicit"}, 0.9, ${c.importance ?? 0.5}, ${c.times ?? 1},
            ${sql.raw(`ARRAY[${(c.sources ?? []).map((k) => `'${ids[k]}'`).join(",")}]::text[]`)},
            ${iso(c.from)}::timestamptz, ${c.to ? iso(c.to) : null}::timestamptz, ${c.by ? ids[c.by]! : null},
            ${cv[i]!}::vector, ${iso(c.from)}::timestamptz)`,
    );
  }

  const lastMsg = await db.execute(
    sql`SELECT id FROM messages WHERE session_id = ${s1} AND seq_in_session = 8`,
  );
  const last8 = (lastMsg as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const long = await db.execute(
    sql`SELECT id FROM messages WHERE session_id = ${s1} AND seq_in_session = 12`,
  );
  const last12 = (long as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const short =
    "Alice moved from Amsterdam to Utrecht, left Acme for Globex as a machine learning engineer, and talks about her dog Rover.";
  const longer = `${short} She loves hiking in the Alps, her favorite color is green, and she is considering a second dog next spring.`;
  await db.execute(
    sql`INSERT INTO summary_blocks (id, workspace_id, session_id, kind, start_seq, end_seq, last_message_id, content, token_count)
        VALUES (${newId()}, ${ws}, ${s1}, 'short', 1, 8, ${last8}, ${short}, ${countTokens(short)}),
               (${newId()}, ${ws}, ${s1}, 'long', 1, 12, ${last12}, ${longer}, ${countTokens(longer)})`,
  );
  return { ws, alice, bob, s1, s2, collection, conclusion: ids };
}

/** Flushes buffered usage and returns the chat_* rows recorded since `since` (exclusive id). */
export async function chatUsage(ctx: AppContext, since = 0) {
  await ctx.usage.flush();
  const r = (await ctx.db.execute(
    sql`SELECT id, task, input_tokens, output_tokens FROM llm_usage WHERE task LIKE 'chat_%' AND id > ${since} ORDER BY id`,
  )) as unknown as {
    rows: {
      id: number | string;
      task: string;
      input_tokens: number | string;
      output_tokens: number | string;
    }[];
  };
  return r.rows.map((x) => ({
    id: Number(x.id),
    task: x.task,
    inputTokens: Number(x.input_tokens),
    outputTokens: Number(x.output_tokens),
  }));
}

export interface SseFrame {
  delta?: { content: string };
  done: boolean;
  evidence?: { conclusions: unknown[] };
  citations?: string[];
  confidence?: number;
  abstained?: boolean;
}

/** Splits an SSE body into its `data:` frames. */
export function parseSse(body: string): SseFrame[] {
  return body
    .trim()
    .split("\n\n")
    .map((f) => JSON.parse(f.slice("data: ".length)) as SseFrame);
}
