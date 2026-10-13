import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rows } from "../src/db/client.js";
import { LlmError } from "../src/llm/types.js";
import { cleanupJobs } from "../src/queue/worker.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";
import { parseSse } from "./recall-helpers.js";

/**
 * Idempotency-Key on chat, on a self-hosted server (no billing): the first answer is kept and a
 * retry of the same request gets it again without asking the model; the key with another request,
 * or while the first is still running, is a 409; a request that produced no answer gives its key
 * back; streams replay as sent; keys expire after a day. Billing is covered in chat-billing.test.ts.
 */

let s: ApiServer;
const PEER = "/v3/workspaces/idem/peers/alice/chat";
const QUERY = "What does alice drink in the morning?";

const ask = (body: Record<string, unknown> = {}, key?: string, path = PEER) =>
  s.request("POST", path, { query: QUERY, ...body }, key ? { "idempotency-key": key } : {});
const modelCalls = () => s.ctx.llm.mock.calls.length;
const record = async (key: string) =>
  (
    await rows<{ status: string; account_id: string | null }>(
      s.ctx.db,
      sql`SELECT status, account_id FROM idempotency_records WHERE key = ${key}`,
    )
  )[0] ?? null;
const backdate = (key: string, interval: string) =>
  s.ctx.db.execute(
    sql`UPDATE idempotency_records SET created_at = created_at - ${interval}::interval WHERE key = ${key}`,
  );
async function until(check: () => Promise<boolean>, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Holds the next chat model call until `open()`; `entered` resolves once it is waiting. */
function gate() {
  let open!: () => void;
  let entered!: () => void;
  const opened = new Promise<void>((r) => {
    open = r;
  });
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const complete = s.ctx.llm.complete.bind(s.ctx.llm);
  const spy = vi.spyOn(s.ctx.llm, "complete").mockImplementationOnce(async (req) => {
    entered();
    await opened;
    return complete(req);
  });
  return { open, waiting, spy };
}

beforeAll(async () => {
  // No answer cache, so every request that runs is one model call.
  s = await createTestServer({ RECALL_CHAT_CACHE_TTL_S: "0" });
  await s.request("POST", "/v3/workspaces", { id: "idem" });
  for (const id of ["alice", "bob", "nobody"])
    await s.request("POST", "/v3/workspaces/idem/peers", { id });
  const facts = ["alice drinks oolong tea every morning", "bob drinks coffee"].map((content) => {
    const who = content.split(" ")[0]!;
    return { content, observer_id: who, observed_id: who };
  });
  expect(
    (await s.request("POST", "/v3/workspaces/idem/conclusions", { conclusions: facts })).status,
  ).toBeLessThan(300);
}, 60_000);
afterAll(() => s.close());

describe("chat Idempotency-Key", () => {
  it("replays the first answer for a retry of the same request, without asking again", async () => {
    const first = await ask({}, "same-1");
    expect(first.status).toBe(200);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    const text = await first.text();
    expect(JSON.parse(text).content).toBeTruthy();
    const calls = modelCalls();

    // The same request, written differently (defaults spelled out, nulls, another key order).
    const retry = await ask(
      { reasoning_level: "low", target: null, stream: false, include_evidence: false },
      "same-1",
    );
    expect(retry.status).toBe(200);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(await retry.text()).toBe(text);
    for (const h of ["content-type", "x-recall-cache", "x-recall-llm-calls", "x-recall-tokens-in"])
      expect(retry.headers.get(h), h).toBe(first.headers.get(h));
    expect(modelCalls()).toBe(calls);
    expect(await record("same-1")).toMatchObject({ status: "done", account_id: "default" });

    // Without a key nothing is kept: every request is a new one.
    expect((await ask({})).headers.get("idempotent-replayed")).toBeNull();
  });

  it("answers 409 for the same key with a different request, and runs nothing", async () => {
    expect((await ask({}, "same-2")).status).toBe(200);
    const calls = modelCalls();
    const others: [string, Record<string, unknown>, string?][] = [
      ["query", { query: "Where does alice live?" }],
      ["level", { reasoning_level: "medium" }],
      ["stream", { stream: true }],
      ["evidence", { include_evidence: true }],
      ["target", { target: "bob" }],
      ["response_format", { response_format: { type: "object", properties: {} } }],
      ["peer", {}, "/v3/workspaces/idem/peers/bob/chat"],
    ];
    for (const [what, body, path] of others) {
      const r = await ask(body, "same-2", path);
      expect(r.status, what).toBe(409);
      expect((await r.json()).detail, what).toBe(
        "Idempotency-Key was already used for a different request",
      );
    }
    expect(modelCalls()).toBe(calls);
    // The original request still replays.
    expect((await ask({}, "same-2")).headers.get("idempotent-replayed")).toBe("true");
    expect((await ask({}, "k".repeat(256))).status).toBe(422);
  });

  it("answers 409 to a duplicate while the first is still running, then replays its answer", async () => {
    const g = gate();
    const first = ask({}, "race-1");
    await g.waiting;
    const dupes = await Promise.all([ask({}, "race-1"), ask({}, "race-1")]);
    for (const r of dupes) {
      expect(r.status).toBe(409);
      expect(r.headers.get("retry-after")).toBe("1");
      expect((await r.json()).detail).toMatch(/still in progress; retry shortly/);
    }
    // A different request under the key is told so, not "in progress".
    expect((await (await ask({ query: "Anything else?" }, "race-1")).json()).detail).toMatch(
      /different request/,
    );
    g.open();
    const r1 = await first;
    expect(r1.status).toBe(200);
    expect(g.spy).toHaveBeenCalledTimes(1);
    g.spy.mockRestore();
    const again = await ask({}, "race-1");
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(await again.text()).toBe(await r1.text());
  });

  it("keeps nothing for a request that failed, so the same key runs again", async () => {
    const fail = vi
      .spyOn(s.ctx.llm, "complete")
      .mockRejectedValueOnce(new LlmError("provider down", "provider"));
    const failed = await ask({}, "fail-1");
    expect(failed.status).toBe(503);
    fail.mockRestore();
    expect(await record("fail-1")).toBeNull();
    const calls = modelCalls();
    const retried = await ask({}, "fail-1");
    expect(retried.status).toBe(200);
    expect(retried.headers.get("idempotent-replayed")).toBeNull();
    expect(modelCalls()).toBe(calls + 1);

    // A 4xx is not kept either: the key works once the request can succeed.
    const missing = await ask({}, "fail-2", "/v3/workspaces/idem/peers/carol/chat");
    expect(missing.status).toBe(404);
    expect(await record("fail-2")).toBeNull();
  });

  it("gives the key back after an answer from empty memory (no model call)", async () => {
    const path = "/v3/workspaces/idem/peers/nobody/chat";
    const first = await ask({ query: "What does nobody like?" }, "empty-1", path);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-recall-llm-calls")).toBe("0");
    expect(await record("empty-1")).toBeNull();
    const again = await ask({ query: "What does nobody like?" }, "empty-1", path);
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replayed")).toBeNull();
  });

  it("replays a streamed answer exactly as it was sent", async () => {
    const first = await ask({ stream: true }, "stream-1");
    expect(first.status).toBe(200);
    const text = await first.text();
    const frames = parseSse(text);
    expect(frames.at(-1)!.done).toBe(true);
    expect(frames.filter((f) => f.delta).length).toBeGreaterThan(0);
    await until(async () => (await record("stream-1"))?.status === "done");
    const calls = modelCalls();
    const replay = await ask({ stream: true }, "stream-1");
    expect(replay.status).toBe(200);
    expect(replay.headers.get("content-type")).toBe(first.headers.get("content-type"));
    expect(replay.headers.get("content-type")).toContain("text/event-stream");
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.text()).toBe(text);
    expect(modelCalls()).toBe(calls);
  });

  it("finishes a stream whose client hung up, so a retry with the key gets all of it", async () => {
    const res = await s.app.request(PEER, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "hangup-1" },
      body: JSON.stringify({ query: "What does alice drink at dawn?", stream: true }),
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await until(async () => (await record("hangup-1"))?.status === "done");
    const calls = modelCalls();
    const replay = await ask({ query: "What does alice drink at dawn?", stream: true }, "hangup-1");
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    const frames = parseSse(await replay.text());
    expect(frames.at(-1)).toMatchObject({ done: true, abstained: false });
    expect(
      frames
        .map((f) => f.delta?.content ?? "")
        .join("")
        .toLowerCase(),
    ).toContain("oolong");
    expect(modelCalls()).toBe(calls);
  });

  it("treats a key as new after a day", async () => {
    expect((await ask({}, "old-1")).status).toBe(200);
    await backdate("old-1", "25 hours");
    const calls = modelCalls();
    const fresh = await ask({}, "old-1");
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("idempotent-replayed")).toBeNull();
    expect(modelCalls()).toBe(calls + 1);
    // Expired, the key may even carry another request.
    await backdate("old-1", "25 hours");
    expect((await ask({ query: "Where does alice live?" }, "old-1")).status).toBe(200);
    expect(
      (await ask({ query: "Where does alice live?" }, "old-1")).headers.get("idempotent-replayed"),
    ).toBe("true");

    // The periodic cleanup deletes expired records.
    await backdate("old-1", "25 hours");
    await cleanupJobs(s.ctx);
    expect(await record("old-1")).toBeNull();
    expect(await record("same-1")).not.toBeNull();
  });

  it("frees the key of a request that never finished (its process died) after 15 minutes", async () => {
    const g = gate();
    const stuck = ask({}, "stuck-1");
    await g.waiting;
    expect((await ask({}, "stuck-1")).status).toBe(409);
    await backdate("stuck-1", "16 minutes");
    const taken = await ask({}, "stuck-1");
    expect(taken.status).toBe(200);
    expect(taken.headers.get("idempotent-replayed")).toBeNull();
    const body = await taken.text();
    // The old request finishing late does not overwrite the new one's answer.
    g.open();
    expect((await stuck).status).toBe(200);
    g.spy.mockRestore();
    const replay = await ask({}, "stuck-1");
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.text()).toBe(body);
  });
});
