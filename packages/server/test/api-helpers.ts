import { randomBytes } from "node:crypto";
import pg from "pg";
import { createTestServer as createBaseServer } from "./helpers.js";

/** A response whose JSON body is loosely typed, so API tests can index into it directly. */
// biome-ignore lint/suspicious/noExplicitAny: loosely typed on purpose
export type ApiResponse = Omit<Response, "json"> & { json(): Promise<any> };

export type ApiServer = Omit<Awaited<ReturnType<typeof createBaseServer>>, "request"> & {
  request: (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<ApiResponse>;
};

/**
 * Test server with a loosely typed `request`. With RECALL_TEST_DATABASE_URL
 * set, the server runs against that Postgres in a private schema (dropped on
 * close), so test files can run in parallel against one database.
 */
export async function createTestServer(env: Record<string, string> = {}): Promise<ApiServer> {
  const url = process.env.RECALL_TEST_DATABASE_URL;
  if (!url) return (await createBaseServer(env)) as ApiServer;

  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  // The extension lives in `public`, visible from every private schema.
  await admin.query("CREATE EXTENSION IF NOT EXISTS vector SCHEMA public");
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-c search_path=${schema},public`);
  const server = await createBaseServer({ ...env, RECALL_DATABASE_URL: scoped.toString() });
  const close = server.close;
  return {
    ...server,
    close: async () => {
      await close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  } as ApiServer;
}
