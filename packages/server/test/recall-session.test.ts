import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestServer } from "./api-helpers.js";
import { seedWorld } from "./recall-helpers.js";

type Ctx = {
  id: string;
  messages: { content: string; token_count: number }[];
  summary: { summary_type: string; token_count: number; content: string } | null;
  peer_representation: string | null;
  peer_card: string[] | null;
};

describe("recall: session context and summaries", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  beforeAll(async () => {
    server = await createTestServer();
    await seedWorld(server.ctx);
  });
  afterAll(() => server.close());

  const ctxOf = async (qs = "", session = "s1") => {
    const res = await server.request("GET", `/v3/workspaces/acme/sessions/${session}/context${qs}`);
    return { res, json: (await res.json()) as Ctx };
  };

  it("uses the long summary and the messages from its boundary onward (boundary message repeated)", async () => {
    const { json } = await ctxOf();
    expect(json.id).toBe("s1");
    expect(json.summary?.summary_type).toBe("honcho_chat_summary_long");
    expect(json.messages.map((m) => m.content)).toEqual(["Rover would like that."]);
    expect(json.peer_representation).toBeNull();
    expect(json.peer_card).toBeNull();
  });

  it("spends the whole budget on messages when the summary is off, newest first, returned oldest first", async () => {
    const { json } = await ctxOf("?summary=false&tokens=60");
    expect(json.summary).toBeNull();
    const total = json.messages.reduce((n, m) => n + m.token_count, 0);
    expect(total).toBeLessThanOrEqual(60);
    expect(json.messages.at(-1)!.content).toBe("Rover would like that.");
    expect(json.messages.length).toBeGreaterThan(2);
    const all = (await ctxOf("?summary=false")).json.messages.map((m) => m.content);
    expect(all.length).toBe(12);
    expect(all[0]).toContain("Amsterdam");
  });

  it("falls back to the short summary when the long one exceeds 40% of the budget, and to none below that", async () => {
    const long = (await ctxOf()).json.summary!.token_count;
    const { json } = await ctxOf(`?tokens=${Math.ceil((long - 1) / 0.4)}`);
    expect(json.summary?.summary_type).toBe("honcho_chat_summary_short");
    const tiny = await ctxOf("?tokens=20");
    expect(tiny.json.summary).toBeNull();
    expect((await ctxOf("?tokens=0")).json.messages).toEqual([]);
  });

  it("adds the representation and card for a peer_target and charges them to the budget", async () => {
    const { json } = await ctxOf("?peer_target=alice&summary=false&tokens=2000");
    expect(json.peer_representation).toContain("Alice lives in Utrecht");
    expect(json.peer_card).toContain("Has a dog named Rover");
    const limited = (await ctxOf("?peer_target=alice&limit_to_session=true&tokens=2000")).json;
    expect(limited.peer_card).toBeNull();
    expect(limited.peer_representation).not.toContain("Japan");
    const starved = (await ctxOf("?peer_target=alice&tokens=40")).json;
    expect(starved.messages).toEqual([]);
    expect(starved.summary).toBeNull();
  });

  it("validates parameter combinations with the documented messages", async () => {
    const detail = async (qs: string) =>
      ((await ctxOf(qs)).json as unknown as { detail: string }).detail;
    expect(await detail("?peer_perspective=bob")).toBe(
      "peer_target must be provided if peer_perspective is provided",
    );
    expect(await detail("?scope=x")).toBe("peer_target must be provided if scope is provided");
    expect(await detail("?peer_target=alice&scope=x&peer_perspective=bob")).toBe(
      "`scope` and `peer_perspective` are mutually exclusive",
    );
    expect(await detail("?sessions=s1")).toBe(
      "peer_target must be provided if sessions is provided",
    );
    expect(await detail("?peer_target=alice&sessions=s2")).toBe(
      "session_id must be included in sessions",
    );
    expect(await detail("?peer_target=alice&sessions=s1&limit_to_session=true")).toBe(
      "`sessions` and `limit_to_session` are mutually exclusive",
    );
    expect((await ctxOf("?tokens=100001")).res.status).toBe(422);
  });

  it("returns an empty context for unknown sessions and serves summaries", async () => {
    const empty = await ctxOf("", "nope");
    expect(empty.res.status).toBe(200);
    expect(empty.json).toEqual({
      id: "nope",
      messages: [],
      summary: null,
      peer_representation: null,
      peer_card: null,
    });
    const res = await server.request("GET", "/v3/workspaces/acme/sessions/s1/summaries");
    const s = (await res.json()) as {
      id: string;
      short_summary: { summary_type: string };
      long_summary: { message_id: string };
    };
    expect(s.id).toBe("s1");
    expect(s.short_summary.summary_type).toBe("honcho_chat_summary_short");
    expect(s.long_summary.message_id).toHaveLength(21);
    const none = (await (
      await server.request("GET", "/v3/workspaces/acme/sessions/s2/summaries")
    ).json()) as Record<string, unknown>;
    expect(none).toEqual({ id: "s2", short_summary: null, long_summary: null });
  });
});
