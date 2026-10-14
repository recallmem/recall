import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rows } from "../src/db/client.js";
import { shortDay } from "../src/http/dashboard/chart.js";
import { lastDays } from "../src/http/dashboard/explorer.js";
import { newId } from "../src/lib/ids.js";
import { drainQueue } from "../src/queue/worker.js";
import { Browser, createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * The dashboard's memory explorer, playground, getting-started checklist and
 * activity charts, and tenant isolation between two accounts that use the
 * same workspace name.
 */

let s: HostedServer;

interface Account {
  b: Browser;
  id: string;
  auth: Record<string, string>;
}

const accountOf = async (email: string) => {
  const [r] = await rows<{ account_id: string }>(
    s.ctx.db,
    sql`SELECT m.account_id FROM account_members m JOIN users u ON u.id = m.user_id WHERE u.email = ${email}`,
  );
  return r!.account_id;
};

async function signUp(email: string, ip: string, opts: { key?: boolean } = {}): Promise<Account> {
  const b = new Browser(s.app, ip);
  await b.signIn(s, email);
  let auth: Record<string, string> = {};
  if (opts.key !== false) {
    const created = await b.createKey({ name: "test", mode: "live" });
    auth = { authorization: `Bearer ${created.html.match(/pk_live_[A-Za-z0-9]{32}/)![0]}` };
  }
  return { b, id: await accountOf(email), auth };
}

const api = async (a: Account, method: string, path: string, body?: unknown) => {
  const r = await s.api(method, path, body, a.auth);
  expect(r.status, `${method} ${path}: ${await r.clone().text()}`).toBeLessThan(300);
  return r;
};

const post = (a: Account, ws: string, session: string, lines: [string, string][]) =>
  api(a, "POST", `/v3/workspaces/${ws}/sessions/${session}/messages`, {
    messages: lines.map(([peer_id, content]) => ({ peer_id, content })),
  });

const chats = async (accountId: string) =>
  rows<{ kind: string; amount_micros: string }>(
    s.ctx.db,
    sql`SELECT kind, amount_micros FROM credit_ledger WHERE account_id = ${accountId} AND kind LIKE 'chat\\_%' ORDER BY id`,
  );

const messageId = async (accountId: string, content: string) => {
  const [r] = await rows<{ id: string }>(
    s.ctx.db,
    sql`SELECT m.id FROM messages m JOIN workspaces w ON w.id = m.workspace_id
        WHERE w.account_id = ${accountId} AND m.content = ${content}`,
  );
  return r!.id;
};

/** The HTML entities hono/html produces, decoded. */
const decodeHtml = (h: string) =>
  h
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

let A: Account;
let B: Account;

beforeAll(async () => {
  s = await createHostedServer({
    env: { RECALL_REASONER_MAX_DELAY_MS: "0", RECALL_CHAT_CACHE_TTL_S: "0" },
  });
  A = await signUp("ana@example.com", "198.18.0.1");
  B = await signUp("ben@example.com", "198.18.0.2");

  // A: "notes" (a name B uses too) with a fact that changes, and "a-only".
  await api(A, "POST", "/v3/workspaces/notes/sessions", {
    id: "chat-1",
    peers: { alice: {}, bot: { observe_others: true } },
  });
  await post(A, "notes", "chat-1", [
    ["alice", "I live in Amsterdam. I have a dog named Rover."],
    ["bot", "Nice to meet you!"],
  ]);
  await drainQueue(s.ctx);
  await post(A, "notes", "chat-1", [["alice", "I moved to Utrecht."]]);
  await drainQueue(s.ctx);
  await api(A, "POST", "/v3/workspaces", { id: "a-only" });

  // B: the same workspace name, and one A must never reach.
  await post(B, "notes", "b-chat", [["bob-secret", "I live in Oslo. My hint is tangerine."]]);
  await post(B, "b-private", "b-hidden", [["carol", "I work at Initech."]]);
  await drainQueue(s.ctx);
}, 60_000);

afterAll(async () => {
  await s.close();
});

describe("memory explorer", () => {
  it("lists the account's workspaces with counts", async () => {
    const r = await A.b.get("/app/memory");
    expect(r.res.status).toBe(200);
    expect(r.html).toContain('aria-current="page">Memory</a>');
    const card = r.html.match(
      /<a class="ws-card" href="\/app\/memory\/notes">([\s\S]*?)<\/a>/,
    )?.[1];
    expect(card).toBeDefined();
    expect(card).toMatch(/<dt>Peers<\/dt><dd>2<\/dd>/);
    expect(card).toMatch(/<dt>Sessions<\/dt><dd>1<\/dd>/);
    expect(card).toMatch(/<dt>Messages<\/dt><dd>3<\/dd>/);
    expect(card).toMatch(/<dt>Facts<\/dt><dd>[1-9]\d*<\/dd>/);
    expect(card).toContain("Active just now");
    expect(r.html).toContain('href="/app/memory/a-only"');
  });

  it("teaches with a quickstart when there is no memory yet", async () => {
    const fresh = await signUp("newbie@example.com", "198.18.0.3", { key: false });
    const r = await fresh.b.get("/app/memory");
    expect(r.html).toContain("No memory yet");
    expect(r.html).toContain("Create an API key");
    expect(r.html).toContain(
      "curl -X POST https://recall.test/v3/workspaces/my-app/sessions/first-chat/messages",
    );
    expect(r.html).toContain("https://recall.test/v3/workspaces/my-app/peers/alice/chat");
    expect(r.html).toContain('href="/app/keys"');
    const pg = await fresh.b.get("/app/playground");
    expect(pg.html).toContain("Nothing to ask about yet");
  });

  it("shows peers and sessions of a workspace, newest first, with queue status", async () => {
    const peers = await A.b.get("/app/memory/notes");
    expect(peers.res.status).toBe(200);
    expect(peers.html).toContain('href="/app/memory/notes/peers/alice"');
    expect(peers.html).toContain('href="/app/memory/notes/peers/bot"');
    expect(peers.html).toContain('data-queue="idle"');

    const sessions = await A.b.get("/app/memory/notes/sessions");
    expect(sessions.html).toContain('href="/app/memory/notes/sessions/chat-1"');
    expect(sessions.html).toMatch(
      /sessions\/chat-1">chat-1<\/a><\/td><td>[\s\S]*?<td class="num">3<\/td>/,
    );

    // Unprocessed messages show as pending background work.
    await post(A, "a-only", "queued", [["dora", "I have a cat."]]);
    const busy = await A.b.get("/app/memory/a-only");
    expect(busy.html).toContain('data-queue="busy"');
    expect(busy.html).toContain("1 unit pending");
    expect(busy.html).toContain("queued");
    await drainQueue(s.ctx);
    expect((await A.b.get("/app/memory/a-only")).html).toContain('data-queue="idle"');
  });

  it("shows a peer's current and superseded facts with validity and sources", async () => {
    const current = await A.b.get("/app/memory/notes/peers/alice");
    expect(current.res.status).toBe(200);
    expect(current.html).toContain("alice lives in Utrecht");
    expect(current.html).not.toContain("alice lives in Amsterdam");
    expect(current.html).toContain('data-state="current"');
    expect(current.html).not.toContain('data-state="superseded"');
    // The peer card, with its labelled lines.
    expect(current.html).toMatch(/<span class="card-key">Location<\/span><span>Utrecht<\/span>/);
    // Sessions the peer is in.
    expect(current.html).toContain('href="/app/memory/notes/sessions/chat-1"');

    const all = await A.b.get("/app/memory/notes/peers/alice?state=all");
    const old = all.html.match(/<li class="fact is-superseded"[\s\S]*?<\/li>/)?.[0];
    expect(old).toBeDefined();
    expect(old).toContain("alice lives in Amsterdam");
    expect(old).toContain("Superseded");
    const today = new Date().toISOString().slice(0, 10);
    expect(old).toContain(`${today} → ${today}`);
    expect(old).toContain("Replaced by");
    expect(old).toContain("“alice lives in Utrecht”");
    // Source message links into the session transcript, at that message.
    const amsterdam = await messageId(A.id, "I live in Amsterdam. I have a dog named Rover.");
    expect(old).toContain(`/app/memory/notes/sessions/chat-1?at=${amsterdam}#m-${amsterdam}`);

    const filtered = await A.b.get("/app/memory/notes/peers/alice?state=all&q=dog");
    // The filter narrows the fact list (the card above it keeps listing its own sources).
    const list = filtered.html.slice(filtered.html.indexOf('id="facts"'));
    expect(list).toContain("Rover");
    expect(list).not.toContain("alice lives in Utrecht");

    // The default view is the peer's own memory; other observers' views are one click away.
    expect(current.html).not.toContain("seen by");
    const everyone = await A.b.get("/app/memory/notes/peers/alice?observer=*");
    expect(everyone.html).toContain("self-observed");
    expect(everyone.html).toContain('seen by <a href="/app/memory/notes/peers/bot">bot</a>');
    const botView = await A.b.get("/app/memory/notes/peers/alice?observer=bot");
    expect(botView.html).not.toContain("self-observed");
    expect(botView.html).toContain("alice lives in Utrecht");
  });

  it("shows a session as a chat, oldest first, pages it and jumps to a message", async () => {
    const page = await A.b.get("/app/memory/notes/sessions/chat-1");
    expect(page.res.status).toBe(200);
    const first = page.html.indexOf("I live in Amsterdam.");
    const second = page.html.indexOf("Nice to meet you!");
    const third = page.html.indexOf("I moved to Utrecht.");
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
    expect(page.html).toMatch(/class="msg-peer" href="\/app\/memory\/notes\/peers\/bot">bot<\/a>/);

    const lines = Array.from({ length: 35 }, (_, i) => `entry-${String(i + 1).padStart(2, "0")}`);
    await post(
      A,
      "a-only",
      "long-chat",
      lines.map((l) => ["dora", l]),
    );
    // Lists are newest first.
    const list = await A.b.get("/app/memory/a-only/sessions");
    expect(list.html.indexOf("sessions/long-chat")).toBeGreaterThan(0);
    expect(list.html.indexOf("sessions/long-chat")).toBeLessThan(
      list.html.indexOf("sessions/queued"),
    );
    const latest = await A.b.get("/app/memory/a-only/sessions/long-chat");
    expect(latest.html).toContain("entry-35");
    expect(latest.html).not.toContain("entry-01");
    expect(latest.html).toContain("Page 2 of 2");
    const earliest = await A.b.get("/app/memory/a-only/sessions/long-chat?page=1");
    expect(earliest.html).toContain("entry-01");
    expect(earliest.html).not.toContain("entry-35");
    const id = await messageId(A.id, "entry-02");
    const jump = await A.b.get(`/app/memory/a-only/sessions/long-chat?at=${id}`);
    expect(jump.html).toContain(`id="m-${id}"`);
    expect(jump.html).toContain("Page 1 of 2");
  });

  it("shows the running summary and escapes message content", async () => {
    const [sess] = await rows<{ id: string; workspace_id: string }>(
      s.ctx.db,
      sql`SELECT s.id, s.workspace_id FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
          WHERE w.account_id = ${A.id} AND w.name = 'notes' AND s.name = 'chat-1'`,
    );
    const last = await messageId(A.id, "I moved to Utrecht.");
    await s.ctx.db.execute(
      sql`INSERT INTO summary_blocks (id, workspace_id, session_id, kind, start_seq, end_seq, last_message_id, content, token_count)
          VALUES (${newId()}, ${sess!.workspace_id}, ${sess!.id}, 'short', 1, 3, ${last}, 'Alice moved from Amsterdam to Utrecht.', 9)`,
    );
    await post(A, "notes", "chat-1", [["bot", "<script>alert(1)</script>"]]);
    const page = await A.b.get("/app/memory/notes/sessions/chat-1");
    expect(page.html).toContain("Alice moved from Amsterdam to Utrecht.");
    expect(page.html).toContain("Short summary through message");
    expect(page.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page.html).not.toContain("<script>alert(1)</script>");
    await drainQueue(s.ctx);
  });

  it("previews exactly what GET …/sessions/{id}/context returns", async () => {
    const q = "tokens=5000&peer_target=alice";
    const page = await A.b.get(`/app/memory/notes/sessions/chat-1?preview=1&${q}&summary=1`);
    expect(page.res.status).toBe(200);
    expect(page.html).toContain(
      `GET /v3/workspaces/notes/sessions/chat-1/context?${q.replace("&", "&amp;")}`,
    );
    expect(page.html).toContain("Peer representation");
    const raw = page.html.match(
      /<summary>Raw JSON response<\/summary>[\s\S]*?<pre[^>]*>([\s\S]*?)<\/pre>/,
    )?.[1];
    expect(raw).toBeDefined();
    const shown = JSON.parse(decodeHtml(raw!));
    const fromApi = await (
      await api(A, "GET", `/v3/workspaces/notes/sessions/chat-1/context?${q}`)
    ).json();
    expect(shown).toEqual(fromApi);
    expect(shown.peer_representation).toContain("Utrecht");
    expect(shown.summary.content).toBe("Alice moved from Amsterdam to Utrecht.");

    // Without the form submitted, nothing is computed.
    expect((await A.b.get("/app/memory/notes/sessions/chat-1")).html).not.toContain(
      "Raw JSON response",
    );
  });

  it("creates an empty workspace (and only in this account)", async () => {
    const bad = await A.b.post("/app/memory", { name: "not a name!" });
    expect(bad.res.status).toBe(422);
    const ok = await A.b.post("/app/memory", { name: "fresh-ws" });
    expect(ok.res.status).toBe(303);
    expect(ok.res.headers.get("location")).toBe("/app/memory/fresh-ws");
    const page = await A.b.get("/app/memory/fresh-ws");
    expect(page.res.status).toBe(200);
    expect(page.html).toContain("No peers yet");
    expect((await B.b.get("/app/memory/fresh-ws")).res.status).toBe(404);
    expect(await A.b.post("/app/memory", { name: "x" }, { csrf: "forged" })).toMatchObject({
      res: { status: 403 },
    });
  });
});

describe("playground", () => {
  it("answers on the peer page through the billed chat path, with evidence", async () => {
    const before = await chats(A.id);
    await A.b.get("/app/memory/notes/peers/alice");
    const r = await A.b.post("/app/memory/notes/peers/alice/ask", {
      query: "Where does alice live?",
      level: "low",
      nonce: "nonce-peer-page-0001",
    });
    expect(r.res.status).toBe(200);
    const answer = r.html.match(/<section class="answer[\s\S]*?<\/section>/)?.[0];
    expect(answer).toBeDefined();
    expect(answer).toContain('data-abstained="false"');
    expect(answer).toContain("Utrecht");
    expect(answer).toContain("Confidence");
    expect(answer).toMatch(/<strong>\d+%<\/strong>/);
    expect(answer).toContain("<h3>Citations</h3>");
    expect(answer).toMatch(/<li class="cited" data-fact="[^"]+">/);
    expect(answer).toContain("Facts read");
    expect(answer).toContain("1 low query · $0.005");
    // Billed exactly once, as a chat at that level.
    const after = await chats(A.id);
    expect(after.length).toBe(before.length + 1);
    expect(after.at(-1)?.kind).toBe("chat_low");
    expect(Number(after.at(-1)?.amount_micros)).toBe(-5000);
    // The same form submitted again (a reload) is not charged twice.
    await A.b.post("/app/memory/notes/peers/alice/ask", {
      query: "Where does alice live?",
      level: "low",
      nonce: "nonce-peer-page-0001",
    });
    expect((await chats(A.id)).length).toBe(before.length + 1);
    // The form says what a question costs.
    expect(r.html).toContain("Each question is billed as one query at the chosen level");
    expect(r.html).toContain('<option value="low" selected>low · $0.005</option>');
  });

  it("needs the session's CSRF token", async () => {
    const before = await chats(A.id);
    const r = await A.b.post(
      "/app/memory/notes/peers/alice/ask",
      { query: "Where does alice live?", level: "low" },
      { csrf: null },
    );
    expect(r.res.status).toBe(403);
    expect((await chats(A.id)).length).toBe(before.length);
  });

  it("applies the spend cap like the API (402, nothing charged)", async () => {
    await A.b.get("/app/settings");
    expect((await A.b.post("/app/settings/budget", { monthly_budget_usd: "0" })).res.status).toBe(
      303,
    );
    const before = await chats(A.id);
    const calls = s.ctx.llm.mock.calls.length;
    await A.b.get("/app/memory/notes/peers/alice");
    const r = await A.b.post("/app/memory/notes/peers/alice/ask", {
      query: "Where does alice live?",
      level: "medium",
      nonce: "nonce-over-budget-01",
    });
    expect(r.res.status).toBe(402);
    expect(r.html).toContain('data-status="402"');
    expect(r.html).toContain("Monthly budget exceeded");
    expect(r.html).toContain("Nothing was charged");
    expect((await chats(A.id)).length).toBe(before.length);
    expect(s.ctx.llm.mock.calls.length).toBe(calls);
    await A.b.get("/app/settings");
    await A.b.post("/app/settings/budget", { monthly_budget_usd: "" });
  });

  it("has its own page with a workspace and peer picker", async () => {
    const page = await A.b.get("/app/playground?ws=notes&peer=alice");
    expect(page.res.status).toBe(200);
    expect(page.html).toContain('aria-current="page">Playground</a>');
    expect(page.html).toContain('<option value="notes" selected>notes</option>');
    expect(page.html).toContain('<option value="a-only">a-only</option>');
    expect(page.html).toContain('<option value="alice" selected>alice</option>');
    expect(page.html).toContain('name="ws" value="notes"');
    const before = await chats(A.id);
    const r = await A.b.post("/app/playground", {
      ws: "notes",
      peer: "alice",
      perspective: "bot",
      query: "Where does alice live?",
      level: "minimal",
      nonce: "nonce-playground-0001",
    });
    expect(r.res.status).toBe(200);
    expect(r.html).toContain("You asked · minimal · bot&#39;s view");
    expect(r.html).toContain("Utrecht");
    expect((await chats(A.id)).at(-1)?.kind).toBe("chat_minimal");
    expect((await chats(A.id)).length).toBe(before.length + 1);
    // A perspective that is not a peer here is a 404, not a new peer.
    const ghost = await A.b.post("/app/playground", {
      ws: "notes",
      peer: "alice",
      perspective: "ghost",
      query: "Where does alice live?",
    });
    expect(ghost.res.status).toBe(404);
    expect(
      await rows(
        s.ctx.db,
        sql`SELECT 1 FROM peers p JOIN workspaces w ON w.id = p.workspace_id WHERE w.account_id = ${A.id} AND p.name = 'ghost'`,
      ),
    ).toHaveLength(0);
  });
});

describe("overview and usage", () => {
  it("ticks the getting-started checklist off from real data", async () => {
    const c = await signUp("checklist@example.com", "198.18.0.4", { key: false });
    let home = await c.b.get("/app");
    expect(home.html).toContain('data-checklist="0/3"');
    expect(home.html).toContain('data-step="1" data-done="false"');

    const created = await c.b.createKey({ name: "k" });
    c.auth = { authorization: `Bearer ${created.html.match(/pk_live_[A-Za-z0-9]{32}/)![0]}` };
    home = await c.b.get("/app");
    expect(home.html).toContain('data-checklist="1/3"');
    expect(home.html).toContain('data-step="1" data-done="true"');
    expect(home.html).toContain('data-step="2" data-done="false"');

    const daysAgo2 = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await api(c, "POST", "/v3/workspaces/w/sessions/s/messages", {
      messages: [
        { peer_id: "zoe", content: "I live in Lisbon.", created_at: daysAgo2 },
        { peer_id: "zoe", content: "I have a bike.", created_at: daysAgo2 },
        { peer_id: "zoe", content: "I like tea.", created_at: daysAgo2 },
      ],
    });
    await post(c, "w", "s", [
      ["zoe", "I like jazz."],
      ["zoe", "I play chess."],
    ]);
    await drainQueue(s.ctx);
    home = await c.b.get("/app");
    expect(home.html).toContain('data-checklist="2/3"');
    expect(home.html).toContain('data-step="2" data-done="true"');

    await api(c, "POST", "/v3/workspaces/w/peers/zoe/chat", { query: "Where does zoe live?" });
    home = await c.b.get("/app");
    expect(home.html).toContain('data-checklist="complete"');
    expect(home.html).toContain("You're set up.");

    // The 30-day activity charts, from the same data.
    const days = lastDays(30);
    expect(home.html).toContain('<figure class="chart tone-amber">');
    expect(home.html).toContain('<figure class="chart tone-sky">');
    expect(home.html).toContain(`<title>${shortDay(days[27]!)} · 3 messages</title>`);
    expect(home.html).toContain(`<title>${shortDay(days[29]!)} · 2 messages</title>`);
    expect(home.html).toContain(`<title>${shortDay(days[29]!)} · 1 question</title>`);
    expect(home.html).toMatch(
      /<span class="chart-title">Questions answered<\/span>\s*<span class="chart-total">1<\/span>/,
    );
    expect(home.html).toMatch(
      /<span class="chart-title">Messages<\/span>\s*<span class="chart-total">5<\/span>/,
    );
    // Balance and charges stay.
    expect(home.html).toContain("Credit balance");
    expect(home.html).toContain("Charges this month by task");
  });

  it("charts usage by day and keeps the table", async () => {
    const r = await A.b.get("/app/usage");
    expect(r.res.status).toBe(200);
    expect(r.html).toMatch(/<span class="chart-title">Charged<\/span>/);
    expect(r.html).toMatch(/<span class="chart-title">Questions answered<\/span>/);
    expect(r.html).toMatch(/<title>[A-Z][a-z]{2} \d+ · \$[\d.]+ charged<\/title>/);
    expect(r.html).toContain("<th>Tokens learned</th>");
    expect(r.html).not.toContain("Model calls");
  });
});

describe("dashboard security for the new pages", () => {
  it("redirects signed-out visitors and refuses signed-out questions", async () => {
    const anon = new Browser(s.app, "198.18.0.9");
    for (const p of [
      "/app/memory",
      "/app/memory/notes",
      "/app/memory/notes/peers/alice",
      "/app/memory/notes/sessions/chat-1",
      "/app/playground",
    ]) {
      const r = await anon.get(p);
      expect(r.res.status, p).toBe(303);
      expect(r.res.headers.get("location")).toBe("/app/login");
    }
    await anon.get("/app/login");
    const r = await anon.post("/app/playground", { ws: "notes", peer: "alice", query: "x" });
    expect(r.res.status).toBe(401);
  });

  it("serves the optional script under the CSP and inlines none", async () => {
    const page = await A.b.get("/app/memory/notes/peers/alice");
    const csp = page.res.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(page.html).toContain('<script src="/app/static/app.js" defer></script>');
    expect(page.html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(page.html).not.toMatch(/\sstyle="/);
    const js = await A.b.get("/app/static/app.js");
    expect(js.res.headers.get("content-type")).toContain("javascript");
    expect(js.html).toContain("pre[data-copy]");
  });
});

describe("tenant isolation in the explorer and playground", () => {
  const B_SECRETS = ["bob-secret", "tangerine", "Oslo", "b-private", "carol", "Initech", "b-chat"];

  it("A's pages never show B's data, though both have a workspace called notes", async () => {
    for (const p of [
      "/app",
      "/app/memory",
      "/app/memory/notes",
      "/app/memory/notes/sessions",
      "/app/memory/notes/peers/alice?state=all&observer=*",
      "/app/memory/notes/sessions/chat-1?preview=1&tokens=100000&peer_target=alice",
      "/app/playground",
      "/app/playground?ws=b-private",
      "/app/usage",
    ]) {
      const r = await A.b.get(p);
      expect(r.res.status, p).toBe(200);
      for (const secret of B_SECRETS) expect(r.html, `${p} leaked ${secret}`).not.toContain(secret);
    }
    // And B sees its own "notes", not A's.
    const bNotes = await B.b.get("/app/memory/notes");
    expect(bNotes.html).toContain("bob-secret");
    expect(bNotes.html).not.toContain("alice");
  });

  it("guessing B's workspace, peer, session or message ids answers 404", async () => {
    for (const p of [
      "/app/memory/b-private",
      "/app/memory/b-private/sessions",
      "/app/memory/b-private/peers/carol",
      "/app/memory/b-private/sessions/b-hidden",
      "/app/memory/notes/peers/bob-secret",
      "/app/memory/notes/sessions/b-chat",
      "/app/memory/notes/sessions/b-chat?preview=1&tokens=500",
    ]) {
      const r = await A.b.get(p);
      expect(r.res.status, p).toBe(404);
      for (const secret of ["tangerine", "Oslo", "Initech"]) expect(r.html).not.toContain(secret);
    }
    // A message id of B's in A's session URL selects nothing of B's.
    const bMsg = await messageId(B.id, "I live in Oslo. My hint is tangerine.");
    const jump = await A.b.get(`/app/memory/notes/sessions/chat-1?at=${bMsg}`);
    expect(jump.res.status).toBe(200);
    expect(jump.html).not.toContain("tangerine");
    expect(jump.html).not.toContain(bMsg);
  });

  it("A cannot ask about B's peers, and nobody is charged for trying", async () => {
    const aBefore = await chats(A.id);
    const bBefore = await chats(B.id);
    await A.b.get("/app/playground");
    const attempts = [
      ["/app/memory/notes/peers/bob-secret/ask", {}],
      ["/app/memory/b-private/peers/carol/ask", {}],
      ["/app/playground", { ws: "b-private", peer: "carol" }],
      ["/app/playground", { ws: "notes", peer: "bob-secret" }],
    ] as const;
    for (const [path, extra] of attempts) {
      const r = await A.b.post(path, { query: "What is the hint?", level: "low", ...extra });
      expect(r.res.status, path).toBe(404);
      expect(r.html).not.toContain("tangerine");
    }
    expect(await chats(A.id)).toEqual(aBefore);
    expect(await chats(B.id)).toEqual(bBefore);
    // Nothing was created in A's account by the attempts.
    expect(
      await rows(
        s.ctx.db,
        sql`SELECT 1 FROM peers p JOIN workspaces w ON w.id = p.workspace_id
            WHERE w.account_id = ${A.id} AND p.name IN ('bob-secret', 'carol')`,
      ),
    ).toHaveLength(0);
    expect(
      await rows(
        s.ctx.db,
        sql`SELECT 1 FROM workspaces WHERE account_id = ${A.id} AND name = 'b-private'`,
      ),
    ).toHaveLength(0);
  });
});
