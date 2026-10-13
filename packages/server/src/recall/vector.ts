import { type SQL, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { rows } from "../db/client.js";

const iterative = new WeakMap<AppContext, Promise<boolean>>();

/** pgvector >= 0.8 can keep scanning an HNSW index until a filtered query has enough rows. */
function supportsIterativeScan(ctx: AppContext): Promise<boolean> {
  let known = iterative.get(ctx);
  if (!known) {
    known = ctx.db
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT '[1]'::vector`); // loads the extension so its settings exist
        const found = await rows<{ n: number }>(
          tx,
          sql`SELECT 1 AS n FROM pg_settings WHERE name = 'hnsw.iterative_scan'`,
        );
        return found.length > 0;
      })
      .catch(() => false);
    iterative.set(ctx, known);
  }
  return known;
}

/**
 * Runs a nearest-neighbour query. The HNSW indexes are global, so on a shared
 * Postgres a workspace filter is applied after the index scan; without iterative
 * scans a small tenant among big ones would get far fewer rows than asked for.
 * PGlite holds a single tenant and needs none of this.
 */
export async function vectorRows<T>(ctx: AppContext, query: SQL): Promise<T[]> {
  if (ctx.dbKind !== "postgres" || !(await supportsIterativeScan(ctx)))
    return rows<T>(ctx.db, query);
  try {
    return await ctx.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true), set_config('hnsw.ef_search', '100', true)`,
      );
      return rows<T>(tx, query);
    });
  } catch {
    return rows<T>(ctx.db, query);
  }
}
