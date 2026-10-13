import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "meter-proxy.mjs");

let upstream: Server | undefined;
let proxy: ChildProcess | undefined;
afterEach(async () => {
  proxy?.kill();
  proxy = undefined;
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  upstream = undefined;
});

/** A local stand-in for OpenAI that answers with a usage block; the proxy never leaves the machine. */
async function start(budget: number, details: Record<string, number> = { cached_tokens: 200_000 }) {
  const seen: string[] = [];
  upstream = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        usage: {
          prompt_tokens: 1_000_000,
          completion_tokens: 100_000,
          prompt_tokens_details: details,
        },
      }),
    );
  });
  await new Promise<void>((r) => upstream?.listen(0, "127.0.0.1", r));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const dir = await mkdtemp(join(tmpdir(), "meter-"));
  const log = join(dir, "spend.jsonl");
  // find a free port by letting the OS pick one first
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  proxy = spawn(
    process.execPath,
    [PROXY, String(port), log, "--budget-usd", String(budget), "--upstream", upstreamUrl],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/__meter`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { base: `http://127.0.0.1:${port}`, log, seen };
}

interface Meter {
  spentUsd: number;
}

/** Reads the whole body: the proxy logs a call before it ends the response, so afterwards the log is complete. */
async function call(base: string, model: string) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  });
  return { status: res.status, body: await res.text() };
}

describe("meter proxy", () => {
  it("prices every call from the price list, logs it, and refuses calls once the cap is reached", async () => {
    // gpt-4.1: 800k uncached x $2 + 200k cached x $0.5 + 100k out x $8 = 1.6 + 0.1 + 0.8 = $2.50 per call
    const { base, log, seen } = await start(4);
    const first = await call(base, "gpt-4.1");
    expect(first.status).toBe(200);
    const spent = async () => ((await (await fetch(`${base}/__meter`)).json()) as Meter).spentUsd;
    expect(await spent()).toBeCloseTo(2.5, 9);

    expect((await call(base, "gpt-4.1-2025-04-14")).status).toBe(200); // dated ids use the base price
    expect(await spent()).toBeCloseTo(5, 9);

    // over the cap now: refused locally, never forwarded
    const refused = await call(base, "gpt-4.1");
    expect(refused.status).toBe(402);
    expect((JSON.parse(refused.body) as { error: { code: string } }).error.code).toBe(
      "budget_exhausted",
    );
    expect(seen).toHaveLength(2);

    const lines = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      model: "gpt-4.1",
      prompt_tokens: 1_000_000,
      cached_tokens: 200_000,
      completion_tokens: 100_000,
      priced: true,
    });
    expect(lines[0].cost_usd).toBeCloseTo(2.5, 9);
    expect(lines[2]).toMatchObject({ status: 402, blocked: true, cost_usd: 0 });
  });

  it("bills cache writes at the model's write rate (GPT-5.6+), and as input where there is none", async () => {
    const { base, log } = await start(100, { cached_tokens: 200_000, cache_write_tokens: 300_000 });
    expect((await call(base, "gpt-6-luna")).status).toBe(200);
    expect((await call(base, "gpt-4.1")).status).toBe(200);
    const [luna, older] = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(luna).toMatchObject({ cached_tokens: 200_000, cache_write_tokens: 300_000 });
    // A 1M-token prompt is long context (2x input and cache rates, 1.5x output):
    // 500k x $0.20 + 200k cached x $0.02 + 300k written x $0.25 + 100k out x $0.75
    expect(luna.cost_usd).toBeCloseTo(0.1 + 0.004 + 0.075 + 0.075, 9);
    // gpt-4.1 has no write rate: 800k x $2 + 200k cached x $0.5 + 100k out x $8
    expect(older.cost_usd).toBeCloseTo(2.5, 9);
  });

  it("flags models it has no price for instead of silently counting them as free", async () => {
    const { base, log } = await start(100);
    expect((await call(base, "some-new-model")).status).toBe(200);
    const [line] = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(line).toMatchObject({ priced: false, cost_usd: 0 });
  });
});
