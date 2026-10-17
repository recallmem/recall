import { type SQL, sql } from "drizzle-orm";
import { cardDiff, type MemoryEvent, recordEvents } from "../core/history.js";
import type { Db } from "../db/client.js";
import { rows } from "../db/client.js";
import {
  closedAt,
  distinctOccurrences,
  type EventTime,
  endedBy,
  eventOf,
  eventTime,
  laterState,
  stateStart,
  type Timed,
} from "../lib/event-time.js";
import { newId } from "../lib/ids.js";
import { normalizeTags } from "../lib/tags.js";
import { applyCardEdits, cardValueTerms } from "./cards.js";
import type { ExtractionOut, FactOut } from "./prompt.js";
import { clamp, cleanText, normKey, textArray, vec } from "./util.js";

type Tx = Pick<Db, "execute">;
type Obj = Record<string, string>;

/** Cosine distance at or below which a "new" fact is the same fact said again. */
export const DUPLICATE_DISTANCE = 0.05;

export interface WindowSpeaker {
  peerId: string;
  name: string;
  /** Observers of this speaker's target messages in the window (peer ids). */
  observers: Set<string>;
  /** Message time of the speaker's newest target message: when its card edits were true. */
  lastAt?: Date;
}

export interface TranscriptRef {
  id: string;
  peerId: string;
  createdAt: Date;
  /** Reasoning target (not a context line, reasoning on, observers present). */
  target: boolean;
  observers: string[];
}

export interface KnownRef {
  id: string;
  key: string;
  observedId: string;
}

export interface PreparedFact {
  aboutId: string;
  content: string;
  level: "explicit" | "deductive";
  category: string;
  confidence: number;
  importance: number;
  messageIds: string[];
  validFrom: Date;
  /** When what the fact describes happened or began; null for facts without a time of their own. */
  event: EventTime | null;
  /** What it is about, normalized (see lib/tags.ts). */
  tags: string[];
  observers: string[];
  action: "add" | "reinforce" | "supersede";
  target: KnownRef | null;
}

/**
 * Validates the model's facts against the transcript: a fact is kept only when it
 * cites at least one target message its subject wrote in this window. A fact that
 * cites nothing valid is dropped, never attributed to some other message: a source
 * is what the fact was learned from, so it cannot be filled in afterwards.
 * Observers come from the cited messages, and reinforce/supersede targets must be
 * known facts about the same peer. Duplicates within the batch are merged.
 */
export function prepareFacts(
  facts: FactOut[],
  speakers: Map<string, WindowSpeaker>,
  transcript: Map<number, TranscriptRef>,
  known: Map<string, KnownRef>,
): PreparedFact[] {
  const out: PreparedFact[] = [];
  const seen = new Map<string, PreparedFact>();
  for (const f of facts) {
    const speaker = speakers.get(f.about.trim().toLowerCase());
    if (!speaker) continue;
    const content = cleanText(f.content);
    if (content.length < 3) continue;
    const cited = [...new Set(f.source_messages)]
      .map((n) => transcript.get(n))
      .filter((m) => m !== undefined);
    const own = cited.filter((m) => m.target && m.peerId === speaker.peerId);
    if (!own.length) continue;
    const sources = [...new Map([...cited, ...own].map((m) => [m.id, m])).values()];
    const observers = [...new Set(own.flatMap((m) => m.observers))];
    const validFrom = new Date(Math.max(...own.map((m) => m.createdAt.getTime())));
    const event = eventTime(f.event_start, f.event_end);
    const tags = normalizeTags(f.tags);
    let target = f.target ? (known.get(f.target.trim()) ?? null) : null;
    if (target && target.observedId !== speaker.peerId) target = null;
    let action = f.action;
    if (action !== "add" && !target) action = "add";
    let confidence = Number.isFinite(f.confidence) ? f.confidence : 0.8;
    if (confidence > 1) confidence /= 100;
    const prepared: PreparedFact = {
      aboutId: speaker.peerId,
      content,
      level: f.level === "deductive" ? "deductive" : "explicit",
      category: f.category,
      confidence: clamp(confidence, 0, 1),
      importance: clamp(Math.round(Number.isFinite(f.importance) ? f.importance : 3), 1, 5) / 5,
      messageIds: sources.map((m) => m.id),
      validFrom,
      event,
      tags,
      observers,
      action,
      target: action === "add" ? null : target,
    };
    const dupKey = `${speaker.peerId}|${normKey(content)}`;
    const prior = seen.get(dupKey);
    if (prior) {
      prior.messageIds = [...new Set([...prior.messageIds, ...prepared.messageIds])];
      prior.observers = [...new Set([...prior.observers, ...prepared.observers])];
      prior.confidence = Math.max(prior.confidence, prepared.confidence);
      continue;
    }
    seen.set(dupKey, prepared);
    out.push(prepared);
  }
  return out;
}

export interface CollectionRow {
  id: string;
  observer_id: string;
  observed_id: string;
  peer_card: string[];
  card_dates: Record<string, string> | null;
}

const pair = (observer: string, observed: string) => `${observer}|${observed}`;

/** Get-or-create the collections for (observer, observed) pairs. */
export async function ensureCollections(
  tx: Tx,
  workspaceId: string,
  pairs: { observer: string; observed: string }[],
): Promise<Map<string, CollectionRow>> {
  const unique = [...new Map(pairs.map((p) => [pair(p.observer, p.observed), p])).values()];
  const out = new Map<string, CollectionRow>();
  if (!unique.length) return out;
  const values = sql.join(
    unique.map((p) => sql`(${newId()}, ${workspaceId}, ${p.observer}, ${p.observed})`),
    sql`, `,
  );
  await tx.execute(
    sql`INSERT INTO collections (id, workspace_id, observer_id, observed_id) VALUES ${values}
        ON CONFLICT (observer_id, observed_id) DO NOTHING`,
  );
  const found = await rows<CollectionRow>(
    tx,
    sql`SELECT id, observer_id, observed_id, peer_card, card_dates FROM collections
        WHERE observer_id = ANY(${textArray(unique.map((p) => p.observer))})
          AND observed_id = ANY(${textArray(unique.map((p) => p.observed))})`,
  );
  for (const c of found) out.set(pair(c.observer_id, c.observed_id), c);
  return out;
}

/**
 * Serialises writers of the same collections (reason jobs of different
 * sessions, dreams) for the rest of the transaction. Sorted, so two writers
 * can never wait on each other in a cycle.
 */
export async function lockCollections(tx: Tx, ids: string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`collection:${id}`}))`);
  }
}

export interface ApplyStats {
  inserted: number;
  reinforced: number;
  superseded: number;
  cardsUpdated: number;
  /** Collections whose facts or card changed. */
  touched: Map<string, { observerId: string; observedId: string; inserted: number }>;
}

/** A stored fact as the update logic needs it: identity, when it holds and its event time. */
interface Known extends Timed {
  id: string;
  key: string;
  /** Set by a person: never closed by what the reasoner learns. */
  pinned: boolean;
}
interface KnownRow {
  id: string;
  key: string;
  since: Date | string;
  category: string | null;
  event_start: Date | string | null;
  event_end: Date | string | null;
  event_precision: EventTime["precision"] | null;
  pinned: boolean | null;
}
const KNOWN_TIME_COLS = sql`category, event_start, event_end, event_precision, pinned`;
const knownOf = (r: KnownRow): Known => ({
  id: r.id,
  key: r.key,
  category: r.category,
  validFrom: new Date(r.since),
  event: eventOf(r),
  pinned: r.pinned === true,
});

interface Op {
  fact: PreparedFact;
  vector: number[] | null;
  collection: CollectionRow;
}

/**
 * Files prepared facts into every observer's collection, in the caller's
 * transaction: reinforce bumps `times_derived`, supersede closes the old row's
 * validity and links it to the new one, and a nearest-neighbour check turns
 * near-verbatim "new" facts into reinforcements.
 */
export async function applyFacts(
  tx: Tx,
  args: {
    workspaceId: string;
    sessionId: string;
    embeddingModel: string;
    facts: PreparedFact[];
    vectors: (number[] | null)[];
    cardEdits: ExtractionOut["cards"];
    speakers: Map<string, WindowSpeaker>;
    cardsEnabled: boolean;
  },
): Promise<ApplyStats> {
  const stats: ApplyStats = {
    inserted: 0,
    reinforced: 0,
    superseded: 0,
    cardsUpdated: 0,
    touched: new Map(),
  };
  const cardEdits = args.cardsEnabled
    ? args.cardEdits
        .map((e) => ({ ...e, speaker: args.speakers.get(e.peer.trim().toLowerCase()) }))
        .filter((e) => e.speaker && (e.add.length || e.remove.length))
    : [];
  const pairs = [
    ...args.facts.flatMap((f) => f.observers.map((o) => ({ observer: o, observed: f.aboutId }))),
    ...cardEdits.flatMap((e) =>
      [...e.speaker!.observers].map((o) => ({ observer: o, observed: e.speaker!.peerId })),
    ),
  ];
  const collections = await ensureCollections(tx, args.workspaceId, pairs);
  await lockCollections(
    tx,
    [...collections.values()].map((c) => c.id),
  );
  // Cards as they are now that this transaction holds the collections (a dream may have just
  // written one).
  if (cardEdits.length && collections.size) {
    const fresh = await rows<{ id: string; peer_card: string[]; card_dates: Obj | null }>(
      tx,
      sql`SELECT id, peer_card, card_dates FROM collections
          WHERE id = ANY(${textArray([...collections.values()].map((c) => c.id))})`,
    );
    const byId = new Map(fresh.map((r) => [r.id, r]));
    for (const c of collections.values()) {
      const r = byId.get(c.id);
      if (r) Object.assign(c, { peer_card: r.peer_card, card_dates: r.card_dates });
    }
  }
  const touch = (c: CollectionRow, inserted = 0) => {
    const t = stats.touched.get(c.id) ?? {
      observerId: c.observer_id,
      observedId: c.observed_id,
      inserted: 0,
    };
    t.inserted += inserted;
    stats.touched.set(c.id, t);
  };

  const ops: Op[] = [];
  args.facts.forEach((fact, i) => {
    for (const o of fact.observers) {
      const collection = collections.get(pair(o, fact.aboutId));
      if (collection) ops.push({ fact, vector: args.vectors[i] ?? null, collection });
    }
  });

  // Each observer holds its own copy of a fact; copies share internal.key.
  const targetKeys = [...new Set(args.facts.flatMap((f) => (f.target ? [f.target.key] : [])))];
  const copies = new Map<string, Known>();
  if (targetKeys.length) {
    const found = await rows<KnownRow & { collection_id: string }>(
      tx,
      sql`SELECT id, collection_id, COALESCE(internal->>'key', id) AS key,
                 COALESCE(valid_from, created_at) AS since, ${KNOWN_TIME_COLS} FROM conclusions
          WHERE deleted_at IS NULL AND valid_to IS NULL
            AND (id = ANY(${textArray(targetKeys)}) OR internal->>'key' = ANY(${textArray(targetKeys)}))`,
    );
    for (const r of found) copies.set(`${r.collection_id}|${r.key}`, knownOf(r));
  }

  // The same text already current in the collection (also without embeddings): never a second copy.
  // Several current facts can share a text when each is a different dated occurrence.
  const verbatim = new Map<string, { id: string; key: string; event: EventTime | null }[]>();
  if (ops.length) {
    for (const r of await sameText(
      tx,
      [...new Set(ops.map((o) => o.collection.id))],
      ops.map((o) => o.fact.content),
    )) {
      const k = `${r.collection_id}|${r.raw}`;
      verbatim.set(k, [...(verbatim.get(k) ?? []), { id: r.id, key: r.key, event: eventOf(r) }]);
    }
  }

  // Nearest current fact per (fact, collection), exact scan within the collection.
  const nearest = new Map<number, Known & { d: number }>();
  const probes = ops.map((op, i) => ({ op, i })).filter(({ op }) => op.vector);
  if (probes.length) {
    const values = sql.join(
      probes.map(({ op, i }) => sql`(${i}::int, ${op.collection.id}, ${vec(op.vector!)})`),
      sql`, `,
    );
    const found = await rows<KnownRow & { i: number; d: number }>(
      tx,
      sql`SELECT q.i, x.* FROM (VALUES ${values}) AS q(i, coll, v)
          CROSS JOIN LATERAL (
            SELECT c.id, COALESCE(c.internal->>'key', c.id) AS key, COALESCE(c.valid_from, c.created_at) AS since,
                   ${KNOWN_TIME_COLS}, (c.embedding <=> q.v) + 0 AS d
            FROM conclusions c
            WHERE c.collection_id = q.coll AND c.deleted_at IS NULL AND c.valid_to IS NULL AND c.embedding IS NOT NULL
            ORDER BY d LIMIT 1) x`,
    );
    for (const r of found) nearest.set(Number(r.i), { ...knownOf(r), d: Number(r.d) });
  }

  interface NewRow {
    id: string;
    op: Op;
    key: string;
    validTo: Date | null;
    supersededBy: string | null;
    /** The event end it takes when it is stored already replaced (see endedBy). */
    eventEnd: Date | null;
    /** The fact it replaces, or the pinned fact it disagrees with. */
    replaces: string | null;
    conflictWith: string | null;
  }
  const newRows: NewRow[] = [];
  // The change log of this batch, written once the new facts exist.
  const events: MemoryEvent[] = [];
  const logged = (op: Op, e: Omit<MemoryEvent, "workspaceId" | "collectionId" | "actor">) =>
    events.push({
      workspaceId: args.workspaceId,
      collectionId: op.collection.id,
      actor: "reasoner",
      ...e,
    });
  const reinforce = async (id: string, f: PreparedFact, op: Op) => {
    logged(op, {
      conclusionId: id,
      action: "reinforced",
      sources: f.messageIds,
      reason: "said again",
    });
    await tx.execute(
      sql`UPDATE conclusions SET times_derived = times_derived + 1,
            message_ids = ARRAY(SELECT DISTINCT unnest(message_ids || ${textArray(f.messageIds)})),
            tags = (SELECT COALESCE((array_agg(t ORDER BY o))[1:8], '{}') FROM (SELECT DISTINCT ON (t) t, o
              FROM unnest(tags || ${textArray(f.tags)}) WITH ORDINALITY AS x(t, o) ORDER BY t, o) y),
            confidence = GREATEST(confidence, ${f.confidence}), importance = GREATEST(importance, ${f.importance}),
            updated_at = now()
          WHERE id = ${id}`,
    );
    stats.reinforced++;
  };
  const factKeys = new Map<PreparedFact, string>();
  const insert = (op: Op, key: string): NewRow => {
    const row: NewRow = {
      id: newId(),
      op,
      key,
      validTo: null,
      supersededBy: null,
      eventEnd: null,
      replaces: null,
      conflictWith: null,
    };
    newRows.push(row);
    stats.inserted++;
    touch(op.collection, 1);
    return row;
  };
  // Latest replacement per (collection, superseded fact): a second update of
  // the same fact in one batch supersedes the first ("moved to A", then "to B").
  const replacements = new Map<string, NewRow>();

  for (const [i, op] of ops.entries()) {
    const f = op.fact;
    const copy = f.target ? copies.get(`${op.collection.id}|${f.target.key}`) : undefined;
    const probe = nearest.get(i);
    const sameList = verbatim.get(`${op.collection.id}|${f.content}`) ?? [];
    const same = sameList.find((x) => !distinctOccurrences(f.event, x.event)) ?? sameList[0];
    const near =
      same &&
      !(probe && probe.d <= DUPLICATE_DISTANCE && !distinctOccurrences(f.event, probe.event))
        ? { ...same, d: 0, pinned: false }
        : probe;
    // A near-identical fact about another occurrence (a second gym visit, another trip) is new.
    const isDuplicate =
      near && near.d <= DUPLICATE_DISTANCE && !distinctOccurrences(f.event, near.event ?? null);
    // The target may be gone from this collection (superseded or merged meanwhile,
    // or this observer joined later): then it is new information, checked for duplicates.
    let action = f.action !== "add" && !copy ? "add" : f.action;
    // Dated occurrences that do not overlap never restate or replace each other.
    if (
      copy &&
      distinctOccurrences(f.event, copy.event) &&
      (action === "reinforce" || (f.category === "event" && copy.category === "event"))
    )
      action = "add";
    if (action === "reinforce" || (action === "add" && isDuplicate)) {
      const existing = action === "reinforce" ? copy : near;
      if (existing) await reinforce(existing.id, f, op);
      touch(op.collection);
      continue;
    }
    if (action === "supersede" && copy) {
      const chainKey = `${op.collection.id}|${copy.key}`;
      const earlier = replacements.get(chainKey);
      if (isDuplicate && near.key === copy.key) {
        // "Superseded" by the same statement: it is a restatement.
        await reinforce(copy.id, f, op);
        touch(op.collection);
        continue;
      }
      if (laterState(copy, f)) {
        // The known fact describes a later state than this one (an older session learned late,
        // or a move reported after the fact): this is the earlier state. It is kept as history,
        // closed where the known fact begins, and the known fact stays current.
        if (isDuplicate) await reinforce(near.id, f, op);
        else {
          const row = insert(op, factKeys.get(f) ?? newKey(factKeys, f));
          row.validTo = closedAt(f, copy);
          row.eventEnd = endedBy(f, copy);
          row.supersededBy = copy.id;
          stats.superseded++;
        }
        touch(op.collection);
        continue;
      }
      if (copy.pinned) {
        // A person set the known fact: it stays as it is. The new statement is kept next to it
        // and the disagreement is flagged for review.
        if (isDuplicate) await reinforce(near.id, f, op);
        else {
          const row = insert(op, factKeys.get(f) ?? newKey(factKeys, f));
          row.conflictWith = copy.id;
          logged(op, {
            conclusionId: copy.id,
            action: "conflict",
            sources: [row.id, ...f.messageIds],
            reason: "a newer statement disagrees with this pinned fact",
            after: { content: f.content },
          });
        }
        touch(op.collection);
        continue;
      }
      if (earlier && !isDuplicate) {
        const row = insert(op, factKeys.get(f) ?? newKey(factKeys, f));
        const [older, newer] = laterState(earlier.op.fact, f) ? [row, earlier] : [earlier, row];
        older.validTo = closedAt(older.op.fact, newer.op.fact);
        older.eventEnd = endedBy(older.op.fact, newer.op.fact);
        older.supersededBy = newer.id;
        newer.replaces = older.id;
        replacements.set(chainKey, newer);
        stats.superseded++;
        continue;
      }
      let replacement: string;
      if (isDuplicate) {
        // The new state is already stored (e.g. learned in another batch): link to it.
        await reinforce(near.id, f, op);
        replacement = near.id;
      } else {
        const row = insert(op, factKeys.get(f) ?? newKey(factKeys, f));
        row.replaces = copy.id;
        replacements.set(chainKey, row);
        replacement = row.id;
      }
      const closed = await rows<{ valid_to: Date | string }>(
        tx,
        sql`UPDATE conclusions SET valid_to = GREATEST(COALESCE(valid_from, created_at), ${stateStart(f)}::timestamptz),
              event_end = COALESCE(event_end, ${endedBy(copy, f)}::timestamptz),
              superseded_by = ${replacement}, updated_at = now()
            WHERE id = ${copy.id} AND valid_to IS NULL AND NOT pinned RETURNING valid_to`,
      );
      if (closed[0])
        logged(op, {
          conclusionId: copy.id,
          action: "superseded",
          sources: [replacement, ...f.messageIds],
          reason: "replaced by a newer statement",
          after: {
            superseded_by: replacement,
            valid_to: new Date(closed[0].valid_to).toISOString(),
          },
        });
      stats.superseded++;
      touch(op.collection);
      continue;
    }
    // A restated fact this observer lacks keeps the key of the other observers' copies.
    const key =
      f.action === "reinforce" && f.target
        ? f.target.key
        : (factKeys.get(f) ?? newKey(factKeys, f));
    insert(op, key);
  }

  if (newRows.length) {
    const values = newRows.map(({ id, op, key, validTo, supersededBy, eventEnd, conflictWith }) => {
      const f = op.fact;
      return sql`(${id}, ${args.workspaceId}, ${op.collection.id}, ${op.collection.observer_id}, ${f.aboutId},
        ${args.sessionId}, ${f.content}, ${f.level}, ${f.category}, ${f.confidence}::real, ${f.importance}::real,
        ${textArray(f.messageIds)}, ${f.validFrom}::timestamptz, ${validTo}::timestamptz, ${supersededBy},
        ${f.event?.start ?? null}::timestamptz, ${eventEnd ?? f.event?.end ?? null}::timestamptz,
        ${f.event?.precision ?? null}, ${textArray(f.tags)},
        ${op.vector ? vec(op.vector) : sql`NULL::vector`}, ${op.vector ? args.embeddingModel : null},
        ${JSON.stringify(conflictWith ? { key, conflict_with: conflictWith } : { key })}::jsonb)`;
    });
    await tx.execute(
      sql`INSERT INTO conclusions (id, workspace_id, collection_id, observer_id, observed_id, session_id, content, level,
            category, confidence, importance, message_ids, valid_from, valid_to, superseded_by, event_start,
            event_end, event_precision, tags, embedding, embedding_model, internal)
          VALUES ${sql.join(values, sql`, `)}`,
    );
    for (const r of newRows)
      events.push({
        workspaceId: args.workspaceId,
        collectionId: r.op.collection.id,
        conclusionId: r.id,
        action: "created",
        actor: "reasoner",
        sources: r.op.fact.messageIds,
        reason: r.supersededBy
          ? "learned late: an earlier state, already replaced"
          : r.conflictWith
            ? "disagrees with a pinned fact"
            : r.replaces
              ? "replaces an earlier statement"
              : "learned from messages",
        after:
          r.replaces || r.conflictWith
            ? { replaces: r.replaces, conflict_with: r.conflictWith }
            : undefined,
      });
  }

  // Card edits are dated with the speaker's newest message in the window: an entry set from
  // later messages is never replaced or removed by them, and a value that only closed facts
  // hold (a former address, a tool given up) never comes back.
  for (const e of cardEdits) {
    const at = e.speaker!.lastAt ?? null;
    for (const o of e.speaker!.observers) {
      const c = collections.get(pair(o, e.speaker!.peerId));
      if (!c) continue;
      const stale = await supersededValues(tx, c.id, e.add);
      const dates = { ...(c.card_dates ?? {}) };
      const before = Array.isArray(c.peer_card) ? c.peer_card : [];
      const { card, changed, datesChanged } = applyCardEdits(
        before,
        e.add.filter((a) => !stale.has(a)),
        e.remove,
        { asOf: () => at, dates },
      );
      if (!changed && !datesChanged) continue;
      if (changed) {
        const diff = cardDiff(before, card);
        events.push({
          workspaceId: args.workspaceId,
          collectionId: c.id,
          conclusionId: null,
          action: "card",
          actor: "reasoner",
          reason: "learned from messages",
          before: diff.removed,
          after: diff.added,
        });
      }
      await tx.execute(
        sql`UPDATE collections SET peer_card = ${JSON.stringify(card)}::jsonb, card_dates = ${JSON.stringify(dates)}::jsonb,
              card_updated_at = ${changed ? sql`now()` : sql`card_updated_at`}
            WHERE id = ${c.id}`,
      );
      c.peer_card = card;
      c.card_dates = dates;
      if (!changed) continue;
      stats.cardsUpdated++;
      touch(c);
    }
  }

  await recordEvents(tx, events);

  if (stats.touched.size) {
    const values = sql.join(
      [...stats.touched].map(([id, t]) => sql`(${id}, ${t.inserted}::int)`),
      sql`, `,
    );
    await tx.execute(
      sql`UPDATE collections c SET version = c.version + 1, new_since_dream = c.new_since_dream + v.n
          FROM (VALUES ${values}) AS v(id, n) WHERE c.id = v.id`,
    );
  }
  return stats;
}

function newKey(keys: Map<PreparedFact, string>, f: PreparedFact): string {
  const key = newId();
  keys.set(f, key);
  return key;
}

/**
 * Text compared case-insensitively with runs of whitespace as one space (SQL). Every writer of
 * facts (the reasoner, POST /conclusions, the scope backfill) uses it to tell an identical fact.
 */
export const NORMALIZED = (col: SQL) => sql`lower(btrim(regexp_replace(${col}, '\\s+', ' ', 'g')))`;

/**
 * Current facts in the collections whose text equals one of `texts` (ignoring case and spacing),
 * so an identical fact is reinforced rather than stored twice even without embeddings.
 * Callers hold the collections' locks (`lockCollections`), so no other writer adds one meanwhile.
 */
export async function sameText(
  tx: Tx,
  collectionIds: string[],
  texts: string[],
): Promise<
  {
    raw: string;
    id: string;
    collection_id: string;
    key: string;
    event_start: Date | string | null;
    event_end: Date | string | null;
    event_precision: EventTime["precision"] | null;
  }[]
> {
  if (!collectionIds.length || !texts.length) return [];
  return rows(
    tx,
    sql`SELECT q.raw, c.id, c.collection_id, COALESCE(c.internal->>'key', c.id) AS key, c.event_start, c.event_end,
               c.event_precision
        FROM unnest(${textArray([...new Set(texts)])}) AS q(raw)
        JOIN conclusions c ON c.collection_id = ANY(${textArray(collectionIds)})
          AND c.deleted_at IS NULL AND c.valid_to IS NULL
          AND ${NORMALIZED(sql`c.content`)} = ${NORMALIZED(sql`q.raw`)}
        ORDER BY c.created_at, c.id`,
  );
}

/**
 * Card entries whose value only facts that no longer hold mention: every value word appears in
 * a closed (superseded) fact of the collection, and no current fact has them all. Such an entry
 * would put a former address, employer or tool back on the card.
 */
export async function supersededValues(
  tx: Tx,
  collectionId: string,
  entries: string[],
): Promise<Set<string>> {
  const probes = entries
    .map((entry, i) => ({ entry, i, terms: cardValueTerms(entry) }))
    .filter((p) => p.terms.length);
  if (!probes.length) return new Set();
  const values = sql.join(
    probes.map(
      (p) => sql`(${p.i}::int, ${textArray(p.terms.map((t) => `\\m${escapeRegex(t)}\\M`))})`,
    ),
    sql`, `,
  );
  const found = await rows<{ i: number; current: boolean; past: boolean }>(
    tx,
    sql`SELECT v.i, bool_or(c.valid_to IS NULL) AS current, bool_or(c.valid_to IS NOT NULL) AS past
        FROM (VALUES ${values}) AS v(i, pats)
        JOIN conclusions c ON c.collection_id = ${collectionId} AND c.deleted_at IS NULL
          AND c.content ~* ALL (v.pats)
        GROUP BY v.i`,
  );
  const stale = new Set<string>();
  for (const r of found) {
    if (r.past && !r.current) stale.add(probes.find((p) => p.i === Number(r.i))!.entry);
  }
  return stale;
}

const escapeRegex = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
