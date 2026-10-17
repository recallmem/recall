import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createTestServer } from "./helpers.js";

/**
 * The context bill (public/calculator.html, written by scripts/site/pages.py): the page is
 * rendered with a default scenario in Python and public/calculator.js recomputes it in the
 * browser, so the two must agree, at the configured prices.
 */

const SERVER = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(SERVER, path), "utf8");

type Scenario = Record<(typeof FIELDS)[number], number>;
type Bill = {
  naive: number[];
  memory: number[];
  naiveTotal: number;
  memoryTotal: number;
  naiveMonth: number;
  memoryMonth: number;
  forgetsOn: number | null;
  crossover: number | null;
};
type Calculator = {
  bill: (s: Scenario, prices: { ingest: number; minTokens: number }) => Bill;
  money: (x: number) => string;
  steps: (values: number[], max: number, w: number, h: number) => string;
};
const FIELDS = ["users", "msgs", "tokens", "days", "price", "window", "cached"] as const;

function loadCalculator(): Calculator {
  const mod = { exports: {} as Calculator };
  new Function("module", read("public/calculator.js"))(mod);
  return mod.exports;
}

type Server = Awaited<ReturnType<typeof createTestServer>>;
let s: Server;
let html: string;
beforeAll(async () => {
  s = await createTestServer();
  const res = await s.app.request("/calculator");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  html = await res.text();
});
afterAll(() => s.close());

describe("context bill", () => {
  it("is a canonical page of the site with its script, and the CDN serves both", async () => {
    expect(html).toContain('<link rel="canonical" href="https://recallmem.dev/calculator" />');
    expect(html).toContain('<script src="/calculator.js" defer></script>');
    expect(html).not.toContain('style="');
    const js = await s.app.request("/calculator.js");
    expect(js.headers.get("content-type")).toContain("text/javascript");
    // It stores nothing and sends nothing.
    const code = read("public/calculator.js");
    for (const call of [
      "fetch(",
      "XMLHttpRequest",
      "localStorage",
      "sendBeacon",
      "document.cookie",
    ])
      expect(code, call).not.toContain(call);
    const vercel = JSON.parse(read("vercel.json")) as { headers: { source: string }[] };
    const sources = vercel.headers.map((r) => r.source);
    expect(sources.find((r) => r.startsWith("/:page("))).toMatch(/[(|]calculator[|)]/);
    expect(sources.find((r) => r.startsWith("/:file("))).toContain("calculator\\.js");
    // Linked from the site's footer and from llms.txt.
    const evals = await (await s.app.request("/evals")).text();
    expect(evals).toContain('<a href="/calculator">Context bill</a>');
    const llms = await (await s.app.request("/llms.txt")).text();
    expect(llms).toContain("(https://recallmem.dev/calculator)");
  });

  it("shows the numbers its script computes for the default scenario, at the configured prices", () => {
    const { prices } = loadConfig({ RECALL_DATA_DIR: "memory" }).hosted.billing;
    const ingest = prices.ingestPerMTokMicros / 1e6;
    expect(html).toContain(`data-ingest="${ingest}" data-min-tokens="${prices.ingestMinTokens}"`);
    const scenario = Object.fromEntries(
      FIELDS.map((f) => {
        const m = new RegExp(`name="${f}" value="([\\d.]+)"`).exec(html);
        expect(m, f).not.toBeNull();
        return [f, Number(m![1])];
      }),
    ) as Scenario;
    const calc = loadCalculator();
    const b = calc.bill(scenario, { ingest, minTokens: prices.ingestMinTokens });
    const out = (k: string) => new RegExp(`data-out="${k}"[^>]*>([^<]*)<`).exec(html)?.[1];
    expect(out("naive-total")).toBe(calc.money(b.naiveTotal));
    expect(out("memory-total")).toBe(calc.money(b.memoryTotal));
    expect(out("naive-month")).toBe(calc.money(b.naiveMonth));
    expect(out("memory-month")).toBe(calc.money(b.memoryMonth));
    expect(out("crossover")).toBe(
      `From day ${b.crossover}, each day of re-sending costs more than a day with memory.`,
    );
    expect(out("forgets")).toContain(`after ${scenario.days} days.`);
    const top = Math.max(...b.naive, ...b.memory);
    expect(out("chart-max")).toBe(`${calc.money(top)} a day`);
    for (const [cls, values] of [
      ["bill-naive", b.naive],
      ["bill-memory", b.memory],
    ] as const)
      expect(html, cls).toContain(
        `<polyline class="${cls}" points="${calc.steps(values, top, 600, 180)}" />`,
      );
    const ratio = Math.round(b.naiveTotal / b.memoryTotal);
    expect(out("verdict")).toBe(`Re-sending costs ${ratio}× as much over ${scenario.days} days.`);
  });

  it("charges memory for learning each message once and the history only up to the window", () => {
    const calc = loadCalculator();
    const prices = { ingest: 1.75, minTokens: 50 };
    const base = { users: 1, msgs: 2, tokens: 10, days: 1, price: 0, window: 1000, cached: 0 };
    // With a free model, all that is left is Recall learning: 2 messages at the 50-token minimum.
    expect(calc.bill(base, prices).memoryTotal).toBeCloseTo((2 * 50 * 1.75) / 1e6, 12);
    expect(calc.bill(base, prices).naiveTotal).toBe(0);
    // Re-sending stops growing once the history fills the window, and says when that happens.
    const long = calc.bill({ ...base, msgs: 100, tokens: 100, days: 5, price: 1 }, prices);
    expect(long.forgetsOn).toBe(1);
    expect(new Set(long.naive.slice(1)).size).toBe(1);
    // A full prompt-cache discount makes re-sending free.
    expect(calc.bill({ ...base, price: 3, days: 30, cached: 100 }, prices).naiveTotal).toBe(0);
    expect(calc.money(0)).toBe("$0");
    expect(calc.money(0.004)).toBe("< $0.01");
    expect(calc.money(0.42)).toBe("$0.42");
    expect(calc.money(1234.5)).toBe("$1,235");
    expect(calc.money(5_600_000)).toBe("$5.6M");
    expect(calc.money(56_000_000)).toBe("$56M");
  });
});
