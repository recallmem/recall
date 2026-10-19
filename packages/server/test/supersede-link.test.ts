import { afterEach, describe, expect, it } from "vitest";
import type { LlmRequest } from "../src/llm/types.js";
import { drainQueue } from "../src/queue/worker.js";
import { linkChanges } from "../src/reasoner/apply.js";
import { parseTranscript } from "../src/reasoner/offline.js";
import type { ExtractionOut, FactOut } from "../src/reasoner/prompt.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";

/**
 * A new value said in passing ("hoping to beat my best of 25:50") must replace the stored one.
 * The extractor lists the known facts each message changes before it writes the facts; when it
 * then writes the new value as "add", the listed change still supersedes the old fact.
 */

const fact = (over: Partial<FactOut>): FactOut => ({
  about: "alice",
  content: "",
  event_start: null,
  event_end: null,
  tags: [],
  level: "explicit",
  category: "other",
  confidence: 1,
  importance: 3,
  source_messages: [1],
  action: "add",
  target: null,
  ...over,
});

describe("linkChanges", () => {
  const plan = fact({ content: "alice is training for another charity 5K run" });
  const best = fact({ content: "alice's personal best 5K time is 25:50" });
  const change = { message: 1, target: "F6", now: "5K personal best is 25:50" };

  it("turns the add that states a listed change into its supersede", () => {
    const out = linkChanges([change], [plan, best]);
    expect(out.map((f) => [f.action, f.target])).toEqual([
      ["add", null],
      ["supersede", "F6"],
    ]);
    // The model's output is not changed in place.
    expect(best.action).toBe("add");
  });

  it("leaves a target the model already superseded or reinforced", () => {
    for (const action of ["supersede", "reinforce"] as const) {
      const done = fact({ content: "alice's 5K best is 25:50", action, target: "F6" });
      const out = linkChanges([change], [done, best]);
      expect(out.filter((f) => f.target === "F6")).toHaveLength(1);
      expect(out[1]!.action).toBe("add");
    }
  });

  it("needs every number of the new value", () => {
    const other = fact({ content: "alice's personal best 5K time is 24:10" });
    const out = linkChanges([change], [other]);
    expect(out[0]!.action).toBe("add");
  });

  it("prefers the add citing the listed message, else takes one citing a repeat", () => {
    const repeat = fact({
      content: "alice's personal best 5K time is 25:50",
      source_messages: [3],
    });
    const out = linkChanges([change], [repeat, best]);
    expect(out.map((f) => f.action)).toEqual(["add", "supersede"]);
    expect(linkChanges([change], [repeat])[0]!.target).toBe("F6");
  });

  it("needs most words of the new value", () => {
    const out = linkChanges(
      [{ message: 1, target: "F2", now: "lives in Porto with sister Lina" }],
      [fact({ content: "alice's sister Lina visits on Friday" })],
    );
    expect(out[0]!.action).toBe("add");
  });
});

let s: ApiServer | null = null;
afterEach(async () => {
  s?.ctx.llm.mock.respondWith(null);
  await s?.close();
  s = null;
});

const WS = "link";

/** Known facts shown to the extraction call, by handle. */
function known(req: LlmRequest): { handle: string; content: string }[] {
  const out: { handle: string; content: string }[] = [];
  for (const line of (req.context ?? "").split("\n")) {
    const m = line.match(/^(F\d+) \d{4}-\d{2}-\d{2} (?:event \S+(?: to \S+)? )?(.*)$/);
    if (m) out.push({ handle: m[1]!, content: m[2]! });
  }
  return out;
}

/** A model that lists the change but writes the new best as "add", as Haiku does on busy windows. */
function listsButAdds() {
  return (req: LlmRequest) => {
    const out: ExtractionOut = {
      changes: [],
      facts: [],
      cards: [],
      synopsis: null,
      short_summary: null,
    };
    if (req.task !== "reasoner") return { json: out };
    for (const line of parseTranscript(req.messages.map((m) => m.content).join("\n"))) {
      const m = line.text.match(/(\d+:\d+)/);
      if (!m || line.context) continue;
      const old = known(req).find((k) => /5K/.test(k.content));
      if (old) out.changes.push({ message: line.n, target: old.handle, now: `5K best is ${m[1]}` });
      out.facts.push(
        fact({ content: `alice's 5K personal best is ${m[1]}`, source_messages: [line.n] }),
      );
    }
    return { json: out };
  };
}

describe("a change said in passing", () => {
  it("supersedes the stored value even when the model wrote it as add", async () => {
    s = await createTestServer({
      RECALL_REASONER_MAX_DELAY_MS: "0",
      RECALL_SUMMARIES_ENABLED: "false",
      RECALL_DREAMS_ENABLED: "false",
    });
    const srv = s;
    await srv.request("POST", "/v3/workspaces", { id: WS });
    await srv.request("POST", `/v3/workspaces/${WS}/peers`, { id: "alice" });
    srv.ctx.llm.mock.respondWith(listsButAdds());
    const say = async (content: string, at: string) => {
      const r = await srv.request("POST", `/v3/workspaces/${WS}/sessions/s1/messages`, {
        messages: [{ peer_id: "alice", content, created_at: at }],
      });
      expect(r.status).toBe(201);
      await drainQueue(srv.ctx);
    };
    await say("Ran the charity 5K in 27:12, a new best!", "2023-05-23T13:00:00Z");
    await say(
      "Training for another 5K. Hoping to beat my personal best of 25:50 this time.",
      "2023-05-30T13:00:00Z",
    );
    const r = await srv.request("POST", `/v3/workspaces/${WS}/conclusions/list`, {});
    const items = (await r.json()).items as { content: string; valid_to: string | null }[];
    const current = items.filter((f) => f.valid_to === null).map((f) => f.content);
    expect(current).toEqual(["alice's 5K personal best is 25:50"]);
  });
});
