import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rows } from "../src/db/client.js";
import { Browser, createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * The peer card on the dashboard shows, per line, the facts in the peer's own memory that name
 * its value, and an owner can remove a line together with the facts behind it, so a card refresh
 * cannot write it back from them.
 */

let s: HostedServer;
let b: Browser;
let auth: Record<string, string>;
const WS = "people";
const PEER = "alice";
const page = `/app/memory/${WS}/peers/${PEER}`;

const api = async (method: string, path: string, body?: unknown) => {
  const r = await s.api(method, path, body, auth);
  expect(r.status, `${method} ${path}: ${await r.clone().text()}`).toBeLessThan(300);
  return r.json();
};

const facts = async () =>
  (
    await rows<{ id: string; content: string }>(
      s.ctx.db,
      sql`SELECT c.id, c.content FROM conclusions c JOIN peers p ON p.id = c.observed_id
          WHERE p.name = ${PEER} AND c.deleted_at IS NULL ORDER BY c.content`,
    )
  ).map((r) => r);

beforeAll(async () => {
  s = await createHostedServer();
  b = new Browser(s.app, "203.0.113.90");
  await b.signIn(s, "owner@example.com");
  const created = await b.createKey({ name: "test", mode: "live" });
  auth = { authorization: `Bearer ${created.key}` };
  await api("POST", "/v3/workspaces", { id: WS });
  await api("POST", `/v3/workspaces/${WS}/peers`, { id: PEER });
  await api("POST", `/v3/workspaces/${WS}/conclusions`, {
    conclusions: [
      "Alice lives in Utrecht",
      "Alice moved to Utrecht in March",
      "Alice works at Acme as a designer",
      "Alice is vegetarian",
    ].map((content) => ({ content, observer_id: PEER, observed_id: PEER })),
  });
  await api("PUT", `/v3/workspaces/${WS}/peers/${PEER}/card`, {
    peer_card: [
      "IDENTITY: Name: Alice",
      "ATTRIBUTE: Home: Utrecht",
      "ATTRIBUTE: Employer: Acme",
      "ATTRIBUTE: Pet: Rex",
    ],
  });
});
afterAll(async () => {
  await s.close();
});

describe("peer card sources", () => {
  it("lists the facts behind each line, and says when there are none", async () => {
    const { html } = await b.get(page);
    const row = (value: string) =>
      html.match(
        new RegExp(
          `<li class="card-row">(?:(?!<li class="card-row">)[\\s\\S])*?<span>${value}</span>[\\s\\S]*?</details></li>`,
        ),
      )?.[0] ?? "";
    const home = row("Utrecht");
    expect(home).toContain("From 2 facts");
    expect(home).toContain("Alice lives in Utrecht");
    expect(home).toContain("Alice moved to Utrecht in March");
    expect(home).not.toContain("vegetarian");
    expect(row("Acme")).toContain("From 1 fact");
    // The name is in every fact: none is listed (and none could be deleted from here).
    const name = row("Alice");
    expect(name).toContain("From the name");
    expect(name).not.toContain('type="checkbox"');
    expect(row("Rex")).toContain("From no stored fact");
  });

  it("removes a line and deletes only the ticked facts behind it", async () => {
    const before = await facts();
    const utrecht = before.filter((f) => f.content.includes("Utrecht"));
    expect(utrecht).toHaveLength(2);
    await b.get(page);
    const res = await b.post(`${page}/card/remove`, {
      entry: "ATTRIBUTE: Home: Utrecht",
      [`fact_${utrecht[0]!.id}`]: "1",
      [`fact_${utrecht[1]!.id}`]: "1",
      // Not behind this line: ignored.
      [`fact_${before.find((f) => f.content.includes("vegetarian"))!.id}`]: "1",
    });
    expect(res.res.status).toBe(303);
    const after = await facts();
    expect(after.map((f) => f.content)).toEqual([
      "Alice is vegetarian",
      "Alice works at Acme as a designer",
    ]);
    const card = await api("GET", `/v3/workspaces/${WS}/peers/${PEER}/card`);
    expect(card.peer_card).toEqual([
      "IDENTITY: Name: Alice",
      "ATTRIBUTE: Employer: Acme",
      "ATTRIBUTE: Pet: Rex",
    ]);
    const shown = await b.get(page);
    expect(shown.html).toContain("Removed from the card");
    expect(shown.html).toContain("2 facts behind it deleted for good");
  });

  it("removes a line without facts, and refuses a line that is not on the card", async () => {
    await b.get(page);
    expect((await b.post(`${page}/card/remove`, { entry: "ATTRIBUTE: Pet: Rex" })).res.status).toBe(
      303,
    );
    const card = await api("GET", `/v3/workspaces/${WS}/peers/${PEER}/card`);
    expect(card.peer_card).toEqual(["IDENTITY: Name: Alice", "ATTRIBUTE: Employer: Acme"]);
    await b.get(page);
    expect((await b.post(`${page}/card/remove`, { entry: "ATTRIBUTE: Pet: Rex" })).res.status).toBe(
      409,
    );
  });

  it("needs a role that may change the account", async () => {
    const stranger = new Browser(s.app, "203.0.113.91");
    await stranger.signIn(s, "stranger@example.com");
    await stranger.get("/app");
    const r = await stranger.post(`${page}/card/remove`, { entry: "ATTRIBUTE: Employer: Acme" });
    expect(r.res.status).toBe(404);
    expect((await api("GET", `/v3/workspaces/${WS}/peers/${PEER}/card`)).peer_card).toContain(
      "ATTRIBUTE: Employer: Acme",
    );
  });
});
