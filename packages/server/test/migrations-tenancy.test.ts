import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { type Db, migrate, openDatabase, rows, withoutSslParams } from "../src/db/client.js";

/**
 * Accounts migration and the Supabase specifics: RLS on every table, the
 * upgrade path for existing installs, concurrent migrators, and that a role
 * other than the table owner (Supabase's anon/authenticated) can do nothing.
 */

const PG = process.env.RECALL_TEST_DATABASE_URL;
const DIR = fileURLToPath(new URL("../src/db/migrations", import.meta.url));

/** A private schema on the test Postgres (dropped by `drop`), like api-helpers does. */
async function privateSchema(url: string) {
  const schema = `m_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query("CREATE EXTENSION IF NOT EXISTS vector SCHEMA public");
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-c search_path=${schema},public`);
  return {
    schema,
    url: scoped.toString(),
    admin,
    drop: async () => {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

async function open(target: "pglite" | "postgres") {
  if (target === "pglite") {
    const config = loadConfig({ RECALL_DATA_DIR: "memory" });
    const database = await openDatabase(config);
    return { ...database, dims: config.embedding.dimensions, cleanup: async () => {} };
  }
  const priv = await privateSchema(PG!);
  const config = loadConfig({ RECALL_DATABASE_URL: priv.url });
  const database = await openDatabase(config);
  return { ...database, dims: config.embedding.dimensions, cleanup: priv.drop };
}

/** Applies only the given migration files, the way the migrator does. */
async function applyOnly(db: Db, files: string[], dims: number) {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS recall_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const file of files) {
    const body = readFileSync(`${DIR}/${file}`, "utf8").replaceAll(
      "__EMBEDDING_DIM__",
      String(dims),
    );
    for (const stmt of body.split(/;\s*\n/)) {
      if (stmt.replace(/--.*$/gm, "").trim()) await db.execute(sql.raw(stmt));
    }
    await db.execute(sql`INSERT INTO recall_migrations (name) VALUES (${file})`);
  }
}

const targets: ("pglite" | "postgres")[] = PG ? ["pglite", "postgres"] : ["pglite"];

describe.each(targets)("tenancy migrations on %s", (target) => {
  it("enable row level security on every table (Supabase Data API sees nothing)", async () => {
    const d = await open(target);
    try {
      await migrate(d.db, d.dims);
      const tables = await rows<{ relname: string; rls: boolean; forced: boolean }>(
        d.db,
        sql`SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'r' AND n.nspname = current_schema() ORDER BY c.relname`,
      );
      expect(tables.map((t) => t.relname)).toEqual(
        expect.arrayContaining([
          "accounts",
          "api_keys",
          "workspaces",
          "messages",
          "recall_migrations",
        ]),
      );
      expect(tables.filter((t) => !t.rls).map((t) => t.relname)).toEqual([]);
      // never forced: the owner (our server) is unaffected
      expect(tables.filter((t) => t.forced).map((t) => t.relname)).toEqual([]);
    } finally {
      await d.close();
      await d.cleanup();
    }
  });

  it("upgrade an existing install: workspaces and usage join the default account", async () => {
    const d = await open(target);
    try {
      const all = readdirSync(DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      await applyOnly(d.db, ["0001_init.sql", "0002_worker.sql"], d.dims);
      await d.db.execute(sql`INSERT INTO workspaces (id, name) VALUES ('w1', 'acme')`);
      await d.db.execute(
        sql`INSERT INTO llm_usage (workspace_id, task, provider, model, cost_usd) VALUES ('w1', 'reasoner', 'mock', 'm', 0.1)`,
      );
      expect(await migrate(d.db, d.dims)).toEqual(all.slice(2));
      const [ws] = await rows<{ account_id: string }>(
        d.db,
        sql`SELECT account_id FROM workspaces WHERE id = 'w1'`,
      );
      expect(ws!.account_id).toBe("default");
      const [u] = await rows<{ account_id: string }>(d.db, sql`SELECT account_id FROM llm_usage`);
      expect(u!.account_id).toBe("default");
      // names are now unique per account, not globally
      await d.db.execute(sql`INSERT INTO accounts (id, name) VALUES ('acct_x', 'x')`);
      await d.db.execute(
        sql`INSERT INTO workspaces (id, account_id, name) VALUES ('w2', 'acct_x', 'acme')`,
      );
      await expect(
        d.db.execute(
          sql`INSERT INTO workspaces (id, account_id, name) VALUES ('w3', 'acct_x', 'acme')`,
        ),
      ).rejects.toThrow();
      // a workspace insert without an account fails instead of landing in "default"
      await expect(
        d.db.execute(sql`INSERT INTO workspaces (id, name) VALUES ('w4', 'other')`),
      ).rejects.toThrow();
    } finally {
      await d.close();
      await d.cleanup();
    }
  });
});

describe.skipIf(!PG)("supabase specifics on postgres", () => {
  it("concurrent migrators (API and worker starting together) apply each migration once", async () => {
    const priv = await privateSchema(PG!);
    const configs = [0, 1, 2].map(() => loadConfig({ RECALL_DATABASE_URL: priv.url }));
    const dbs = await Promise.all(configs.map((c) => openDatabase(c)));
    try {
      const results = await Promise.all(
        dbs.map((d, i) => migrate(d.db, configs[i]!.embedding.dimensions)),
      );
      const applied = results.flat();
      const files = readdirSync(DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      expect(applied.sort()).toEqual(files);
      expect(results.filter((r) => r.length > 0)).toHaveLength(1);
      // no advisory lock is left behind on an idle pooled connection (a session-level lock
      // released on another connection would be). Other test files may be migrating right now,
      // so only idle holders count.
      const [locks] = await rows<{ n: number }>(
        dbs[0]!.db,
        sql`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE l.locktype = 'advisory' AND l.objid = 727274 AND a.state = 'idle'`,
      );
      expect(locks!.n).toBe(0);
    } finally {
      for (const d of dbs) await d.close();
      await priv.drop();
    }
  });

  it("a role that does not own the tables (Supabase anon/authenticated) can neither read nor write", async () => {
    const priv = await privateSchema(PG!);
    const role = `anon_${randomBytes(4).toString("hex")}`;
    const config = loadConfig({ RECALL_DATABASE_URL: priv.url });
    const database = await openDatabase(config);
    try {
      await migrate(database.db, config.embedding.dimensions);
      await database.db.execute(
        sql`INSERT INTO workspaces (id, account_id, name) VALUES ('w1', 'default', 'acme')`,
      );
      const c = priv.admin;
      await c.query(`CREATE ROLE ${role} NOLOGIN`);
      // what Supabase grants its API roles on the public schema
      await c.query(`GRANT USAGE ON SCHEMA ${priv.schema} TO ${role}`);
      await c.query(`GRANT ALL ON ALL TABLES IN SCHEMA ${priv.schema} TO ${role}`);
      await c.query("BEGIN");
      await c.query(`SET LOCAL search_path = ${priv.schema}, public`);
      await c.query(`SET LOCAL ROLE ${role}`);
      const seen = await c.query("SELECT count(*)::int AS n FROM workspaces");
      expect(seen.rows[0].n).toBe(0);
      const keys = await c.query("SELECT count(*)::int AS n FROM api_keys");
      expect(keys.rows[0].n).toBe(0);
      await expect(
        c.query("INSERT INTO accounts (id, name) VALUES ('evil', 'evil')"),
      ).rejects.toThrow(/row-level security/);
      await c.query("ROLLBACK");
      // the owner (our server) is unaffected
      const [own] = await rows<{ n: number }>(
        database.db,
        sql`SELECT count(*)::int AS n FROM workspaces`,
      );
      expect(own!.n).toBe(1);
    } finally {
      await database.close();
      await priv.admin.query("ROLLBACK").catch(() => {});
      await priv.drop();
      const c = new pg.Client({ connectionString: PG });
      await c.connect();
      await c.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
      await c.end();
    }
  });
});

describe("database TLS", () => {
  it("an explicit CA replaces sslmode in the URL (node-postgres would let the URL win)", () => {
    expect(withoutSslParams("postgres://u:p@h:5432/db?sslmode=require&application_name=x")).toBe(
      "postgres://u:p@h:5432/db?application_name=x",
    );
  });
});
