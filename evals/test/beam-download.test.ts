import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BEAM_KEPT_FIELDS, downloadBeam } from "../src/download.js";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

interface Api {
  base: string;
  requests: string[];
}

/** A stand-in for the Hugging Face datasets-server `/rows` endpoint. */
async function fakeApi(
  handler: (offset: number, attempt: number) => { status: number; body: string },
): Promise<Api> {
  const requests: string[] = [];
  const attempts = new Map<number, number>();
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    const url = new URL(req.url ?? "/", "http://x");
    const offset = Number(url.searchParams.get("offset"));
    const attempt = (attempts.get(offset) ?? 0) + 1;
    attempts.set(offset, attempt);
    const { status, body } = handler(offset, attempt);
    res.writeHead(status, { "content-type": status === 200 ? "application/json" : "text/html" });
    res.end(body);
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const row = (i: number) => ({
  conversation_id: String(i + 1),
  conversation_seed: { title: `t${i}` },
  narratives: "scaffolding that must not be stored",
  conversation_plan: "plan: the answers could leak from here",
  user_questions: [["a copy of the user turns"]],
  chat: [[{ role: "user", content: `hello ${i}` }]],
  probing_questions: "{'abstention': []}",
});
const ok = (i: number, total = 3, extra: object = {}) => ({
  status: 200,
  body: JSON.stringify({
    rows: [{ row_idx: i, row: row(i), truncated_cells: [], ...extra }],
    num_rows_total: total,
  }),
});

describe("downloading BEAM", () => {
  it("fetches one conversation per request, keeps only the fields the harness uses, and retries transient errors", async () => {
    const api = await fakeApi((i, attempt) =>
      i === 1 && attempt === 1 ? { status: 502, body: "<html>Bad gateway</html>" } : ok(i),
    );
    const dir = await mkdtemp(join(tmpdir(), "beam-dl-"));
    const logs: string[] = [];
    const res = await downloadBeam("100k", {
      apiBase: api.base,
      dir,
      backoffMs: 1,
      approxBytes: 10,
      log: (l) => logs.push(l),
    });
    expect(res.skipped).toBe(false);
    const rows = JSON.parse(await readFile(res.path, "utf8")) as Record<string, unknown>[];
    expect(rows).toHaveLength(3); // the server's total wins over the expected 20
    expect(Object.keys(rows[0] as object)).toEqual(BEAM_KEPT_FIELDS);
    expect(rows.map((r) => r.conversation_id)).toEqual(["1", "2", "3"]);
    expect(JSON.stringify(rows)).not.toContain("scaffolding");
    expect(JSON.stringify(rows)).not.toContain("could leak");
    // 3 conversations, one of them fetched twice
    expect(api.requests).toHaveLength(4);
    expect(api.requests[0]).toContain("dataset=Mohammadta%2FBEAM");
    expect(api.requests[0]).toContain("split=100K");
    expect(logs.some((l) => l.includes("expected 20"))).toBe(true);

    // already complete: no further requests
    const again = await downloadBeam("100k", {
      apiBase: api.base,
      dir,
      backoffMs: 1,
      approxBytes: 10,
    });
    expect(again.skipped).toBe(true);
    expect(api.requests).toHaveLength(4);
  });

  it("refuses to store a conversation the API truncated, and leaves no partial file", async () => {
    const api = await fakeApi((i) => ok(i, 3, { truncated_cells: ["chat"] }));
    const dir = await mkdtemp(join(tmpdir(), "beam-dl-"));
    await expect(
      downloadBeam("100k", { apiBase: api.base, dir, backoffMs: 1, approxBytes: 10 }),
    ).rejects.toThrow(/truncated cells/);
    await expect(readFile(join(dir, "beam-100k.json"))).rejects.toThrow();
    await expect(readFile(join(dir, "beam-100k.json.part"))).rejects.toThrow();
    expect(api.requests).toHaveLength(1); // not retried: it will not get better
  });

  it("gives up after the configured attempts", async () => {
    const api = await fakeApi(() => ({ status: 503, body: "busy" }));
    const dir = await mkdtemp(join(tmpdir(), "beam-dl-"));
    await expect(
      downloadBeam("100k", { apiBase: api.base, dir, backoffMs: 1, attempts: 3, approxBytes: 10 }),
    ).rejects.toThrow(/row 0 of Mohammadta\/BEAM\/100K: HTTP 503/);
    expect(api.requests).toHaveLength(3);
  });

  it("explains how to get the 10M split, which the datasets-server cannot serve", async () => {
    const api = await fakeApi(() => ({ status: 500, body: "row group too big" }));
    const dir = await mkdtemp(join(tmpdir(), "beam-dl-"));
    await expect(
      downloadBeam("10m", { apiBase: api.base, dir, backoffMs: 1, attempts: 1, approxBytes: 10 }),
    ).rejects.toThrow(/beam-parquet-to-json\.py/);
  });
});
