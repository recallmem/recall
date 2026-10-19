import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { rows } from "../src/db/client.js";
import {
  closedAt,
  describeEventTime,
  endedBy,
  eventTime,
  laterState,
  parseEventDate,
  sameOccurrence,
} from "../src/lib/event-time.js";
import type { LlmRequest } from "../src/llm/types.js";
import { drainQueue } from "../src/queue/worker.js";
import { parseTranscript } from "../src/reasoner/offline.js";
import type { ExtractionOut, FactOut } from "../src/reasoner/prompt.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";

/**
 * Event time: when what a fact describes happened or began, kept apart from when it was said.
 * Extraction fills it, updates order states by it, and separate dated occurrences never fold into
 * one fact or replace each other.
 */

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("event time helpers", () => {
  it("parses dates as precise as they are written", () => {
    expect(parseEventDate("2025-05-27")).toEqual({ at: d("2025-05-27"), precision: "day" });
    expect(parseEventDate("2025-05")).toEqual({ at: d("2025-05-01"), precision: "month" });
    expect(parseEventDate("2025")).toEqual({ at: d("2025-01-01"), precision: "year" });
    expect(parseEventDate("2025-05-27T18:30:00Z")).toEqual({
      at: d("2025-05-27"),
      precision: "day",
    });
    for (const bad of ["2025-02-30", "2025-13", "May 2025", "", "0999", "25-05-27", null])
      expect(parseEventDate(bad)).toBeNull();
  });

  it("keeps an end only when it reaches past the start's own period", () => {
    expect(eventTime("2025-05-26", "2025-06-01")).toEqual({
      start: d("2025-05-26"),
      end: d("2025-06-01"),
      precision: "day",
    });
    // A month end is that month's last day.
    expect(eventTime("2025-03", "2025-05")?.end).toEqual(d("2025-05-31"));
    // An end inside the start's month, or before the start, adds nothing.
    expect(eventTime("2025-05", "2025-05-20")?.end).toBeNull();
    expect(eventTime("2025-05-26", "2025-05-01")?.end).toBeNull();
    expect(eventTime(null, "2025-05-01")).toBeNull();
    expect(describeEventTime(eventTime("2025-05-26", "2025-06-01")!)).toBe(
      "2025-05-26 to 2025-06-01",
    );
    expect(describeEventTime(eventTime("2025-05", null)!)).toBe("2025-05");
  });

  it("tells occurrences apart by whether their spans overlap", () => {
    const may = eventTime("2025-05", null)!;
    expect(sameOccurrence(may, eventTime("2025-05-14", null)!)).toBe(true);
    expect(sameOccurrence(may, eventTime("2025-06-02", null)!)).toBe(false);
    expect(
      sameOccurrence(eventTime("2025-05-26", "2025-06-01")!, eventTime("2025-06-01", null)!),
    ).toBe(true);
  });

  it("orders states by when they began only when both facts know it", () => {
    const fact = (category: string, said: string, event: string | null) => ({
      category,
      validFrom: d(said),
      event: eventTime(event, null),
    });
    const paris = fact("state", "2025-03-01", "2025-02");
    const berlin = fact("state", "2025-06-01", "2024-01");
    // Said later, but began earlier: the Berlin fact is the older state.
    expect(laterState(berlin, paris)).toBe(false);
    expect(laterState(paris, berlin)).toBe(true);
    // Without an event date on one side, the time it was said decides.
    expect(laterState(fact("state", "2025-06-01", null), paris)).toBe(true);
    // A plan's date is when it happens, not when it began: the newer statement wins.
    const tripJuly = fact("plan", "2025-03-01", "2025-07-10");
    const tripJune = fact("plan", "2025-04-01", "2025-06-12");
    expect(laterState(tripJune, tripJuly)).toBe(true);
    // A closed fact never stops holding before it was said.
    expect(closedAt(berlin, paris)).toEqual(d("2025-06-01"));
    expect(closedAt(fact("state", "2024-01-01", null), paris)).toEqual(d("2025-02-01"));
    // A replaced state ends the day before its successor began, when that adds anything.
    expect(endedBy(berlin, paris)).toEqual(d("2025-01-31"));
    expect(endedBy(paris, berlin)).toBeNull();
    expect(
      endedBy(fact("state", "2025-01-01", "2025-02"), fact("state", "2025-03-01", "2025-02-20")),
    ).toBeNull();
  });
});

type Server = ApiServer;
let s: Server | null = null;
afterEach(async () => {
  s?.ctx.llm.mock.respondWith(null);
  await s?.close();
  s = null;
});

const start = async () => {
  s = await createTestServer({
    RECALL_REASONER_MAX_DELAY_MS: "0",
    RECALL_SUMMARIES_ENABLED: "false",
    RECALL_DREAMS_ENABLED: "false",
  });
  return s;
};

async function post(srv: Server, session: string, content: string, at: string) {
  const r = await srv.request("POST", `/v3/workspaces/ev/sessions/${session}/messages`, {
    messages: [{ peer_id: "alice", content, created_at: at }],
  });
  expect(r.status).toBe(201);
  await drainQueue(srv.ctx);
}

/** Known facts the extraction call was shown: handle, and the event marker if any. */
function knownFacts(req: LlmRequest): { handle: string; event: string | null; content: string }[] {
  const out: { handle: string; event: string | null; content: string }[] = [];
  for (const line of (req.context ?? "").split("\n")) {
    const m = line.match(/^(F\d+) \d{4}-\d{2}-\d{2} (?:event (\S+(?: to \S+)?) )?(.*)$/);
    if (m) out.push({ handle: m[1]!, event: m[2] ?? null, content: m[3]! });
  }
  return out;
}

/** An extractor that turns each scripted line into the given fact. */
function script(
  answer: (text: string, known: ReturnType<typeof knownFacts>) => Partial<FactOut> | null,
) {
  return async (req: LlmRequest) => {
    const out: ExtractionOut = {
      changes: [],
      facts: [],
      cards: [],
      synopsis: null,
      short_summary: null,
    };
    if (req.task !== "reasoner") return { json: out };
    const facts = knownFacts(req);
    const transcript = req.messages.map((m) => m.content).join("\n");
    for (const line of parseTranscript(transcript)) {
      if (line.context) continue;
      const f = answer(line.text, facts);
      if (!f) continue;
      out.facts.push({
        about: line.peer,
        content: "",
        level: "explicit",
        category: "state",
        confidence: 1,
        importance: 3,
        source_messages: [line.n],
        event_start: null,
        event_end: null,
        tags: [],
        action: "add",
        target: null,
        ...f,
      });
    }
    return { json: out };
  };
}

interface Row {
  content: string;
  valid_to: Date | null;
  superseded_by: string | null;
  event_start: Date | string | null;
  event_end: Date | string | null;
  event_precision: string | null;
  times_derived: number;
}
const facts = (srv: Server) =>
  rows<Row>(
    srv.ctx.db,
    sql`SELECT c.content, c.valid_to, c.superseded_by, c.event_start, c.event_end, c.event_precision, c.times_derived
        FROM conclusions c JOIN peers p ON p.id = c.observed_id
        WHERE p.name = 'alice' AND c.observer_id = c.observed_id AND c.deleted_at IS NULL
        ORDER BY c.created_at, c.id`,
  );

describe("event time in the reasoner", () => {
  it("stores the event time the extraction gives, shows it to later calls, and returns it", async () => {
    const srv = await start();
    let seen: ReturnType<typeof knownFacts> = [];
    srv.ctx.llm.mock.respondWith(
      script((text, k) => {
        if (/moved to Paris/.test(text))
          return {
            content: "alice moved to Paris in the week of 2025-05-26",
            event_start: "2025-05-26",
            event_end: "2025-06-01",
          };
        seen = k;
        return null;
      }),
    );
    await post(srv, "s1", "We moved to Paris last week!", "2025-06-03T08:00:00Z");
    await post(srv, "s1", "Settling in slowly.", "2025-06-04T08:00:00Z");
    expect(seen.find((f) => f.content.includes("Paris"))?.event).toBe("2025-05-26 to 2025-06-01");

    const list = await srv.request("POST", "/v3/workspaces/ev/conclusions/list", {});
    const [c] = (await list.json()).items;
    expect(c).toMatchObject({
      content: "alice moved to Paris in the week of 2025-05-26",
      event_start: "2025-05-26",
      event_end: "2025-06-01",
      event_precision: "day",
    });
    // Filters reach the event time.
    const inMay = await srv.request("POST", "/v3/workspaces/ev/conclusions/list", {
      filters: { event_start: { gte: "2025-05-01", lt: "2025-06-01" } },
    });
    expect((await inMay.json()).items).toHaveLength(1);
    const inApril = await srv.request("POST", "/v3/workspaces/ev/conclusions/list", {
      filters: { event_start: { lt: "2025-05-01" } },
    });
    expect((await inApril.json()).items).toHaveLength(0);
  });

  it("keeps separate dated occurrences apart, even when the model calls them a restatement", async () => {
    const srv = await start();
    srv.ctx.llm.mock.respondWith(
      script((text, k) => {
        const m = text.match(/gym on (\S+)/);
        if (!m) return null;
        const earlier = k.find((f) => f.content === "alice went to the gym");
        return {
          content: "alice went to the gym",
          category: "event",
          event_start: m[1]!,
          action: earlier ? "reinforce" : "add",
          target: earlier?.handle ?? null,
        };
      }),
    );
    await post(srv, "s1", "Went to the gym on 2025-06-02", "2025-06-02T19:00:00Z");
    await post(srv, "s1", "Went to the gym on 2025-06-05", "2025-06-05T19:00:00Z");
    // The same occurrence told again is a restatement.
    await post(srv, "s1", "Like I said, gym on 2025-06-05", "2025-06-06T09:00:00Z");
    const all = await facts(srv);
    expect(
      all.map((f) => [
        new Date(f.event_start!).toISOString().slice(0, 10),
        Number(f.times_derived),
      ]),
    ).toEqual([
      ["2025-06-02", 1],
      ["2025-06-05", 2],
    ]);
    expect(all.every((f) => f.valid_to === null)).toBe(true);
  });

  it("never lets one dated event replace another", async () => {
    const srv = await start();
    srv.ctx.llm.mock.respondWith(
      script((text, k) => {
        const m = text.match(/dentist on (\S+)/);
        if (!m) return null;
        const earlier = k.find((f) => f.content.startsWith("alice saw the dentist"));
        return {
          content: `alice saw the dentist on ${m[1]}`,
          category: "event",
          event_start: m[1]!,
          action: earlier ? "supersede" : "add",
          target: earlier?.handle ?? null,
        };
      }),
    );
    await post(srv, "s1", "Saw the dentist on 2025-03-04", "2025-03-04T12:00:00Z");
    await post(srv, "s1", "Back at the dentist on 2025-09-10", "2025-09-10T12:00:00Z");
    const all = await facts(srv);
    expect(all).toHaveLength(2);
    expect(all.every((f) => f.valid_to === null && f.superseded_by === null)).toBe(true);
  });

  it("files a past state learned late as history, closed where the newer state began", async () => {
    const srv = await start();
    srv.ctx.llm.mock.respondWith(
      script((text, k) => {
        if (/live in Paris/.test(text))
          return { content: "alice lives in Paris", event_start: "2025-02" };
        if (/lived in Berlin/.test(text)) {
          const paris = k.find((f) => f.content.includes("Paris"));
          return {
            content: "alice lived in Berlin",
            event_start: "2019",
            action: "supersede",
            target: paris?.handle ?? null,
          };
        }
        return null;
      }),
    );
    await post(srv, "s1", "I live in Paris now, since February", "2025-03-01T10:00:00Z");
    await post(srv, "s2", "Fun fact, I lived in Berlin from 2019", "2025-06-01T10:00:00Z");
    const all = await facts(srv);
    const paris = all.find((f) => f.content.includes("Paris"))!;
    const berlin = all.find((f) => f.content.includes("Berlin"))!;
    expect(paris.valid_to).toBeNull();
    expect(berlin.valid_to).not.toBeNull();
    expect(berlin.event_precision).toBe("year");
    // It ended the day before the Paris state began.
    expect(new Date(berlin.event_end!).toISOString().slice(0, 10)).toBe("2025-01-31");
  });

  it("moves a plan by the newer statement, whatever its date", async () => {
    const srv = await start();
    srv.ctx.llm.mock.respondWith(
      script((text, k) => {
        const m = text.match(/trip (?:is )?on (\S+)/);
        if (!m) return null;
        const earlier = k.find((f) => f.content.startsWith("alice plans a trip"));
        return {
          content: `alice plans a trip to Rome on ${m[1]}`,
          category: "plan",
          event_start: m[1]!,
          action: earlier ? "supersede" : "add",
          target: earlier?.handle ?? null,
        };
      }),
    );
    await post(srv, "s1", "Rome trip on 2025-07-10", "2025-03-01T10:00:00Z");
    await post(srv, "s1", "Change of plans, the trip is on 2025-06-12", "2025-04-01T10:00:00Z");
    const all = await facts(srv);
    const current = all.filter((f) => f.valid_to === null).map((f) => f.content);
    expect(current).toEqual(["alice plans a trip to Rome on 2025-06-12"]);
  });
});

describe("event time on explicit conclusions", () => {
  it("accepts event_start and event_end, and refuses dates it cannot read", async () => {
    const srv = await start();
    await srv.request("POST", "/v3/workspaces/ev/peers", { id: "alice" });
    const create = (body: Record<string, unknown>) =>
      srv.request("POST", "/v3/workspaces/ev/conclusions", {
        conclusions: [{ observer_id: "alice", observed_id: "alice", ...body }],
      });
    const ok = await create({
      content: "alice studied in Leiden",
      event_start: "2015",
      event_end: "2019",
    });
    expect(ok.status).toBe(201);
    expect((await ok.json())[0]).toMatchObject({
      event_start: "2015",
      event_end: "2019-12-31",
      event_precision: "year",
    });
    const plain = await create({ content: "alice likes tea" });
    expect((await plain.json())[0]).toMatchObject({
      event_start: null,
      event_end: null,
      event_precision: null,
    });
    // Saying it again with a date fills in the date it lacked.
    const again = await create({ content: "alice likes tea", event_start: "2020-04" });
    expect((await again.json())[0]).toMatchObject({
      event_start: "2020-04",
      event_precision: "month",
    });

    expect((await create({ content: "x", event_start: "last May" })).status).toBe(422);
    expect((await create({ content: "x", event_start: "2025-02-30" })).status).toBe(422);
    expect((await create({ content: "x", event_end: "2025-02-03" })).status).toBe(422);
  });
});
