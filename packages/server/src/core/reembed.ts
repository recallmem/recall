import { sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { rows } from "../db/client.js";
import { vec } from "../reasoner/util.js";

/** Rows re-embedded per table per sweep: one embedding call each. */
const BATCH = 64;
/** After a sweep finds nothing stale, the next looks again this much later (per process). */
const IDLE_MS = 6 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60_000;

/** The tables with vectors, and the text each row's vector is made from. */
const TABLES = [
  { name: "conclusions", live: sql`AND deleted_at IS NULL` },
  { name: "messages", live: sql`` },
] as const;

let idleUntil = 0;

/**
 * Re-embeds stored messages and facts whose vectors another embedding model made, a batch per
 * table each call. Vectors of two models cannot be compared, so after a model change those rows
 * are found by text search only until this has caught up. The work is the operator's: it is
 * metered without a workspace and never charged to an account. Returns the rows updated.
 */
export async function reembedStale(ctx: AppContext): Promise<number> {
  if (Date.now() < idleUntil) return 0;
  const ref = ctx.embeddings.ref;
  let updated = 0;
  for (const table of TABLES) {
    const stale = await rows<{ id: string; content: string }>(
      ctx.db,
      sql`SELECT id, content FROM ${sql.raw(table.name)}
          WHERE embedding IS NOT NULL AND embedding_model IS DISTINCT FROM ${ref}
            AND content <> '' ${table.live}
          LIMIT ${BATCH}`,
    );
    if (!stale.length) continue;
    const vectors = await ctx.embeddings.embed(
      stale.map((r) => r.content),
      null,
    );
    const values = sql.join(
      stale.map((r, i) => sql`(${r.id}, ${vec(vectors[i]!)})`),
      sql`, `,
    );
    // Rows rewritten since they were read keep their newer vector.
    await ctx.db.execute(
      sql`UPDATE ${sql.raw(table.name)} t SET embedding = v.e, embedding_model = ${ref}
          FROM (VALUES ${values}) AS v(id, e)
          WHERE t.id = v.id AND t.embedding_model IS DISTINCT FROM ${ref}`,
    );
    updated += stale.length;
  }
  if (!updated) idleUntil = Date.now() + IDLE_MS;
  return updated;
}

/** Runs the re-embedding sweep every minute (worker processes); returns a stop function. */
export function startReembedding(ctx: AppContext): () => Promise<void> {
  const check = () =>
    void reembedStale(ctx).catch((err) => ctx.log.error({ err }, "re-embedding sweep failed"));
  const timer = setInterval(check, CHECK_EVERY_MS);
  timer.unref?.();
  check();
  return async () => clearInterval(timer);
}

/** For tests: forget that the last sweep found nothing. */
export function resetReembedIdle(): void {
  idleUntil = 0;
}
