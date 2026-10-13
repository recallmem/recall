import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chunkText } from "../src/core/files.js";
import { rows } from "../src/db/client.js";
import { signToken } from "../src/http/auth.js";
import { countTokens } from "../src/lib/tokens.js";
import { type ApiResponse, type ApiServer, createTestServer } from "./api-helpers.js";

type Server = ApiServer;
const json = async (res: ApiResponse) => res.json();

/** Builds a tiny valid PDF with one text line per page. */
function makePdf(pages: string[]): Uint8Array {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((text, i) => {
    const content = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe("messages", () => {
  let s: Server;
  beforeAll(async () => {
    s = await createTestServer();
  });
  afterAll(() => s.close());

  const post = (
    ws: string,
    session: string,
    messages: unknown[],
    headers: Record<string, string> = {},
  ) =>
    s.request("POST", `/v3/workspaces/${ws}/sessions/${session}/messages`, { messages }, headers);
  const internals = async (session: string) =>
    (
      await rows<{
        content: string;
        internal: {
          observers?: string[];
          file?: { chunk_index: number; total_chunks: number };
          [key: string]: unknown;
        };
        seq_in_session: number | string;
      }>(
        s.ctx.db,
        sql`SELECT m.content, m.internal, m.seq_in_session FROM messages m JOIN sessions x ON x.id = m.session_id
            WHERE x.name = ${session} ORDER BY m.seq`,
      )
    ).map((r) => ({ ...r, seq_in_session: Number(r.seq_in_session) }));

  it("creates a batch in order, auto-creating workspace, session, authors and memberships", async () => {
    const res = await post("w", "s1", [
      { content: "Hello there", peer_id: "alice", metadata: { lang: "en" } },
      { content: "", peer_id: "bob" },
      { content: "Third message with más tokens", peer_id: "alice" },
    ]);
    expect(res.status).toBe(201);
    const msgs = await json(res);
    expect(msgs.map((m: { content: string }) => m.content)).toEqual([
      "Hello there",
      "",
      "Third message with más tokens",
    ]);
    expect(msgs[0]).toMatchObject({
      peer_id: "alice",
      session_id: "s1",
      workspace_id: "w",
      metadata: { lang: "en" },
    });
    expect(msgs[0].id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(msgs[0].created_at).toMatch(/Z$/);
    expect(msgs.map((m: { token_count: number }) => m.token_count)).toEqual([
      countTokens("Hello there"),
      0,
      countTokens("Third message with más tokens"),
    ]);
    const members = (
      await json(await s.request("GET", "/v3/workspaces/w/sessions/s1/peers"))
    ).items.map((p: { id: string }) => p.id);
    expect(members).toEqual(["alice", "bob"]);
    expect((await internals("s1")).map((r) => r.seq_in_session)).toEqual([1, 2, 3]);
  });

  it("serves the trailing-slash alias", async () => {
    const res = await s.request("POST", "/v3/workspaces/w/sessions/s1/messages/", {
      messages: [{ content: "alias", peer_id: "alice" }],
    });
    expect(res.status).toBe(201);
  });

  it("validates the batch", async () => {
    expect((await post("w", "s1", [])).status).toBe(422);
    expect(
      (
        await post(
          "w",
          "s1",
          Array.from({ length: 101 }, () => ({ content: "x", peer_id: "alice" })),
        )
      ).status,
    ).toBe(422);
    expect(
      (await post("w", "s1", [{ content: "x".repeat(25_001), peer_id: "alice" }])).status,
    ).toBe(422);
    expect(
      (await post("w", "s1", [{ content: "x".repeat(25_000), peer_id: "alice" }])).status,
    ).toBe(201);
    expect((await post("w", "s1", [{ content: "x" }])).status).toBe(422);
    expect((await post("w", "s1", [{ content: "x", peer_id: "bad name" }])).status).toBe(422);
    expect(
      (await post("w", "s1", [{ content: "x", peer_id: "alice", created_at: "yesterday" }])).status,
    ).toBe(422);
    await s.request("POST", "/v3/workspaces/w/scopes", { id: "sc" });
    expect((await post("w", "s1", [{ content: "x", peer_id: "scope.sc" }])).status).toBe(422);
  });

  it("strips NUL characters from content", async () => {
    const [m] = await json(await post("w", "nul", [{ content: "a\u0000b", peer_id: "alice" }]));
    expect(m.content).toBe("ab");
  });

  it("treats tokenizer special-token markers as plain text", async () => {
    const content = "the log ended with <|endoftext|> and <|im_start|>";
    const [m] = await json(await post("w", "special", [{ content, peer_id: "alice" }]));
    expect(m.content).toBe(content);
    expect(m.token_count).toBeGreaterThan(5);
  });

  it("records observers and effective reasoning in messages.internal", async () => {
    await s.request("POST", "/v3/workspaces/obs/sessions", {
      id: "room",
      peers: { alice: {}, bob: { observe_others: true }, carol: { observe_me: false } },
      configuration: { reasoning: { custom_instructions: "session rule" } },
    });
    await s.request("POST", "/v3/workspaces/obs/scopes", { id: "team" });
    await s.request("POST", "/v3/workspaces/obs/scopes/team/sessions", { session_ids: ["room"] });
    await post("obs", "room", [
      { content: "from alice", peer_id: "alice" },
      { content: "from bob", peer_id: "bob" },
      { content: "from carol", peer_id: "carol" },
      { content: "skipped", peer_id: "alice", configuration: { reasoning: { enabled: false } } },
      {
        content: "custom",
        peer_id: "alice",
        configuration: { reasoning: { custom_instructions: "message rule" } },
      },
    ]);
    const ids = Object.fromEntries(
      (
        await rows<{ id: string; name: string }>(
          s.ctx.db,
          sql`SELECT p.id, p.name FROM peers p JOIN workspaces w ON w.id = p.workspace_id WHERE w.name = 'obs'`,
        )
      ).map((r) => [r.name, r.id]),
    );
    const [alice, bob, carol, skipped, custom] = await internals("room");
    // alice is observed by herself, by bob (observe_others) and by the scope peer
    expect(new Set(alice!.internal.observers)).toEqual(
      new Set([ids.alice, ids.bob, ids["scope.team"]]),
    );
    expect(alice!.internal).toMatchObject({ reasoning: true, instructions: "session rule" });
    // bob observes himself once, and the scope sees him too
    expect(new Set(bob!.internal.observers)).toEqual(new Set([ids.bob, ids["scope.team"]]));
    // observe_me=false: nobody derives anything
    expect(carol!.internal.observers).toEqual([]);
    expect(skipped!.internal.reasoning).toBe(false);
    expect(custom!.internal.instructions).toBe("message rule");
  });

  it("resolves reasoning from server defaults, workspace, session and legacy keys", async () => {
    await s.request("PUT", "/v3/workspaces/cfg", {
      configuration: { reasoning: { enabled: false } },
    });
    await post("cfg", "a", [{ content: "off by workspace", peer_id: "p" }]);
    await s.request("PUT", "/v3/workspaces/cfg/sessions/b", {
      configuration: { reasoning: { enabled: true } },
    });
    await post("cfg", "b", [{ content: "session wins", peer_id: "p" }]);
    await s.request("PUT", "/v3/workspaces/cfg/sessions/c", {
      configuration: { skip_deriver: true },
    });
    await s.request("PUT", "/v3/workspaces/cfg/sessions/c", {
      configuration: { reasoning: { enabled: true } },
    });
    await post("cfg", "c", [{ content: "explicit reasoning beats legacy", peer_id: "p" }]);
    await s.request("PUT", "/v3/workspaces/cfg/sessions/d", {
      configuration: { deriver: { enabled: true } },
    });
    await post("cfg", "d", [{ content: "legacy deriver on", peer_id: "p" }]);
    await s.request("PUT", "/v3/workspaces/cfg/sessions/e", {
      configuration: { custom_instructions: "  " },
    });
    await post("cfg", "e", [{ content: "blank means none", peer_id: "p" }]);
    expect((await internals("a"))[0]!.internal.reasoning).toBe(false);
    expect((await internals("b"))[0]!.internal.reasoning).toBe(true);
    expect((await internals("c"))[0]!.internal.reasoning).toBe(true);
    expect((await internals("d"))[0]!.internal.reasoning).toBe(true);
    expect((await internals("e"))[0]!.internal.instructions).toBeNull();
  });

  it("assigns contiguous sequence numbers under concurrent writers", async () => {
    await s.request("POST", "/v3/workspaces/conc/sessions", { id: "race" });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        post("conc", "race", [
          { content: `a${i}`, peer_id: "alice" },
          { content: `b${i}`, peer_id: "bob" },
        ]),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const seqs = (await internals("race")).map((r) => r.seq_in_session);
    expect(seqs).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    // the pairs of one request stay adjacent
    const contents = (await internals("race")).map((r) => r.content);
    for (let i = 0; i < 24; i += 2) expect(contents[i]!.slice(1)).toBe(contents[i + 1]!.slice(1));
  });

  it("schedules reasoning once per batch and summaries at the configured intervals", async () => {
    await s.request("POST", "/v3/workspaces/sch/sessions", {
      id: "sum",
      configuration: { summary: { messages_per_short_summary: 10, messages_per_long_summary: 20 } },
    });
    await post(
      "sch",
      "sum",
      Array.from({ length: 9 }, (_, i) => ({ content: `m${i}`, peer_id: "alice" })),
    );
    const count = async (kind: string) =>
      Number(
        (
          await rows<{ n: number }>(
            s.ctx.db,
            sql`SELECT count(*)::int AS n FROM jobs j JOIN sessions x ON x.id = j.session_id WHERE x.name = 'sum' AND j.kind = ${kind}`,
          )
        )[0]!.n,
      );
    expect(await count("reason")).toBe(1);
    expect(await count("summarize")).toBe(0);
    await post("sch", "sum", [{ content: "tenth", peer_id: "alice" }]);
    expect(await count("summarize")).toBe(1);
    // disabled summaries schedule nothing
    await s.request("POST", "/v3/workspaces/sch/sessions", {
      id: "nosum",
      configuration: { summary: { enabled: false } },
    });
    await post(
      "sch",
      "nosum",
      Array.from({ length: 60 }, (_, i) => ({ content: `m${i}`, peer_id: "alice" })),
    );
    expect(
      Number(
        (
          await rows<{ n: number }>(
            s.ctx.db,
            sql`SELECT count(*)::int AS n FROM jobs j JOIN sessions x ON x.id = j.session_id WHERE x.name = 'nosum' AND j.kind = 'summarize'`,
          )
        )[0]!.n,
      ),
    ).toBe(0);
  });

  it("replays a retried batch from its Idempotency-Key instead of duplicating it", async () => {
    const batch = [
      { content: "pay once", peer_id: "alice" },
      { content: "and once more", peer_id: "bob" },
    ];
    const first = await post("idem", "s", batch, { "idempotency-key": "req-1" });
    const retry = await post("idem", "s", batch, { "idempotency-key": "req-1" });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    const a = await json(first);
    const b = await json(retry);
    expect(b.map((m: { id: string }) => m.id)).toEqual(a.map((m: { id: string }) => m.id));
    expect(b.map((m: { created_at: string }) => m.created_at)).toEqual(
      a.map((m: { created_at: string }) => m.created_at),
    );
    expect((await internals("s")).length).toBe(2);
    // concurrent retries converge as well
    const racing = await Promise.all(
      [1, 2, 3, 4].map(() =>
        post("idem", "s", [{ content: "racer", peer_id: "alice" }], { "idempotency-key": "req-2" }),
      ),
    );
    const ids = new Set((await Promise.all(racing.map(json))).map((r) => r[0].id));
    expect(ids.size).toBe(1);
    expect((await internals("s")).length).toBe(3);
    // a different key creates new messages; a different size under the same key is a conflict
    await post("idem", "s", batch, { "idempotency-key": "req-3" });
    expect((await internals("s")).length).toBe(5);
    const mismatch = await post("idem", "s", [batch[0]], { "idempotency-key": "req-1" });
    expect(mismatch.status).toBe(409);
    expect((await json(mismatch)).detail).toBe(
      "Idempotency-Key was already used for a different request",
    );
    // no header: no deduplication (reference behaviour)
    await post("idem", "s", batch);
    await post("idem", "s", batch);
    expect((await internals("s")).length).toBe(9);
    expect((await post("idem", "s", batch, { "idempotency-key": "k".repeat(300) })).status).toBe(
      422,
    );
  });

  it("answers 409 when an Idempotency-Key comes back with different messages, and stores nothing", async () => {
    const batch = [
      {
        content: "I moved to Utrecht",
        peer_id: "alice",
        metadata: { source: "chat" },
        created_at: "2024-06-01T10:00:00Z",
      },
      { content: "Nice!", peer_id: "bob" },
    ];
    const key = { "idempotency-key": "fp-1" };
    const first = await post("idem-fp", "fp", batch, key);
    expect(first.status).toBe(201);
    const ids = (await json(first)).map((m: { id: string }) => m.id);

    const conflicts: [string, unknown[]][] = [
      ["content", [{ ...batch[0], content: "I moved to Delft" }, batch[1]]],
      ["author", [batch[0], { ...batch[1], peer_id: "carol" }]],
      ["metadata", [{ ...batch[0], metadata: { source: "email" } }, batch[1]]],
      ["created_at", [{ ...batch[0], created_at: "2024-06-02T10:00:00Z" }, batch[1]]],
      ["order", [batch[1], batch[0]]],
      [
        "configuration",
        [batch[0], { ...batch[1], configuration: { reasoning: { enabled: false } } }],
      ],
      ["count", [...batch, { content: "and one more", peer_id: "bob" }]],
    ];
    for (const [what, messages] of conflicts) {
      const res = await post("idem-fp", "fp", messages, key);
      expect(res.status, what).toBe(409);
      expect((await json(res)).detail, what).toBe(
        "Idempotency-Key was already used for a different request",
      );
    }
    expect((await internals("fp")).map((r) => r.content)).toEqual(["I moved to Utrecht", "Nice!"]);

    // The same messages, written differently on the wire, are the same request: a replay.
    const same = await post(
      "idem-fp",
      "fp",
      [
        {
          metadata: { source: "chat" },
          peer_id: "alice",
          content: "I moved to Utrecht",
          created_at: "2024-06-01T12:00:00+02:00",
        },
        { content: "Nice!", peer_id: "bob", metadata: null },
      ],
      key,
    );
    expect(same.status).toBe(201);
    expect((await json(same)).map((m: { id: string }) => m.id)).toEqual(ids);
    expect((await internals("fp")).length).toBe(2);

    // A metadata edit after the write does not turn a retry into a conflict.
    expect(
      (
        await s.request("PUT", `/v3/workspaces/idem-fp/sessions/fp/messages/${ids[0]}`, {
          metadata: { source: "edited" },
        })
      ).status,
    ).toBe(200);
    const retried = await post("idem-fp", "fp", batch, key);
    expect(retried.status).toBe(201);
    expect((await json(retried)).map((m: { id: string }) => m.id)).toEqual(ids);
  });

  it("replays the SDKs' batched writes: each batch under its own derived key", async () => {
    const many = (n: number, from = 0) =>
      Array.from({ length: n }, (_, i) => ({ content: `line ${from + i}`, peer_id: "alice" }));
    // The TypeScript SDK sends `${key}:${i}` per batch of 100, the Python SDK `key`, `${key}.${n}`.
    const plans: [string, [string, unknown[]][]][] = [
      [
        "sdk-ts",
        [
          ["bulk-1:0", many(100)],
          ["bulk-1:1", many(30, 100)],
        ],
      ],
      [
        "sdk-py",
        [
          ["bulk-2", many(100)],
          ["bulk-2.1", many(30, 100)],
        ],
      ],
    ];
    for (const [session, batches] of plans) {
      const first: string[] = [];
      for (const [key, messages] of batches) {
        const res = await post("idem-sdk", session, messages, { "idempotency-key": key });
        expect(res.status).toBe(201);
        first.push(...(await json(res)).map((m: { id: string }) => m.id));
      }
      // The whole call retried (say the second response was lost): everything replays.
      const again: string[] = [];
      for (const [key, messages] of batches) {
        const res = await post("idem-sdk", session, messages, { "idempotency-key": key });
        expect(res.status).toBe(201);
        again.push(...(await json(res)).map((m: { id: string }) => m.id));
      }
      expect(again).toEqual(first);
      expect((await internals(session)).length).toBe(130);
    }
  });

  it("lists in insertion order, not created_at order, with filters", async () => {
    await post("lst", "s", [
      {
        content: "second by time",
        peer_id: "alice",
        created_at: "2024-06-02T00:00:00Z",
        metadata: { n: 2 },
      },
      {
        content: "first by time",
        peer_id: "bob",
        created_at: "2024-06-01T00:00:00",
        metadata: { n: 1 },
      },
      { content: "third", peer_id: "alice", created_at: "2024-06-03T00:00:00+02:00" },
    ]);
    const list = async (body?: unknown, q = "") =>
      (
        await json(await s.request("POST", `/v3/workspaces/lst/sessions/s/messages/list${q}`, body))
      ).items.map((m: { content: string }) => m.content);
    expect(await list()).toEqual(["second by time", "first by time", "third"]);
    expect(await list(undefined, "?reverse=true")).toEqual([
      "third",
      "first by time",
      "second by time",
    ]);
    expect(await list({ filters: { peer_id: "alice" } })).toEqual(["second by time", "third"]);
    expect(await list({ filters: { metadata: { n: { gte: 2 } } } })).toEqual(["second by time"]);
    expect(await list({ filters: { created_at: { lt: "2024-06-02" } } })).toEqual([
      "first by time",
    ]);
    expect(await list({ filters: { OR: [{ peer_id: "bob" }, { metadata: { n: 2 } }] } })).toEqual([
      "second by time",
      "first by time",
    ]);
    expect(await list({ filters: { token_count: { gt: 0 } } })).toHaveLength(3);
    const bad = await s.request("POST", "/v3/workspaces/lst/sessions/s/messages/list", {
      filters: { id: "x" },
    });
    expect(bad.status).toBe(422);
    // pagination: offset and cursor agree
    const page2 = await json(
      await s.request("POST", "/v3/workspaces/lst/sessions/s/messages/list?size=2&page=2"),
    );
    expect(page2).toMatchObject({ total: 3, page: 2, size: 2, pages: 2 });
    expect(page2.items.map((m: { content: string }) => m.content)).toEqual(["third"]);
    const c1 = await json(
      await s.request("POST", "/v3/workspaces/lst/sessions/s/messages/list?size=2&cursor="),
    );
    expect(c1.items).toHaveLength(2);
    const c2 = await json(
      await s.request(
        "POST",
        `/v3/workspaces/lst/sessions/s/messages/list?size=2&cursor=${c1.next_page}`,
      ),
    );
    expect(c2.items.map((m: { content: string }) => m.content)).toEqual(["third"]);
    expect(c2.next_page).toBeNull();
    expect(c2.previous_page).not.toBeNull();
    const back = await json(
      await s.request(
        "POST",
        `/v3/workspaces/lst/sessions/s/messages/list?size=2&cursor=${c2.previous_page}`,
      ),
    );
    expect(back.items.map((m: { content: string }) => m.content)).toEqual([
      "second by time",
      "first by time",
    ]);
    expect(back.previous_page).toBeNull();
    // an unknown session is an empty page
    expect(
      (await json(await s.request("POST", "/v3/workspaces/lst/sessions/none/messages/list"))).items,
    ).toEqual([]);
  });

  it("gets a message and replaces only its metadata", async () => {
    const [m] = await json(
      await post("upd", "s", [{ content: "immutable", peer_id: "alice", metadata: { a: 1 } }]),
    );
    expect(
      await json(await s.request("GET", `/v3/workspaces/upd/sessions/s/messages/${m.id}`)),
    ).toEqual(m);
    const missing = await s.request("GET", "/v3/workspaces/upd/sessions/s/messages/nope");
    expect(missing.status).toBe(404);
    expect(await json(missing)).toEqual({ detail: "Message with ID nope not found" });
    const updated = await json(
      await s.request("PUT", `/v3/workspaces/upd/sessions/s/messages/${m.id}`, {
        metadata: { b: 2 },
        content: "changed",
      }),
    );
    expect(updated).toMatchObject({ content: "immutable", metadata: { b: 2 } });
    const noop = await json(
      await s.request("PUT", `/v3/workspaces/upd/sessions/s/messages/${m.id}`, { metadata: null }),
    );
    expect(noop.metadata).toEqual({ b: 2 });
    const other = await s.request("PUT", `/v3/workspaces/upd/sessions/other/messages/${m.id}`, {
      metadata: {},
    });
    expect(other.status).toBe(404);
    expect((await json(other)).detail).toBe("Message not found");
  });

  it("rejects messages for a session pending deletion", async () => {
    await post("del", "s", [{ content: "x", peer_id: "alice" }]);
    await s.request("DELETE", "/v3/workspaces/del/sessions/s");
    expect((await post("del", "s", [{ content: "y", peer_id: "alice" }])).status).toBe(404);
  });

  describe("file upload", () => {
    const upload = (
      session: string,
      file: { name: string; type: string; data: string | Uint8Array },
      fields: Record<string, string> = {},
      ws = "up",
    ) => {
      const form = new FormData();
      const part = typeof file.data === "string" ? file.data : Buffer.from(file.data);
      form.set("file", new File([part], file.name, { type: file.type }));
      form.set("peer_id", "alice");
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      return s.app.request(`/v3/workspaces/${ws}/sessions/${session}/messages/upload`, {
        method: "POST",
        body: form,
      });
    };

    it("turns a text file into one message and records provenance privately", async () => {
      const res = await upload(
        "t1",
        { name: "notes.txt", type: "text/plain", data: "Some notes\nsecond line" },
        {
          metadata: JSON.stringify({ source: "upload" }),
          created_at: "2024-01-01T00:00:00Z",
          configuration: JSON.stringify({ reasoning: { enabled: false } }),
        },
      );
      expect(res.status).toBe(201);
      const msgs = await json(res);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({
        content: "Some notes\nsecond line",
        peer_id: "alice",
        metadata: { source: "upload" },
        created_at: "2024-01-01T00:00:00.000Z",
      });
      const [row] = await internals("t1");
      expect(row!.internal.file).toMatchObject({
        filename: "notes.txt",
        chunk_index: 0,
        total_chunks: 1,
        content_type: "text/plain",
        original_file_size: 22,
      });
      expect(row!.internal.reasoning).toBe(false);
      expect(msgs[0]).not.toHaveProperty("internal");
    });

    it("splits long text at paragraph breaks into 25,000-character messages", async () => {
      const paragraph = `${"word ".repeat(1000)}end.`;
      const text = Array.from({ length: 12 }, () => paragraph).join("\n\n");
      const msgs = await json(
        await upload("t2", { name: "long.md", type: "text/markdown", data: text }),
      );
      expect(msgs.length).toBeGreaterThan(1);
      for (const m of msgs) expect(m.content.length).toBeLessThanOrEqual(25_000);
      expect(msgs.map((m: { content: string }) => m.content).join("")).toBe(text);
      expect(msgs[0].content.endsWith("\n\n")).toBe(true);
      const rowsAfter = await internals("t2");
      expect(rowsAfter.map((r) => r.internal.file?.chunk_index)).toEqual(
        msgs.map((_: unknown, i: number) => i),
      );
      expect(rowsAfter[0]!.internal.file?.total_chunks).toBe(msgs.length);
    });

    it("re-serialises JSON compactly and rejects invalid JSON", async () => {
      const ok = await json(
        await upload("t3", {
          name: "d.json",
          type: "application/json",
          data: '{ "a": [1, 2],\n "b": "x" }',
        }),
      );
      expect(ok[0].content).toBe('{"a":[1,2],"b":"x"}');
      expect(
        (await upload("t3", { name: "d.json", type: "application/json", data: "{nope" })).status,
      ).toBe(422);
    });

    it("extracts PDF text per page", async () => {
      const res = await upload("t4", {
        name: "doc.pdf",
        type: "application/pdf",
        data: makePdf(["Hello first page", "Second page here"]),
      });
      expect(res.status).toBe(201);
      const [m] = await json(res);
      expect(m.content).toContain("[Page 1]");
      expect(m.content).toContain("Hello first page");
      expect(m.content).toContain("[Page 2]\nSecond page here");
      expect(
        (await upload("t4", { name: "bad.pdf", type: "application/pdf", data: "not a pdf" }))
          .status,
      ).toBe(422);
    });

    it("rejects unsupported types and oversized files", async () => {
      const unsupported = await upload("t5", { name: "a.png", type: "image/png", data: "x" });
      expect(unsupported.status).toBe(415);
      expect((await json(unsupported)).detail).toMatch(
        /^Unsupported file type: image\/png\. Supported types: \[/,
      );
      const big = await upload("t5", {
        name: "big.txt",
        type: "text/plain",
        data: new Uint8Array(5 * 1024 * 1024 + 1),
      });
      expect(big.status).toBe(413);
      const empty = await upload("t5", { name: "e.txt", type: "text/plain", data: "   " });
      expect(empty.status).toBe(422);
      const form = new FormData();
      form.set("peer_id", "alice");
      const noFile = await s.app.request("/v3/workspaces/up/sessions/t5/messages/upload", {
        method: "POST",
        body: form,
      });
      expect(noFile.status).toBe(422);
    });

    it("replays a retried upload under its Idempotency-Key; another file under it is a 409", async () => {
      const send = (data: string) => {
        const form = new FormData();
        form.set("file", new File([data], "n.txt", { type: "text/plain" }));
        form.set("peer_id", "alice");
        return s.app.request("/v3/workspaces/up/sessions/t7/messages/upload", {
          method: "POST",
          body: form,
          headers: { "idempotency-key": "upload-1" },
        });
      };
      const first = await send("the same file");
      expect(first.status).toBe(201);
      const retry = await send("the same file");
      expect(retry.status).toBe(201);
      expect((await json(retry))[0].id).toBe((await json(first))[0].id);
      const other = await send("another file");
      expect(other.status).toBe(409);
      expect((await internals("t7")).map((r) => r.content)).toEqual(["the same file"]);
    });

    it("ignores malformed optional form fields", async () => {
      const res = await upload(
        "t6",
        { name: "n.txt", type: "text/plain", data: "hello" },
        { metadata: "{broken", created_at: "nonsense", configuration: "[]" },
      );
      expect(res.status).toBe(201);
      expect((await json(res))[0].metadata).toEqual({});
    });

    it("decodes UTF-8, UTF-16 with a BOM, and falls back to Latin-1", async () => {
      const utf8 = await json(
        await upload("t7", { name: "a.txt", type: "text/plain; charset=utf-8", data: "café ☃" }),
      );
      expect(utf8[0].content).toBe("café ☃");
      const utf16 = new Uint8Array([
        0xff,
        0xfe,
        ...Array.from("hi!").flatMap((ch) => [ch.charCodeAt(0), 0]),
      ]);
      expect(
        (await json(await upload("t7", { name: "b.txt", type: "text/plain", data: utf16 })))[0]
          .content,
      ).toBe("hi!");
      const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
      expect(
        (await json(await upload("t7", { name: "c.txt", type: "text/plain", data: latin1 })))[0]
          .content,
      ).toBe("café");
    });
  });

  it("chunkText covers the text exactly and prefers natural breaks", () => {
    const text = `${"a".repeat(20_000)}. ${"b".repeat(20_000)}`;
    const chunks = chunkText(text);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    expect(chunks[0]!.text.endsWith(". ")).toBe(true);
    const hard = chunkText("x".repeat(60_000));
    expect(hard.map((c) => c.text.length)).toEqual([25_000, 25_000, 10_000]);
  });
});

describe("messages (auth enabled)", () => {
  const secret = "s3cret";
  let s: Server;
  const as = (claims: Parameters<typeof signToken>[0]) => ({
    authorization: `Bearer ${signToken(claims, secret)}`,
  });
  beforeAll(async () => {
    s = await createTestServer({ RECALL_AUTH_ENABLED: "true", RECALL_AUTH_SECRET: secret });
  });
  afterAll(() => s.close());

  it("lets workspace and session tokens write, but not peer tokens", async () => {
    const body = { messages: [{ content: "hi", peer_id: "alice" }] };
    expect(
      (await s.request("POST", "/v3/workspaces/w/sessions/s/messages", body, as({ w: "w" })))
        .status,
    ).toBe(201);
    expect(
      (
        await s.request(
          "POST",
          "/v3/workspaces/w/sessions/s/messages",
          body,
          as({ w: "w", s: "s" }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await s.request(
          "POST",
          "/v3/workspaces/w/sessions/s/messages",
          body,
          as({ w: "w", s: "other" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await s.request(
          "POST",
          "/v3/workspaces/w/sessions/s/messages",
          body,
          as({ w: "w", p: "alice" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await s.request(
          "POST",
          "/v3/workspaces/w/sessions/s/messages/",
          body,
          as({ w: "w", p: "alice" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await s.request(
          "POST",
          "/v3/workspaces/w/sessions/s/messages/list",
          undefined,
          as({ w: "w", p: "alice" }),
        )
      ).status,
    ).toBe(200);
  });
});
