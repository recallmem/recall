import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { rows } from "../db/client.js";
import { newId } from "../lib/ids.js";
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
  observers: string[];
  action: "add" | "reinforce" | "supersede";
  target: KnownRef | null;
}

/**
 * Validates the model's facts against the transcript: the subject must have
 * written one of the cited messages (or, when none are cited validly, any
 * target message in the window), observers come from those messages, and
 * reinforce/supersede targets must be known facts about the same peer.
 * Duplicates within the batch are merged.
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
    let own = cited.filter((m) => m.target && m.peerId === speaker.peerId);
    if (!own.length && !cited.some((m) => m.peerId === speaker.peerId)) {
      // Nothing valid cited: fall back to the speaker's target messages in the window.
      own = [...transcript.values()].filter((m) => m.target && m.peerId === speaker.peerId);
    }
    if (!own.length) continue;
    const sources = [...new Map([...cited, ...own].map((m) => [m.id, m])).values()];
    const observers = [...new Set(own.flatMap((m) => m.observers))];
    const validFrom = new Date(Math.max(...own.map((m) => m.createdAt.getTime())));
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
  const copies = new Map<string, { id: string; key: string; since: Date }>();
  if (targetKeys.length) {
    const found = await rows<{
      id: string;
      collection_id: string;
      key: string;
      since: Date | string;
    }>(
      tx,
      sql`SELECT id, collection_id, COALESCE(internal->>'key', id) AS key,
                 COALESCE(valid_from, created_at) AS since FROM conclusions
          WHERE deleted_at IS NULL AND valid_to IS NULL
            AND (id = ANY(${textArray(targetKeys)}) OR internal->>'key' = ANY(${textArray(targetKeys)}))`,
    );
    for (const r of found)
      copies.set(`${r.collection_id}|${r.key}`, { id: r.id, key: r.key, since: new Date(r.since) });
  }

  // The same text already current in the collection (also without embeddings): never a second copy.
  const verbatim = new Map<string, { id: string; key: string }>();
  if (ops.length) {
    for (const r of await sameText(
      tx,
      [...new Set(ops.map((o) => o.collection.id))],
      ops.map((o) => o.fact.content),
    ))
      verbatim.set(`${r.collection_id}|${r.raw}`, { id: r.id, key: r.key });
  }

  // Nearest current fact per (fact, collection), exact scan within the collection.
  const nearest = new Map<number, { id: string; key: string; d: number }>();
  const probes = ops.map((op, i) => ({ op, i })).filter(({ op }) => op.vector);
  if (probes.length) {
    const values = sql.join(
      probes.map(({ op, i }) => sql`(${i}::int, ${op.collection.id}, ${vec(op.vector!)})`),
      sql`, `,
    );
    const found = await rows<{ i: number; id: string; key: string; d: number }>(
      tx,
      sql`SELECT q.i, x.id, x.key, x.d FROM (VALUES ${values}) AS q(i, coll, v)
          CROSS JOIN LATERAL (
            SELECT c.id, COALESCE(c.internal->>'key', c.id) AS key, (c.embedding <=> q.v) + 0 AS d
            FROM conclusions c
            WHERE c.collection_id = q.coll AND c.deleted_at IS NULL AND c.valid_to IS NULL AND c.embedding IS NOT NULL
            ORDER BY 3 LIMIT 1) x`,
    );
    for (const r of found) nearest.set(Number(r.i), { id: r.id, key: r.key, d: Number(r.d) });
  }

  interface NewRow {
    id: string;
    op: Op;
    key: string;
    validTo: Date | null;
    supersededBy: string | null;
  }
  const newRows: NewRow[] = [];
  const reinforce = async (id: string, f: PreparedFact) => {
    await tx.execute(
      sql`UPDATE conclusions SET times_derived = times_derived + 1,
            message_ids = ARRAY(SELECT DISTINCT unnest(message_ids || ${textArray(f.messageIds)})),
            confidence = GREATEST(confidence, ${f.confidence}), importance = GREATEST(importance, ${f.importance}),
            updated_at = now()
          WHERE id = ${id}`,
    );
    stats.reinforced++;
  };
  const factKeys = new Map<PreparedFact, string>();
  const insert = (op: Op, key: string): NewRow => {
    const row: NewRow = { id: newId(), op, key, validTo: null, supersededBy: null };
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
    const same = verbatim.get(`${op.collection.id}|${f.content}`);
    const near = same && !(probe && probe.d <= DUPLICATE_DISTANCE) ? { ...same, d: 0 } : probe;
    const isDuplicate = near && near.d <= DUPLICATE_DISTANCE;
    // The target may be gone from this collection (superseded or merged meanwhile,
    // or this observer joined later): then it is new information, checked for duplicates.
    const action = f.action !== "add" && !copy ? "add" : f.action;
    if (action === "reinforce" || (action === "add" && isDuplicate)) {
      const existing = action === "reinforce" ? copy : near;
      if (existing) await reinforce(existing.id, f);
      touch(op.collection);
      continue;
    }
    if (action === "supersede" && copy) {
      const chainKey = `${op.collection.id}|${copy.key}`;
      const earlier = replacements.get(chainKey);
      if (isDuplicate && near.key === copy.key) {
        // "Superseded" by the same statement: it is a restatement.
        await reinforce(copy.id, f);
        touch(op.collection);
        continue;
      }
      if (copy.since > f.validFrom) {
        // The known fact comes from later messages than this one (an older session learned
        // late): this is the earlier state. It is kept as history, closed where the known
        // fact begins, and the known fact stays current.
        if (isDuplicate) await reinforce(near.id, f);
        else {
          const row = insert(op, factKeys.get(f) ?? newKey(factKeys, f));
          row.validTo = copy.since;
          row.supersededBy = copy.id;
          stats.superseded++;
        }
        touch(op.collection);
        continue;
      }
      if (earlier && !isDuplicate) {
        const row = insert(op, factKeys.get(f) ?? newKey(factKeys, f));
        const [older, newer] =
          earlier.op.fact.validFrom <= f.validFrom ? [earlier, row] : [row, earlier];
        older.validTo = newer.op.fact.validFrom;
        older.supersededBy = newer.id;
        replacements.set(chainKey, newer);
        stats.superseded++;
        continue;
      }
      let replacement: string;
      if (isDuplicate) {
        // The new state is already stored (e.g. learned in another batch): link to it.
        await reinforce(near.id, f);
        replacement = near.id;
      } else {
        const row = insert(op, factKeys.get(f) ?? newKey(factKeys, f));
        replacements.set(chainKey, row);
        replacement = row.id;
      }
      await tx.execute(
        sql`UPDATE conclusions SET valid_to = GREATEST(COALESCE(valid_from, created_at), ${f.validFrom}::timestamptz),
              superseded_by = ${replacement}, updated_at = now()
            WHERE id = ${copy.id} AND valid_to IS NULL`,
      );
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
    const values = newRows.map(({ id, op, key, validTo, supersededBy }) => {
      const f = op.fact;
      return sql`(${id}, ${args.workspaceId}, ${op.collection.id}, ${op.collection.observer_id}, ${f.aboutId},
        ${args.sessionId}, ${f.content}, ${f.level}, ${f.category}, ${f.confidence}::real, ${f.importance}::real,
        ${textArray(f.messageIds)}, ${f.validFrom}::timestamptz, ${validTo}::timestamptz, ${supersededBy},
        ${op.vector ? vec(op.vector) : sql`NULL::vector`}, ${op.vector ? args.embeddingModel : null},
        ${JSON.stringify({ key })}::jsonb)`;
    });
    await tx.execute(
      sql`INSERT INTO conclusions (id, workspace_id, collection_id, observer_id, observed_id, session_id, content, level,
            category, confidence, importance, message_ids, valid_from, valid_to, superseded_by, embedding,
            embedding_model, internal)
          VALUES ${sql.join(values, sql`, `)}`,
    );
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
      const { card, changed, datesChanged } = applyCardEdits(
        Array.isArray(c.peer_card) ? c.peer_card : [],
        e.add.filter((a) => !stale.has(a)),
        e.remove,
        { asOf: () => at, dates },
      );
      if (!changed && !datesChanged) continue;
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
): Promise<{ raw: string; id: string; collection_id: string; key: string }[]> {
  if (!collectionIds.length || !texts.length) return [];
  return rows(
    tx,
    sql`SELECT q.raw, c.id, c.collection_id, COALESCE(c.internal->>'key', c.id) AS key
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
