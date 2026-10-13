import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { migrate, openDatabase, rows } from "../src/db/client.js";

const targets: Record<string, Record<string, string>> = { pglite: { RECALL_DATA_DIR: "memory" } };
if (process.env.RECALL_TEST_DATABASE_URL) {
  targets.postgres = { RECALL_DATABASE_URL: process.env.RECALL_TEST_DATABASE_URL };
}

describe.each(Object.entries(targets))("migrations on %s", (_name, env) => {
  it("apply once, are idempotent, and support vector + full-text queries", async () => {
    // On Postgres, a private schema: dropping `public` would break test files running concurrently.
    const schema = `d_${Math.random().toString(36).slice(2, 10)}`;
    let scopedEnv = env;
    if (env.RECALL_DATABASE_URL) {
      const scoped = new URL(env.RECALL_DATABASE_URL);
      scoped.searchParams.set("options", `-c search_path=${schema},public`);
      scopedEnv = { RECALL_DATABASE_URL: scoped.toString() };
    }
    const config = loadConfig(scopedEnv);
    const { db, kind, close } = await openDatabase(config);
    try {
      if (kind === "postgres") {
        await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS vector SCHEMA public"));
        await db.execute(sql.raw(`CREATE SCHEMA ${schema}`));
      }
      const applied = await migrate(db, config.embedding.dimensions);
      expect(applied[0]).toBe("0001_init.sql");
      expect(applied).toEqual([...applied].sort());
      expect(await migrate(db, config.embedding.dimensions)).toEqual([]);
      const [r] = await rows<{ d: number; rank: number }>(
        db,
        sql`SELECT ('[1,0,0]'::vector <=> '[1,0,0]'::vector) AS d,
                   ts_rank_cd(to_tsvector('simple', 'Alice houdt van wandelen'), websearch_to_tsquery('simple', 'wandelen')) AS rank`,
      );
      expect(r!.d).toBe(0);
      expect(r!.rank).toBeGreaterThan(0);
    } finally {
      if (kind === "postgres") await db.execute(sql.raw(`DROP SCHEMA ${schema} CASCADE`));
      await close();
    }
  });
});
