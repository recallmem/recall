import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type SQL, sql } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import type { Config } from "../config.js";
import * as schema from "./schema.js";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Database {
  db: Db;
  kind: "postgres" | "pglite";
  close(): Promise<void>;
}

/** Runs raw SQL and returns typed rows (both drivers return `{ rows }`). */
export async function rows<T>(db: Pick<Db, "execute">, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export async function openDatabase(config: Config): Promise<Database> {
  if (config.database.kind === "postgres") {
    const { url, poolMax, ca, statementTimeoutMs } = config.database;
    const pool = new pg.Pool(
      ca
        ? // A pinned CA (e.g. Supabase's): verify the server against it. sslmode in the URL
          // would override this object in node-postgres, so it is stripped.
          { connectionString: withoutSslParams(url), max: poolMax, ssl: { ca } }
        : { connectionString: url, max: poolMax },
    );
    // Every statement is bounded, so a crafted filter or query cannot hold a database core. Set
    // per connection rather than as a startup parameter, which some poolers refuse; the query is
    // queued ahead of any other on the new connection.
    if (statementTimeoutMs > 0)
      pool.on("connect", (client) => {
        client
          .query(`SET statement_timeout = ${Math.floor(statementTimeoutMs)}`)
          .catch(() => undefined);
      });
    const db = drizzlePg(pool, { schema }) as unknown as Db;
    return { db, kind: "postgres", close: () => pool.end() };
  }
  // Loaded only when used: serverless deployments always have a database URL.
  const [{ PGlite }, { vector }, { drizzle: drizzlePglite }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("@electric-sql/pglite-pgvector"),
    import("drizzle-orm/pglite"),
  ]);
  const dataDir = config.database.dataDir;
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const client = await PGlite.create({ ...(dataDir ? { dataDir } : {}), extensions: { vector } });
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  return { db, kind: "pglite", close: () => client.close() };
}

/** Drops libpq SSL parameters from a connection URL (used when an explicit CA is configured). */
export function withoutSslParams(url: string): string {
  try {
    const u = new URL(url);
    for (const k of ["sslmode", "sslrootcert", "sslcert", "sslkey", "ssl", "uselibpqcompat"])
      u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Applies pending SQL migrations in order. The embedding dimension is
 * substituted at apply time, so it is fixed per install.
 *
 * Everything runs in one transaction that first takes a transaction-scoped
 * advisory lock: concurrent migrators (API and worker machines starting at
 * once) queue on the lock, and the lock can neither leak onto another pooled
 * connection nor outlive the transaction. This works on a direct connection
 * and through a session-mode pooler (Supabase Supavisor on port 5432).
 */
export async function migrate(db: Db, embeddingDimensions: number): Promise<string[]> {
  return db.transaction(async (tx) => {
    // A migration may rebuild an index on a big table: not subject to the per-statement limit.
    await tx.execute(sql`SET LOCAL statement_timeout = 0`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(727274)`);
    await tx.execute(sql`CREATE TABLE IF NOT EXISTS recall_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = await rows<{ name: string }>(tx, sql`SELECT name FROM recall_migrations`);
    const applied = new Set(done.map((r) => r.name));
    const pending = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && !applied.has(f))
      .sort();
    for (const file of pending) {
      const body = readFileSync(join(MIGRATIONS_DIR, file), "utf8").replaceAll(
        "__EMBEDDING_DIM__",
        String(embeddingDimensions),
      );
      // One statement per call: PGlite's query API rejects multi-statement strings.
      // Migrations contain no function bodies, so a statement ends at ";" + newline.
      const statements = body
        .split(/;\s*\n/)
        .filter((stmt) => stmt.replace(/--.*$/gm, "").trim().length > 0);
      for (const stmt of statements) await tx.execute(sql.raw(stmt));
      await tx.execute(sql`INSERT INTO recall_migrations (name) VALUES (${file})`);
    }
    return pending;
  });
}
