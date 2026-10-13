import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isBlockedAddress, setHostResolver } from "../src/core/webhooks.js";
import { rows } from "../src/db/client.js";
import { signToken } from "../src/http/auth.js";
import { type ApiResponse, type ApiServer, createTestServer } from "./api-helpers.js";

const json = async (res: ApiResponse) => res.json();

describe("webhook url safety", () => {
  it("classifies private, loopback, link-local and reserved addresses", () => {
    const blocked = [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "127.255.0.9",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "240.0.0.1",
      "192.0.2.1",
      "::",
      "::1",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "64:ff9b::7f00:1",
      "2002:7f00:1::1",
      "2001:db8::1",
      "not-an-ip",
    ];
    for (const address of blocked) expect(isBlockedAddress(address), address).toBe(true);
    const open = [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "172.32.0.1",
      "100.63.255.255",
      "2606:4700:4700::1111",
      "::ffff:8.8.8.8",
    ];
    for (const address of open) expect(isBlockedAddress(address), address).toBe(false);
  });
});

describe("webhook endpoints", () => {
  let s: ApiServer;
  const ws = "hooks";
  const create = (url: string, workspace = ws) =>
    s.request("POST", `/v3/workspaces/${workspace}/webhooks`, { url });
  beforeAll(async () => {
    s = await createTestServer({ RECALL_WEBHOOK_SECRET: "whsec" });
    await s.request("POST", "/v3/workspaces", { id: ws });
    setHostResolver(async (host) => {
      if (host === "internal.example.com") return ["10.0.0.5"];
      if (host === "mixed.example.com") return ["93.184.216.34", "192.168.0.10"];
      if (host === "rebind6.example.com") return ["::ffff:169.254.169.254"];
      if (host === "gone.example.com") throw new Error("ENOTFOUND");
      return ["93.184.216.34"];
    });
  });
  afterAll(async () => {
    setHostResolver(null);
    await s.close();
  });

  it("get-or-creates by exact URL: 201 then 200", async () => {
    const created = await create("https://example.com/hook");
    expect(created.status).toBe(201);
    const body = await json(created);
    expect(body).toMatchObject({ workspace_id: ws, url: "https://example.com/hook" });
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    const again = await create("https://example.com/hook");
    expect(again.status).toBe(200);
    expect((await json(again)).id).toBe(body.id);
    expect((await create("https://example.com/hook/")).status).toBe(201);
  });

  it("does not auto-create the workspace", async () => {
    expect((await create("https://example.com/x", "nowhere")).status).toBe(404);
  });

  it("rejects bad schemes, credentials, long URLs and IP literals in private ranges", async () => {
    const rejected = [
      "ftp://example.com/x",
      "not a url",
      "https://",
      "javascript:alert(1)",
      "https://user:pass@example.com/x",
      "http://127.0.0.1/hook",
      "http://10.0.0.1:8080/hook",
      "http://192.168.1.10/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/hook",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://0.0.0.0/",
      "http://224.0.0.1/",
      `https://example.com/${"a".repeat(2048)}`,
      // forms that normalise to a loopback address
      "http://2130706433/",
      "http://0x7f.0.0.1/",
      "http://127.1/",
    ];
    for (const url of rejected) {
      const res = await create(url);
      expect(res.status, url).toBe(422);
      expect(typeof (await json(res)).detail, url).toBe("string");
    }
  });

  it("rejects hostnames that are or resolve to private addresses (the reference only checks literals)", async () => {
    for (const url of [
      "http://localhost/hook",
      "http://localhost:3000/",
      "http://app.localhost/",
      "http://metadata.google.internal/",
      "http://printer.local/",
      "http://internal.example.com/hook",
      "http://mixed.example.com/hook",
      "https://rebind6.example.com/",
    ]) {
      const res = await create(url);
      expect(res.status, url).toBe(422);
      expect((await json(res)).detail, url).toMatch(/private, loopback, link-local or reserved/);
    }
    const unresolved = await create("https://gone.example.com/");
    expect(unresolved.status).toBe(422);
    expect((await json(unresolved)).detail).toBe(
      "Webhook URL host 'gone.example.com' could not be resolved",
    );
    expect((await create("https://public.example.com/ok")).status).toBe(201);
  });

  it("caps endpoints at ten per workspace", async () => {
    await s.request("POST", "/v3/workspaces", { id: "cap" });
    for (let i = 0; i < 10; i++)
      expect((await create(`https://example.com/${i}`, "cap")).status).toBe(201);
    const over = await create("https://example.com/eleven", "cap");
    expect(over.status).toBe(409);
    expect(await json(over)).toEqual({
      detail: "Maximum number of webhook endpoints (10) reached for this workspace.",
    });
    // an existing URL still resolves
    expect((await create("https://example.com/3", "cap")).status).toBe(200);
  });

  it("lists, deletes, and answers the test route", async () => {
    await s.request("POST", "/v3/workspaces", { id: "life" });
    const a = await json(await create("https://example.com/a", "life"));
    const b = await json(await create("https://example.com/b", "life"));
    const list = await json(await s.request("GET", "/v3/workspaces/life/webhooks"));
    expect(list.items.map((e: { id: string }) => e.id)).toEqual([a.id, b.id]);
    expect(list).toMatchObject({ total: 2, page: 1, pages: 1 });
    expect(
      (await json(await s.request("GET", "/v3/workspaces/life/webhooks?size=1&page=2"))).items.map(
        (e: { id: string }) => e.id,
      ),
    ).toEqual([b.id]);
    expect((await json(await s.request("GET", "/v3/workspaces/nowhere/webhooks"))).items).toEqual(
      [],
    );

    // /webhooks/test is not shadowed by /webhooks/{endpoint_id}
    const test = await s.request("GET", "/v3/workspaces/life/webhooks/test");
    expect(test.status).toBe(200);
    expect(await json(test)).toBeNull();
    const queued = await rows<{
      payload: { type: string; url: string; data: { workspace_id: string } };
    }>(s.ctx.db, sql`SELECT payload FROM jobs WHERE kind = 'webhook' ORDER BY id`);
    expect(queued.map((j) => j.payload.url).sort()).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(queued[0]!.payload).toMatchObject({
      type: "test.event",
      data: { workspace_id: "life" },
    });
    expect((await s.request("GET", "/v3/workspaces/ghost/webhooks/test")).status).toBe(404);

    expect((await s.request("DELETE", `/v3/workspaces/life/webhooks/${a.id}`)).status).toBe(204);
    expect((await s.request("DELETE", `/v3/workspaces/life/webhooks/${a.id}`)).status).toBe(404);
    expect((await s.request("DELETE", `/v3/workspaces/other/webhooks/${b.id}`)).status).toBe(404);
    expect(
      (await json(await s.request("GET", "/v3/workspaces/life/webhooks"))).items.map(
        (e: { id: string }) => e.id,
      ),
    ).toEqual([b.id]);
    // with no endpoints the test route still succeeds
    await s.request("DELETE", `/v3/workspaces/life/webhooks/${b.id}`);
    expect((await s.request("GET", "/v3/workspaces/life/webhooks/test")).status).toBe(200);
  });

  it("validates the body", async () => {
    expect((await s.request("POST", `/v3/workspaces/${ws}/webhooks`, {})).status).toBe(422);
    expect((await s.request("POST", `/v3/workspaces/${ws}/webhooks`, { url: "" })).status).toBe(
      422,
    );
  });
});

describe("webhook endpoints in local development", () => {
  it("accepts private hosts when RECALL_WEBHOOK_ALLOW_PRIVATE is set", async () => {
    const s = await createTestServer({ RECALL_WEBHOOK_ALLOW_PRIVATE: "true" });
    try {
      await s.request("POST", "/v3/workspaces", { id: "dev" });
      expect(
        (
          await s.request("POST", "/v3/workspaces/dev/webhooks", {
            url: "http://localhost:9000/hook",
          })
        ).status,
      ).toBe(201);
      expect(
        (await s.request("POST", "/v3/workspaces/dev/webhooks", { url: "ftp://localhost/x" }))
          .status,
      ).toBe(422);
    } finally {
      await s.close();
    }
  });
});

describe("webhook endpoints (auth enabled)", () => {
  const secret = "s3cret";
  let s: ApiServer;
  const as = (claims: Parameters<typeof signToken>[0]) => ({
    authorization: `Bearer ${signToken(claims, secret)}`,
  });
  afterEach(() => setHostResolver(null));
  beforeAll(async () => {
    s = await createTestServer({ RECALL_AUTH_ENABLED: "true", RECALL_AUTH_SECRET: secret });
    await s.request("POST", "/v3/workspaces", { id: "w" }, as({ ad: true }));
  });
  afterAll(() => s.close());

  it("requires a workspace or admin token", async () => {
    setHostResolver(async () => ["93.184.216.34"]);
    const post = (headers: Record<string, string>) =>
      s.request("POST", "/v3/workspaces/w/webhooks", { url: "https://example.com/h" }, headers);
    expect((await post(as({ w: "w", p: "alice" }))).status).toBe(401);
    expect((await post(as({ w: "w", s: "s1" }))).status).toBe(401);
    expect((await post(as({ w: "other" }))).status).toBe(401);
    expect((await post(as({ w: "w" }))).status).toBe(201);
    expect(
      (await s.request("GET", "/v3/workspaces/w/webhooks", undefined, as({ w: "w", p: "alice" })))
        .status,
    ).toBe(401);
    expect(
      (
        await s.request(
          "GET",
          "/v3/workspaces/w/webhooks/test",
          undefined,
          as({ w: "w", p: "alice" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (await s.request("DELETE", "/v3/workspaces/w/webhooks/x", undefined, as({ w: "w", s: "s1" })))
        .status,
    ).toBe(401);
  });
});
