import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { splitContent } from "../src/types.js";
import { mapPool, percentile, scanJsonArray, slug, wilson95 } from "../src/util.js";

describe("percentile", () => {
  it("uses nearest rank", () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("wilson95", () => {
  it("brackets the observed rate and is wide for small n", () => {
    const [lo, hi] = wilson95(8, 10) as [number, number];
    expect(lo).toBeLessThan(0.8);
    expect(hi).toBeGreaterThan(0.8);
    expect(hi - lo).toBeGreaterThan(0.3);
    expect(wilson95(0, 0)).toBeNull();
    expect(wilson95(10, 10)?.[1]).toBeCloseTo(1, 5);
  });
});

describe("mapPool", () => {
  it("keeps input order and never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(2);
  });
});

describe("scanJsonArray", () => {
  it("finds top-level objects, ignoring braces and quotes inside strings and multi-byte text", async () => {
    const items = [
      { a: 'has "quotes" and } braces { and \\ slashes', b: [1, { c: 2 }] },
      { a: "héllo wörld — ✓", b: [] },
      { a: "plain", b: [{}] },
    ];
    const dir = await mkdtemp(join(tmpdir(), "scan-"));
    const file = join(dir, "x.json");
    const text = JSON.stringify(items, null, 2);
    await writeFile(file, text);
    const spans = await scanJsonArray(file);
    expect(spans).toHaveLength(3);
    const buf = Buffer.from(text);
    expect(spans.map((s) => JSON.parse(buf.subarray(s.start, s.end).toString()))).toEqual(items);
  });
});

describe("splitContent", () => {
  it("leaves short text alone and splits long text under the limit at natural breaks", () => {
    expect(splitContent("short", 100)).toEqual(["short"]);
    const long = Array.from({ length: 30 }, (_, i) => `paragraph ${i} ${"x".repeat(40)}`).join(
      "\n\n",
    );
    const parts = splitContent(long, 300);
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.every((p) => p.length <= 300)).toBe(true);
    expect(parts.join("\n\n")).toBe(long);
  });
});

describe("slug", () => {
  it("produces valid resource ids", () => {
    expect(slug("Mélanie O'Neil")).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(slug("conv-26")).toBe("conv-26");
  });
});
