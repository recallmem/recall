import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getBillingRow, ledgerDrift } from "../src/billing/ledger.js";
import { rows } from "../src/db/client.js";
import { LlmError } from "../src/llm/types.js";
import { ADMIN, Browser, createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * Chat billing holds under abuse: the price is reserved before the model runs, so concurrent
 * requests cannot spend credit that is not there; an Idempotency-Key runs and charges one answer
 * (a retry replays it free, a duplicate while it runs is a 409); a request that produces no answer
 * (model error, empty memory) costs nothing; a client that hangs up mid-stream still pays for the
 * answer it started, and with a key gets all of it on a retry.
 */

let s: HostedServer;
let accountId: string;
let auth: Record<string, string>;
/** A second API key of the same account. */
let auth2: Record<string, string>;
const op = { authorization: `Bearer ${ADMIN}` };
const LOW = 5_000;

const balance = async () => (await getBillingRow(s.ctx.db, accountId))!.balance_micros;
const chats = async () =>
  rows<{ amount_micros: string; idempotency_key: string; detail: Record<string, unknown> }>(
    s.ctx.db,
    sql`SELECT amount_micros, idempotency_key, detail FROM credit_ledger
        WHERE account_id = ${accountId} AND kind LIKE 'chat\\_%' ORDER BY id`,
  );
const chat = (body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  s.api(
    "POST",
    "/v3/workspaces/main/peers/alice/chat",
    { query: "What does alice drink in the morning?", reasoning_level: "low", ...body },
    { ...auth, ...headers },
  );
let grants = 0;
/** Sets the balance to exactly `micros` with an operator grant. */
async function setBalance(micros: number) {
  if ((await balance()) === micros) return;
  const r = await s.api(
    "POST",
    `/admin/v1/accounts/${accountId}/credits`,
    { amount_usd: (micros - (await balance())) / 1_000_000, idempotency_key: `set-${++grants}` },
    op,
  );
  expect(r.status).toBe(201);
  expect(await balance()).toBe(micros);
}

beforeAll(async () => {
  s = await createHostedServer();
  const b = new Browser(s.app);
  await b.signIn(s, "chatpayer@example.com");
  const [m] = await rows<{ account_id: string }>(
    s.ctx.db,
    sql`SELECT account_id FROM account_members m JOIN users u ON u.id = m.user_id
        WHERE u.email = 'chatpayer@example.com'`,
  );
  accountId = m!.account_id;
  const key = (await b.createKey({ name: "app" })).html.match(/pk_live_[A-Za-z0-9]{32}/)![0];
  auth = { authorization: `Bearer ${key}` };
  const key2 = (await b.createKey({ name: "worker" })).html.match(/pk_live_[A-Za-z0-9]{32}/)![0];
  auth2 = { authorization: `Bearer ${key2}` };
  await s.api("POST", "/v3/workspaces", { id: "main" }, auth);
  await s.api("POST", "/v3/workspaces/main/peers", { id: "alice" }, auth);
  await s.api("POST", "/v3/workspaces/main/peers", { id: "nobody" }, auth);
  await s.api(
    "POST",
    "/v3/workspaces/main/conclusions",
    {
      conclusions: [
        {
          content: "alice drinks oolong tea every morning",
          observer_id: "alice",
          observed_id: "alice",
        },
      ],
    },
    auth,
  );
}, 60_000);
afterAll(async () => {
  await s.close();
});

describe("chat billing", () => {
  it("never lets concurrent chats spend credit that is not there", async () => {
    await setBalance(16_000);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => chat({ query: `What does alice drink? (${i})` })),
    );
    const ok = results.filter((r) => r.status === 200).length;
    const refused = results.filter((r) => r.status === 402).length;
    // $0.016 buys three answers at $0.005; the rest are refused, and the balance stays positive.
    expect(ok).toBe(3);
    expect(refused).toBe(9);
    expect(await balance()).toBe(16_000 - 3 * LOW);
    expect(await ledgerDrift(s.ctx.db, accountId)).toBe(0);
  });

  it("charges one answer per Idempotency-Key: duplicates while it runs are 409, retries replay it free", async () => {
    await setBalance(1_000_000);
    // Hold the first answer in the model call, so the duplicates arrive while it runs.
    let entered!: () => void;
    let open!: () => void;
    const waiting = new Promise<void>((r) => {
      entered = r;
    });
    const opened = new Promise<void>((r) => {
      open = r;
    });
    const complete = s.ctx.llm.complete.bind(s.ctx.llm);
    const held = vi.spyOn(s.ctx.llm, "complete").mockImplementation(async (req) => {
      entered();
      await opened;
      return complete(req);
    });
    const first = chat({}, { "idempotency-key": "once" });
    await waiting;
    const dupes = await Promise.all(
      Array.from({ length: 4 }, () => chat({}, { "idempotency-key": "once" })),
    );
    expect(dupes.map((r) => r.status)).toEqual([409, 409, 409, 409]);
    open();
    const answered = await first;
    expect(answered.status).toBe(200);
    expect(held).toHaveBeenCalledTimes(1);
    held.mockRestore();
    expect(await balance()).toBe(1_000_000 - LOW);

    const again = await chat({}, { "idempotency-key": "once" });
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(await again.text()).toBe(await answered.text());
    // Another question under the key is refused, also free.
    const other = await chat({ query: "Where does alice live?" }, { "idempotency-key": "once" });
    expect(other.status).toBe(409);
    expect(await balance()).toBe(1_000_000 - LOW);
    expect((await chats()).filter((e) => e.idempotency_key.includes(":once:"))).toHaveLength(1);
    expect(await ledgerDrift(s.ctx.db, accountId)).toBe(0);
  });

  it("keeps each API key's Idempotency-Keys apart", async () => {
    await setBalance(1_000_000);
    const mine = await chat({ query: "What tea?" }, { "idempotency-key": "shared-name" });
    const theirs = await s.api(
      "POST",
      "/v3/workspaces/main/peers/alice/chat",
      { query: "What tea?", reasoning_level: "low" },
      { ...auth2, "idempotency-key": "shared-name" },
    );
    expect([mine.status, theirs.status]).toEqual([200, 200]);
    expect(theirs.headers.get("idempotent-replayed")).toBeNull();
    expect(await balance()).toBe(1_000_000 - 2 * LOW);
  });

  it("replays a paid answer even when the balance has run out since", async () => {
    await setBalance(1_000_000);
    const paid = await chat({ query: "What does alice drink?" }, { "idempotency-key": "paid-1" });
    expect(paid.status).toBe(200);
    await setBalance(0);
    const replay = await chat({ query: "What does alice drink?" }, { "idempotency-key": "paid-1" });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect((await chat({ query: "Anything new?" }, { "idempotency-key": "paid-2" })).status).toBe(
      402,
    );
    expect(await balance()).toBe(0);
  });

  it("gives the reservation back when the model fails, and lets the same key try again", async () => {
    await setBalance(1_000_000);
    const fail = vi
      .spyOn(s.ctx.llm, "complete")
      .mockRejectedValue(new LlmError("provider down", "provider"));
    const failed = await chat(
      { query: "What tea does alice drink?" },
      { "idempotency-key": "retry-me" },
    );
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(await balance()).toBe(1_000_000);
    fail.mockRestore();
    const retried = await chat(
      { query: "What tea does alice drink?" },
      { "idempotency-key": "retry-me" },
    );
    expect(retried.status).toBe(200);
    expect(await balance()).toBe(1_000_000 - LOW);
    const keys = (await chats())
      .map((e) => e.idempotency_key)
      .filter((k) => k.includes("retry-me"));
    expect(keys).toHaveLength(3);
    expect(keys.some((k) => k.endsWith(":released"))).toBe(true);
    expect(await ledgerDrift(s.ctx.db, accountId)).toBe(0);
  });

  it("charges nothing for an answer from empty memory (no model call), and gives its key back", async () => {
    await setBalance(1_000_000);
    const ask = () =>
      s.api(
        "POST",
        "/v3/workspaces/main/peers/nobody/chat",
        { query: "What does nobody like?", reasoning_level: "low" },
        { ...auth, "idempotency-key": "empty-memory" },
      );
    const r = await ask();
    expect(r.status).toBe(200);
    expect(await balance()).toBe(1_000_000);
    // Not kept: the same key asks again (free again while the memory is empty).
    const again = await ask();
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replayed")).toBeNull();
    expect(await balance()).toBe(1_000_000);
    expect(await ledgerDrift(s.ctx.db, accountId)).toBe(0);
  });

  it("charges a streamed answer the client hung up on", async () => {
    await setBalance(1_000_000);
    const res = await s.app.request("/v3/workspaces/main/peers/alice/chat", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ query: "What does alice drink at dawn?", stream: true }),
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(await balance()).toBe(1_000_000 - LOW);
  });

  it("finishes a paid stream the client hung up on, and replays all of it for the same key", async () => {
    await setBalance(1_000_000);
    const send = () =>
      s.app.request("/v3/workspaces/main/peers/alice/chat", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "idempotency-key": "hung-up" },
        body: JSON.stringify({ query: "What does alice drink at dusk?", stream: true }),
      });
    const res = await send();
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    const stored = async () =>
      (
        await rows<{ status: string }>(
          s.ctx.db,
          sql`SELECT status FROM idempotency_records WHERE key = 'hung-up'`,
        )
      )[0]?.status;
    for (let i = 0; i < 500 && (await stored()) !== "done"; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(await stored()).toBe("done");
    const replay = await send();
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    const body = await replay.text();
    expect(body).toContain('"done":true');
    expect(body.toLowerCase()).toContain("oolong");
    expect(await balance()).toBe(1_000_000 - LOW);
    expect(await ledgerDrift(s.ctx.db, accountId)).toBe(0);
  });

  it("refuses at zero balance before any model call", async () => {
    await setBalance(0);
    const spy = vi.spyOn(s.ctx.llm, "complete");
    const r = await chat({ query: "Anything about alice?" });
    expect(r.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(await balance()).toBe(0);
  });
});

describe("account deletion", () => {
  it("removes the answers kept for the account's Idempotency-Keys", async () => {
    const acct = await (await s.api("POST", "/admin/v1/accounts", { name: "Leaving" }, op)).json();
    const made = await (
      await s.api("POST", `/admin/v1/accounts/${acct.id}/keys`, { name: "k" }, op)
    ).json();
    const leaving = { authorization: `Bearer ${made.key}` };
    await s.api("POST", "/v3/workspaces", { id: "gone" }, leaving);
    await s.api("POST", "/v3/workspaces/gone/peers", { id: "zoe" }, leaving);
    await s.api(
      "POST",
      "/v3/workspaces/gone/conclusions",
      { conclusions: [{ content: "zoe swims daily", observer_id: "zoe", observed_id: "zoe" }] },
      leaving,
    );
    const r = await s.api(
      "POST",
      "/v3/workspaces/gone/peers/zoe/chat",
      { query: "What does zoe do?" },
      { ...leaving, "idempotency-key": "before-erasure" },
    );
    expect(r.status).toBe(200);
    const kept = (account: string) =>
      rows<{ key: string }>(
        s.ctx.db,
        sql`SELECT key FROM idempotency_records WHERE account_id = ${account}`,
      );
    expect(await kept(acct.id)).toHaveLength(1);
    const others = (await kept(accountId)).length;
    expect(others).toBeGreaterThan(0);
    expect((await s.api("DELETE", `/admin/v1/accounts/${acct.id}`, undefined, op)).status).toBe(
      204,
    );
    expect(await kept(acct.id)).toHaveLength(0);
    // Other accounts' records are untouched.
    expect(await kept(accountId)).toHaveLength(others);
  });
});
