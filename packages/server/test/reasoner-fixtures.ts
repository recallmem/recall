import { sql } from "drizzle-orm";
import type { AppContext } from "../src/context.js";
import { rows } from "../src/db/client.js";
import { newId } from "../src/lib/ids.js";
import { countTokens } from "../src/lib/tokens.js";
import { resolveConfig } from "../src/reasoner/config.js";
import { scheduleMessageProcessing, scheduleSummaries } from "../src/reasoner/schedule.js";

/**
 * Direct-SQL fixtures for component B tests: workspaces, peers, sessions and
 * messages inserted the way message creation does it (contract 1): observers
 * and reasoning resolved into `messages.internal`, and the reason/summary jobs
 * scheduled in the same transaction.
 */

export interface Seed {
  workspaceId: string;
  workspaceName: string;
  sessionId: string;
  sessionName: string;
  peers: Record<string, string>;
  observeOthers: string[];
  wsConfig: Record<string, unknown>;
  sessionConfig: Record<string, unknown>;
}

export async function seed(
  ctx: AppContext,
  opts: {
    workspace?: string;
    session?: string;
    peers: string[];
    observeOthers?: string[];
    wsConfig?: Record<string, unknown>;
    sessionConfig?: Record<string, unknown>;
  },
): Promise<Seed> {
  const workspaceName = opts.workspace ?? `ws_${newId().slice(0, 8)}`;
  const sessionName = opts.session ?? "s1";
  const wsConfig = opts.wsConfig ?? {};
  const sessionConfig = opts.sessionConfig ?? {};
  const [w] = await rows<{ id: string }>(
    ctx.db,
    sql`INSERT INTO workspaces (id, account_id, name, configuration)
        VALUES (${newId()}, 'default', ${workspaceName}, ${JSON.stringify(wsConfig)}::jsonb)
        ON CONFLICT (account_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
  );
  const workspaceId = w!.id;
  const peers: Record<string, string> = {};
  for (const name of opts.peers) {
    const [p] = await rows<{ id: string }>(
      ctx.db,
      sql`INSERT INTO peers (id, workspace_id, name) VALUES (${newId()}, ${workspaceId}, ${name})
          ON CONFLICT (workspace_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    );
    peers[name] = p!.id;
  }
  const sessionId = newId();
  await ctx.db.execute(
    sql`INSERT INTO sessions (id, workspace_id, name, configuration)
        VALUES (${sessionId}, ${workspaceId}, ${sessionName}, ${JSON.stringify(sessionConfig)}::jsonb)`,
  );
  const observeOthers = opts.observeOthers ?? [];
  for (const name of opts.peers) {
    await ctx.db.execute(
      sql`INSERT INTO session_peers (workspace_id, session_id, peer_id, configuration)
          VALUES (${workspaceId}, ${sessionId}, ${peers[name]!},
                  ${JSON.stringify({ observe_others: observeOthers.includes(name) })}::jsonb)`,
    );
  }
  return {
    workspaceId,
    workspaceName,
    sessionId,
    sessionName,
    peers,
    observeOthers,
    wsConfig,
    sessionConfig,
  };
}

export interface NewMessage {
  peer: string;
  content: string;
  createdAt?: Date;
  reasoning?: boolean;
  instructions?: string | null;
}

/** Inserts messages in one transaction and schedules their background work, like the API. */
export async function addMessages(
  ctx: AppContext,
  s: Seed,
  messages: NewMessage[],
): Promise<string[]> {
  const cfg = resolveConfig([s.wsConfig, s.sessionConfig]);
  return ctx.db.transaction(async (tx) => {
    const [row] = await rows<{ next_seq: number | string }>(
      tx,
      sql`SELECT next_seq FROM sessions WHERE id = ${s.sessionId} FOR UPDATE`,
    );
    let seq = Number(row!.next_seq);
    const ids: string[] = [];
    let tokens = 0;
    for (const m of messages) {
      const id = newId();
      const author = s.peers[m.peer]!;
      const reasoning = (m.reasoning ?? true) && cfg.reasoning.enabled;
      const observers = [
        author,
        ...s.observeOthers.filter((o) => o !== m.peer).map((o) => s.peers[o]!),
      ];
      const tokenCount = countTokens(m.content);
      tokens += tokenCount;
      await tx.execute(
        sql`INSERT INTO messages (id, workspace_id, session_id, peer_id, seq_in_session, content, internal, token_count, created_at)
            VALUES (${id}, ${s.workspaceId}, ${s.sessionId}, ${author}, ${seq}, ${m.content},
                    ${JSON.stringify({ observers, reasoning, instructions: m.instructions ?? cfg.reasoning.instructions })}::jsonb,
                    ${tokenCount}, ${m.createdAt ?? new Date()})`,
      );
      if (cfg.summary.enabled) {
        await scheduleSummaries(tx, {
          workspaceId: s.workspaceId,
          sessionId: s.sessionId,
          seqInSession: seq,
          shortEvery: cfg.summary.shortEvery,
          longEvery: cfg.summary.longEvery,
        });
      }
      ids.push(id);
      seq++;
    }
    await tx.execute(sql`UPDATE sessions SET next_seq = ${seq} WHERE id = ${s.sessionId}`);
    await scheduleMessageProcessing(tx, {
      workspaceId: s.workspaceId,
      sessionId: s.sessionId,
      newTokens: tokens,
    });
    return ids;
  });
}

export interface ConclusionRow {
  id: string;
  observer: string;
  observed: string;
  content: string;
  level: string;
  times_derived: number;
  valid_to: Date | null;
  superseded_by: string | null;
  deleted_at: Date | null;
  message_ids: string[];
  source_ids: string[];
  category: string | null;
}

export async function conclusions(ctx: AppContext, workspaceId: string): Promise<ConclusionRow[]> {
  return rows<ConclusionRow>(
    ctx.db,
    sql`SELECT c.id, o.name AS observer, d.name AS observed, c.content, c.level, c.times_derived, c.valid_to,
               c.superseded_by, c.deleted_at, c.message_ids, c.source_ids, c.category
        FROM conclusions c JOIN peers o ON o.id = c.observer_id JOIN peers d ON d.id = c.observed_id
        WHERE c.workspace_id = ${workspaceId} ORDER BY c.created_at, c.id`,
  );
}

export async function usageByTask(ctx: AppContext, workspaceId: string) {
  await ctx.usage.flush();
  const found = await rows<{
    task: string;
    calls: number;
    input: number | string;
    output: number | string;
  }>(
    ctx.db,
    sql`SELECT task, count(*)::int AS calls, sum(input_tokens) AS input, sum(output_tokens) AS output
        FROM llm_usage WHERE workspace_id = ${workspaceId} GROUP BY task ORDER BY task`,
  );
  return Object.fromEntries(
    found.map((r) => [
      r.task,
      { calls: r.calls, input: Number(r.input), output: Number(r.output) },
    ]),
  );
}
