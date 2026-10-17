import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { rows } from "../db/client.js";
import { textArray } from "../reasoner/util.js";

/**
 * The memory change log (0025_memory_events.sql): what changed in a fact or a peer card, who
 * changed it and why, and from what. Written in the same transaction as the change it records.
 */

type Tx = Pick<Db, "execute">;

/** Who made a change. */
export type MemoryActor = "reasoner" | "dream" | "api" | "dashboard" | "system";

/**
 * What happened: a fact was `created`, learned again (`reinforced`), replaced by a newer one
 * (`superseded`), folded into another or given the text of several (`merged`), changed by a person
 * (`edited`), `pinned` or `unpinned`, or disagreed with while pinned (`conflict`); or the peer
 * `card` changed.
 */
export type MemoryAction =
  | "created"
  | "reinforced"
  | "superseded"
  | "merged"
  | "edited"
  | "pinned"
  | "unpinned"
  | "conflict"
  | "expired"
  | "card";

export interface MemoryEvent {
  workspaceId: string;
  collectionId: string;
  /** Null for a change to the peer card. */
  conclusionId: string | null;
  action: MemoryAction;
  actor: MemoryActor;
  /** The API key, dashboard user or job behind it, when known. */
  actorRef?: string | null;
  reason?: string | null;
  /** Message ids or fact ids it came from. */
  sources?: readonly string[];
  before?: unknown;
  after?: unknown;
}

const json = (v: unknown): SQL =>
  v === undefined || v === null ? sql`NULL` : sql`${JSON.stringify(v)}::jsonb`;

/** Records events in one statement. Facts and collections they name must exist. */
export async function recordEvents(tx: Tx, events: readonly MemoryEvent[]): Promise<void> {
  if (!events.length) return;
  const values = events.map(
    (e) =>
      sql`(${e.workspaceId}, ${e.collectionId}, ${e.conclusionId}, ${e.action}, ${e.actor}, ${e.actorRef ?? null},
        ${e.reason ?? null}, ${textArray([...(e.sources ?? [])])}, ${json(e.before)}, ${json(e.after)})`,
  );
  await tx.execute(
    sql`INSERT INTO memory_events (workspace_id, collection_id, conclusion_id, action, actor, actor_ref, reason,
          sources, before, after)
        VALUES ${sql.join(values, sql`, `)}`,
  );
}

export interface MemoryEventOut {
  action: MemoryAction;
  actor: MemoryActor;
  reason: string | null;
  sources: string[];
  before: unknown;
  after: unknown;
  created_at: string;
}

interface EventRow {
  action: MemoryAction;
  actor: MemoryActor;
  reason: string | null;
  sources: string[] | null;
  before: unknown;
  after: unknown;
  created_at: Date | string;
}

const toOut = (r: EventRow): MemoryEventOut => ({
  action: r.action,
  actor: r.actor,
  reason: r.reason,
  sources: r.sources ?? [],
  before: r.before ?? null,
  after: r.after ?? null,
  created_at: new Date(r.created_at).toISOString(),
});

/**
 * Closes facts whose expiry date has passed (at most `limit` per call), logs it and bumps their
 * collections. Reads already treat them as no longer current; this makes it permanent.
 */
export async function expireFacts(db: Db, limit = 1000): Promise<number> {
  const done = await rows<{ n: number }>(
    db,
    sql`WITH gone AS (
          UPDATE conclusions c SET valid_to = GREATEST(COALESCE(c.valid_from, c.created_at), c.expires_at),
                 updated_at = now()
          WHERE c.id IN (SELECT id FROM conclusions WHERE expires_at <= now() AND valid_to IS NULL
                           AND deleted_at IS NULL LIMIT ${limit})
          RETURNING c.id, c.workspace_id, c.collection_id, c.valid_to),
        logged AS (
          INSERT INTO memory_events (workspace_id, collection_id, conclusion_id, action, actor, reason, after)
          SELECT workspace_id, collection_id, id, 'expired', 'system', 'its expiry date passed',
                 jsonb_build_object('valid_to', valid_to) FROM gone),
        bumped AS (
          UPDATE collections SET version = version + 1 WHERE id IN (SELECT collection_id FROM gone))
        SELECT count(*)::int AS n FROM gone`,
  );
  return done[0]?.n ?? 0;
}

/** A fact's events, oldest first. */
export async function factEvents(
  db: Db,
  conclusionId: string,
  limit = 200,
): Promise<MemoryEventOut[]> {
  const found = await rows<EventRow>(
    db,
    sql`SELECT action, actor, reason, sources, before, after, created_at FROM memory_events
        WHERE conclusion_id = ${conclusionId} ORDER BY id LIMIT ${limit}`,
  );
  return found.map(toOut);
}

/** Events of several facts, oldest first per fact, at most `perFact` (the newest) each. */
export async function eventsOf(
  db: Db,
  ids: readonly string[],
  perFact = 20,
): Promise<Map<string, MemoryEventOut[]>> {
  const out = new Map<string, MemoryEventOut[]>();
  if (!ids.length) return out;
  const found = await rows<EventRow & { conclusion_id: string }>(
    db,
    sql`SELECT conclusion_id, action, actor, reason, sources, before, after, created_at FROM (
          SELECT e.*, row_number() OVER (PARTITION BY e.conclusion_id ORDER BY e.id DESC) AS n
          FROM memory_events e WHERE e.conclusion_id = ANY(${textArray([...ids])})) x
        WHERE n <= ${perFact} ORDER BY conclusion_id, n DESC`,
  );
  for (const r of found) out.set(r.conclusion_id, [...(out.get(r.conclusion_id) ?? []), toOut(r)]);
  return out;
}

/** A collection's card changes, newest first. */
export async function cardEvents(
  db: Db,
  collectionId: string,
  limit = 20,
): Promise<MemoryEventOut[]> {
  const found = await rows<EventRow>(
    db,
    sql`SELECT action, actor, reason, sources, before, after, created_at FROM memory_events
        WHERE collection_id = ${collectionId} AND conclusion_id IS NULL ORDER BY id DESC LIMIT ${limit}`,
  );
  return found.map(toOut);
}

/** The lines a card change added and removed, for the log (the full card is not kept twice). */
export function cardDiff(before: readonly string[], after: readonly string[]) {
  const was = new Set(before);
  const now = new Set(after);
  return {
    added: after.filter((l) => !was.has(l)),
    removed: before.filter((l) => !now.has(l)),
  };
}
