import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rows } from "../src/db/client.js";
import { enqueue } from "../src/queue/enqueue.js";
import { Worker } from "../src/queue/worker.js";
import { ADMIN, createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * Hosted mode: an account may have only RECALL_QUEUE_MAX_RUNNING_PER_ACCOUNT jobs running at
 * once, so a backlog in one account cannot hold up every other account's background work.
 */

let s: HostedServer;
const op = { authorization: `Bearer ${ADMIN}` };

async function accountWorkspace(name: string): Promise<string> {
  const account = await (await s.api("POST", "/admin/v1/accounts", { name }, op)).json();
  const key = await (
    await s.api("POST", `/admin/v1/accounts/${account.id}/keys`, { mode: "live" }, op)
  ).json();
  const created = await s.api(
    "POST",
    "/v3/workspaces",
    { id: "main" },
    { authorization: `Bearer ${key.key}` },
  );
  expect(created.status).toBe(201);
  const [ws] = await rows<{ id: string }>(
    s.ctx.db,
    sql`SELECT id FROM workspaces WHERE account_id = ${account.id} AND name = 'main'`,
  );
  return ws!.id;
}

beforeAll(async () => {
  s = await createHostedServer({
    billing: false,
    env: { RECALL_QUEUE_MAX_RUNNING_PER_ACCOUNT: "2" },
  });
});
afterAll(async () => {
  await s.close();
});

describe("queue fairness between accounts", () => {
  it("claims another account's job once one account has its share running", async () => {
    const busy = await accountWorkspace("Busy");
    const quiet = await accountWorkspace("Quiet");
    for (let i = 0; i < 5; i++)
      await enqueue(s.ctx.db, { kind: "embed", workKey: `busy-${i}`, workspaceId: busy });
    await enqueue(s.ctx.db, { kind: "embed", workKey: "quiet-0", workspaceId: quiet });

    const w = new Worker(s.ctx);
    const claimed = [await w.claim(), await w.claim(), await w.claim()];
    expect(claimed.map((j) => j?.workKey)).toEqual(["busy-0", "busy-1", "quiet-0"]);
    // The busy account is at its share and the quiet one has nothing left: nothing to claim.
    expect(await w.claim()).toBeNull();
    // A finished job frees a slot for the busy account again.
    await s.ctx.db.execute(sql`UPDATE jobs SET status = 'done' WHERE work_key = 'busy-0'`);
    expect((await w.claim())?.workKey).toBe("busy-2");
  });
});
