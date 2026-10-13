import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clipInput, MAX_ECHO_CHARS, ValidationError } from "../src/http/validate.js";
import { ApiError, MAX_DETAIL_CHARS } from "../src/lib/errors.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";

/**
 * An error says which value was wrong without sending a huge value back: echoed 422 inputs are
 * cut to about 200 characters, and one-sentence messages to 500, on every route.
 */
describe("validation errors", () => {
  let s: ApiServer;
  beforeAll(async () => {
    s = await createTestServer();
  });
  afterAll(() => s.close());

  const huge = "x".repeat(50_000);
  const errorOf = async (res: Response | Promise<Response>) => {
    const r = await res;
    expect(r.status).toBe(422);
    const text = await r.text();
    return { text, detail: JSON.parse(text).detail as { input: unknown; loc: unknown[] }[] };
  };

  it("cuts a long string to about 200 characters with an ellipsis", async () => {
    const { text, detail } = await errorOf(
      s.request("POST", "/v3/workspaces/w/sessions/s/messages", {
        messages: [{ peer_id: "alice", content: huge }],
      }),
    );
    expect(detail[0]!.loc).toEqual(["body", "messages", 0, "content"]);
    expect(detail[0]!.input).toBe(`${"x".repeat(MAX_ECHO_CHARS)}…`);
    expect(text.length).toBeLessThan(1000);
  });

  it("cuts long values inside an echoed object or list too", async () => {
    const { text, detail } = await errorOf(
      s.request("POST", "/v3/workspaces/w/conclusions", {
        conclusions: [
          { content: { pasted: huge, more: [huge, huge] }, observer_id: "a", observed_id: "b" },
        ],
      }),
    );
    expect(detail[0]!.loc).toEqual(["body", "conclusions", 0, "content"]);
    expect(JSON.stringify(detail[0]!.input).length).toBeLessThan(400);
    expect((detail[0]!.input as { pasted: string }).pasted).toMatch(/^x+…$/);
    expect(text.length).toBeLessThan(1000);
  });

  it("cuts the body of a request that is not JSON, and query parameters", async () => {
    const res = await s.app.request("/v3/workspaces/w/sessions/s/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"messages": "${huge}`,
    });
    const { text, detail } = await errorOf(res);
    expect(detail[0]!.loc).toEqual(["body"]);
    expect((detail[0]!.input as string).length).toBeLessThanOrEqual(MAX_ECHO_CHARS + 1);
    expect(text.length).toBeLessThan(1000);

    const query = await errorOf(
      s.request("POST", `/v3/workspaces/w/peers/list?page=${"9".repeat(5000)}x`, {}),
    );
    expect(String(query.detail[0]!.input).length).toBeLessThanOrEqual(MAX_ECHO_CHARS + 1);
  });

  it("cuts a long value quoted in a one-sentence error", async () => {
    const res = await s.request("POST", "/v3/workspaces/w/peers/list", {
      filters: { [`k${"x".repeat(900)}`]: 1 },
    });
    expect(res.status).toBe(422);
    const { detail } = (await res.json()) as { detail: string };
    expect(detail.startsWith("Column 'kxxx")).toBe(true);
    expect(detail.length).toBe(MAX_DETAIL_CHARS + 1);
    expect(detail.endsWith("…")).toBe(true);
    expect(new ApiError(404, "Peer alice not found").detail).toBe("Peer alice not found");
  });

  it("leaves short values exactly as they were sent", () => {
    expect(clipInput("short")).toBe("short");
    expect(clipInput({ a: 1, b: [true, null, "x"] })).toEqual({ a: 1, b: [true, null, "x"] });
    expect(clipInput(null)).toBeNull();
    const many = Array.from({ length: 500 }, (_, i) => i);
    const clipped = clipInput(many) as unknown[];
    expect(clipped.length).toBeLessThan(many.length);
    expect(clipped.at(-1)).toBe("…");
    const err = new ValidationError([{ type: "t", loc: ["body"], msg: "m", input: huge }]);
    expect(err.detail[0]!.input).toBe(`${"x".repeat(MAX_ECHO_CHARS)}…`);
  });
});
