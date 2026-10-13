import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import lme from "../fixtures/longmemeval-sample.json" with { type: "json" };
import { HttpError, MemoryApi, waitUntilIdle } from "../src/client.js";
import { planDataset } from "../src/datasets/index.js";
import { LexicalJudge } from "../src/judge.js";
import { buildResults, renderComparison, renderMarkdown } from "../src/report.js";
import {
  EMPTY_ANSWER,
  judgeAnswer,
  judgingNeeded,
  qualityDrop,
  type RunOptions,
  runAll,
} from "../src/runner.js";
import { type FakeOptions, type FakeServer, startFakeServer } from "./fake-server.js";

let fake: FakeServer | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
  runId: "t1",
  dataset: "longmemeval",
  level: "medium",
  concurrency: 2,
  questionConcurrency: 1,
  drainTimeoutMs: 10_000,
  chatTimeoutMs: 5_000,
  observeOthers: false,
  dream: false,
  cleanup: true,
  meterUsage: true,
  pollMs: 20,
  stallMs: 200,
  log: () => undefined,
  ...over,
});

async function fixtureFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "run-"));
  const file = join(dir, "lme.json");
  await writeFile(file, JSON.stringify(lme));
  return file;
}

async function run(fakeOpts: FakeOptions, runOpts: Partial<RunOptions> = {}) {
  fake = await startFakeServer(fakeOpts);
  const api = new MemoryApi(fake.url, "secret-key");
  const units = await planDataset("longmemeval", {}, await fixtureFile());
  const out = await runAll(api, new LexicalJudge(), units, opts(runOpts));
  return { api, ...out };
}

describe("runner against a Recall-like server", () => {
  it("ingests with original timestamps, waits for idle, asks at the configured level, judges and meters", async () => {
    const { records, units } = await run({
      mode: "recall",
      busyPolls: 2,
      answer: (_peer, q) =>
        q.includes("degree")
          ? "You graduated in Business Administration."
          : "You never mentioned that.",
    });
    const f = fake as FakeServer;

    // One isolated workspace per question, named after the run.
    expect(units.map((u) => u.workspace).sort()).toEqual([
      "ev-t1-lme-q-degree",
      "ev-t1-lme-q-hamster_abs",
      "ev-t1-lme-q-update",
    ]);
    expect(units.every((u) => u.error === null && u.cleanedUp === true)).toBe(true);

    // Messages carry their original timestamps, sessions arrive in chronological order.
    const posts = f.calls.filter(
      (c) => c.method === "POST" && c.path.endsWith("/messages") && c.path.includes("q-degree"),
    );
    expect(posts.map((p) => p.body.messages[0].created_at)).toEqual([
      "2023-05-20T02:21:00.000Z",
      "2023-05-21T09:00:00.000Z",
    ]);
    expect(posts[0]?.headers["idempotency-key"]).toBeTruthy();
    expect(posts[0]?.headers.authorization).toBe("Bearer secret-key");

    // Chat uses the user peer and the requested level; queue is polled until idle before chatting.
    const chat = f.calls.find((c) => c.path.endsWith("/chat"));
    expect(chat?.body).toMatchObject({ reasoning_level: "medium", stream: false });
    const firstChat = f.calls.findIndex(
      (c) => c.path.includes("q-degree") && c.path.endsWith("/chat"),
    );
    const lastStatus = f.calls
      .map((c, i) => (c.path.includes("q-degree") && c.path.endsWith("/queue/status") ? i : -1))
      .filter((i) => i >= 0)
      .at(-1) as number;
    expect(lastStatus).toBeLessThan(firstChat);
    expect(f.calls.find((c) => c.path.endsWith("/queue/status"))?.path).toContain("q-");

    // Judged: the abstention question is correct because the answer declines.
    const byId = Object.fromEntries(records.map((r) => [r.id, r]));
    expect(byId["q-degree"]).toMatchObject({
      correct: true,
      category: "single-session-user",
      abstained: false,
    });
    expect(byId["q-hamster_abs"]).toMatchObject({ correct: true, category: "abstention" });
    expect(byId["q-update"]).toMatchObject({ correct: false, category: "knowledge-update" });
    expect(records.every((r) => (r.latencyMs ?? -1) >= 0)).toBe(true);

    // Usage snapshots were taken after ingest and at the end.
    const u = units[0];
    expect(u?.usageAfterIngest?.by_task.chat_low).toBeUndefined();
    expect(u?.usageFinal?.by_task.chat_low?.calls).toBe(1);

    const results = buildResults(
      {
        label: "fake-recall",
        note: null,
        startedAt: "2026-01-01T00:00:00Z",
        finishedAt: "2026-01-01T00:01:00Z",
        target: { url: (fake as FakeServer).url, authenticated: true },
        dataset: "longmemeval",
        selection: {
          limit: null,
          offset: 0,
          types: null,
          order: "stratified",
          questions: 3,
          units: 3,
        },
        level: "medium",
        concurrency: 2,
        questionConcurrency: 1,
        observeOthers: false,
        dream: false,
        judge: { kind: "lexical-offline", model: "none" },
        costModel: "recall-metered",
      },
      records,
      units,
    );
    const s = results.summary;
    expect(s.accuracy.overall).toMatchObject({ n: 3, correct: 2 });
    expect(s.accuracy.abstention).toMatchObject({ n: 1, correct: 1 });
    expect(s.accuracy.answerable).toMatchObject({ n: 2, correct: 1 });
    expect(s.ingest.messages).toBe(8); // the blank turn is dropped
    // Per workspace: background 0.0021 USD, one chat 0.001 USD; three workspaces.
    expect(s.cost.ingestUsd).toBeCloseTo(3 * 0.0021, 6);
    expect(s.cost.queryUsd).toBeCloseTo(3 * 0.001, 6);
    expect(s.cost.llmCallsPer100Messages).toBeCloseTo((3 * 2) / (8 / 100), 4); // embedding excluded
    expect(s.cost.chatCallsPerQuery).toBe(1);
    expect(s.cost.honchoListPrice.queryUsd).toBeCloseTo(3 * 0.05, 6); // medium
    expect(results.settings.serverModels?.reasoner).toEqual(["fake/m1"]);

    const md = renderMarkdown(results);
    for (const heading of [
      "## Settings",
      "## Accuracy",
      "## Latency (chat)",
      "## Ingestion",
      "## Cost",
    ])
      expect(md).toContain(heading);
    expect(md).toContain("single-session-user");
    expect(md).toContain("NOT an accuracy measurement");
  });
});

describe("runner against a Honcho-like server", () => {
  it("polls plain counts, has no usage endpoint, and estimates cost from the price list", async () => {
    const { records, units, api } = await run(
      { mode: "honcho", busyPolls: 3 },
      { meterUsage: false },
    );
    expect(units.every((u) => u.usageAfterIngest === null && u.error === null)).toBe(true);
    expect(await api.usage("anything")).toBeNull();
    expect(records).toHaveLength(3);
    // Needed two idle readings in a row: busy polls (3) plus at least 2 idle ones.
    const polls = (fake as FakeServer).workspaces;
    expect(polls.size).toBe(0); // cleaned up

    const results = buildResults(
      {
        label: "fake-honcho",
        note: null,
        startedAt: "a",
        finishedAt: "b",
        target: { url: "x", authenticated: false },
        dataset: "longmemeval",
        selection: {
          limit: null,
          offset: 0,
          types: null,
          order: "stratified",
          questions: 3,
          units: 3,
        },
        level: "low",
        concurrency: 2,
        questionConcurrency: 1,
        observeOthers: false,
        dream: false,
        judge: { kind: "lexical-offline", model: "none" },
        costModel: "honcho-list-estimate",
      },
      records,
      units,
    );
    const c = results.summary.cost;
    const tokens = results.summary.ingest.tokens;
    expect(c.ingestUsd).toBeCloseTo((tokens / 1_000_000) * 2, 8);
    expect(c.queryUsd).toBeCloseTo(3 * 0.01, 8);
    expect(c.llmCallsPer100Messages).toBeNull();
    expect(renderMarkdown(results)).toContain("Estimated from Honcho's published list price");
  });

  it("does not infer idleness while work is in progress", async () => {
    fake = await startFakeServer({ mode: "honcho", busyPolls: 1_000_000 });
    const api = new MemoryApi(fake.url);
    await api.createWorkspace("w", {});
    const busy = await waitUntilIdle(api, "w", { timeoutMs: 400, pollMs: 20, stallMs: 100 });
    expect(busy.idle).toBe(false);
  });

  it("keeps waiting through status polls that time out or come back 503", async () => {
    let calls = 0;
    const api = {
      async queueStatus() {
        calls++;
        if (calls === 1)
          throw new Error("GET /queue/status failed: The operation was aborted due to timeout");
        if (calls === 2) throw new HttpError(503, "GET", "/queue/status", "busy");
        return { idle: true };
      },
    } as unknown as MemoryApi;
    const r = await waitUntilIdle(api, "w", { timeoutMs: 5_000, pollMs: 10 });
    expect(r.idle).toBe(true);
    expect(calls).toBe(3);
    const gone = {
      async queueStatus() {
        throw new HttpError(404, "GET", "/queue/status", "Workspace not found");
      },
    } as unknown as MemoryApi;
    await expect(waitUntilIdle(gone, "w", { timeoutMs: 5_000, pollMs: 10 })).rejects.toThrow("404");
  });

  it("treats counts frozen with nothing in progress (e.g. a dream due in an hour) as idle after the stall window", async () => {
    fake = await startFakeServer({ mode: "honcho", stuckPending: true });
    const api = new MemoryApi(fake.url);
    await api.createWorkspace("w", {});
    const r = await waitUntilIdle(api, "w", { timeoutMs: 5_000, pollMs: 20, stallMs: 150 });
    expect(r).toMatchObject({ idle: true, stalled: true });
  });
});

describe("failure handling", () => {
  it("records a failed chat as an error that counts as wrong", async () => {
    const { records } = await run({ mode: "recall", failChat: true });
    expect(records).toHaveLength(3);
    expect(records.every((r) => r.error?.startsWith("chat failed") && r.correct === false)).toBe(
      true,
    );
  });

  it("with strictDrain, fails a workspace still processing at the drain timeout and keeps it", async () => {
    const busy = { mode: "recall", busyPolls: 10_000 } as const;
    const strict = await run(busy, { drainTimeoutMs: 300, strictDrain: true, cleanup: false });
    expect(strict.units.every((u) => u.error?.includes("not idle after 0.3s"))).toBe(true);
    expect(strict.records.every((r) => r.correct === false && r.answer === null)).toBe(true);
    expect(fake?.calls.some((c) => c.path.endsWith("/chat"))).toBe(false);
    expect(fake?.calls.some((c) => c.method === "DELETE")).toBe(false);
    await fake?.close();

    // Without it the questions are asked anyway (the drain is only recorded as timed out).
    const lax = await run(busy, { drainTimeoutMs: 300 });
    expect(lax.units.every((u) => u.error === null && u.drainTimedOut)).toBe(true);
  });

  it("counts every question of a workspace whose ingest failed as an error", async () => {
    const { records, units } = await run({ mode: "recall", failMessages: true });
    expect(units.every((u) => u.error !== null)).toBe(true);
    expect(records).toHaveLength(3);
    expect(records.every((r) => r.correct === false && r.error?.includes("workspace failed"))).toBe(
      true,
    );
  });
});

describe("--reuse", () => {
  it("asks again in kept workspaces without ingesting or deleting them, and ingests missing ones", async () => {
    fake = await startFakeServer({ mode: "recall" });
    const f = fake;
    const api = new MemoryApi(f.url);
    const units = await planDataset("longmemeval", {}, await fixtureFile());
    const posts = () =>
      f.calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages")).length;

    // First run keeps its workspaces.
    const first = await runAll(api, new LexicalJudge(), units, opts({ cleanup: false }));
    expect(first.units.every((u) => !u.reused && u.cleanedUp === null)).toBe(true);
    const ingested = posts();
    expect(ingested).toBeGreaterThan(0);

    // One workspace disappears; the reuse run re-ingests only that one.
    f.workspaces.delete("ev-t1-lme-q-update");
    const second = await runAll(
      api,
      new LexicalJudge(),
      units,
      opts({ reuse: true, cleanup: true }),
    );
    const byUnit = new Map(second.units.map((u) => [u.unit, u]));
    expect(byUnit.get("lme-q-degree")?.reused).toBe(true);
    expect(byUnit.get("lme-q-update")?.reused).toBeUndefined();
    expect(second.units.every((u) => u.error === null && u.cleanedUp === null)).toBe(true);
    expect(f.workspaces.size).toBe(3);
    expect(second.records.length).toBe(first.records.length);
    expect(second.records.every((r) => r.answer !== null && r.error === null)).toBe(true);
    const reingested = posts() - ingested;
    expect(reingested).toBeGreaterThan(0);
    expect(reingested).toBeLessThan(ingested);
    const messages = byUnit.get("lme-q-degree")?.messages ?? 0;
    expect(messages).toBe(first.units.find((u) => u.unit === "lme-q-degree")?.messages);
  });

  it("refuses a workspace that holds only part of the messages", async () => {
    fake = await startFakeServer({ mode: "recall" });
    const f = fake;
    const api = new MemoryApi(f.url);
    const units = await planDataset("longmemeval", {}, await fixtureFile());
    await runAll(api, new LexicalJudge(), units, opts({ cleanup: false }));
    const ws = f.workspaces.get("ev-t1-lme-q-degree");
    const [, session] = [...(ws?.sessions ?? new Map()).entries()][0] ?? [];
    session?.pop();
    const posted = f.calls.length;

    const again = await runAll(api, new LexicalJudge(), units, opts({ reuse: true }));
    const unit = again.units.find((u) => u.unit === "lme-q-degree");
    expect(unit?.error).toMatch(/holds \d+ of the unit's \d+ messages/);
    expect(again.records.filter((r) => r.unit === "lme-q-degree").every((r) => r.error)).toBe(true);
    // Nothing was ingested into it, and no workspace was deleted.
    const later = f.calls.slice(posted);
    expect(later.some((c) => c.path.includes("q-degree") && c.path.endsWith("/messages"))).toBe(
      false,
    );
    expect(later.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("answer quality guard", () => {
  const rec = (correct: boolean, error: string | null = null) => ({ correct, error });
  const ok = (n: number, correctShare: number) =>
    Array.from({ length: n }, (_, i) => rec(i < Math.round(n * correctShare)));

  it("records an empty reply as a failed request that counts as wrong", async () => {
    const { records } = await run({ mode: "recall", answer: () => "" });
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.error === EMPTY_ANSWER && r.correct === false)).toBe(true);
  });

  it("trips on empty answers in the last window", () => {
    const guard = { window: 40, maxEmptyShare: 0.1, maxAccuracyDrop: 0.3 };
    expect(qualityDrop(ok(39, 0.9), guard)).toBeNull();
    const empties = Array.from({ length: 4 }, () => rec(false, EMPTY_ANSWER));
    expect(qualityDrop([...ok(36, 0.9), ...empties], guard)).toBe(
      "4 of the last 40 answers were empty",
    );
    expect(qualityDrop([...ok(37, 0.9), ...empties.slice(1)], guard)).toBeNull();
  });

  it("trips when accuracy falls far below the first window, and ignores other failures", () => {
    const guard = { window: 40, maxEmptyShare: 0.1, maxAccuracyDrop: 0.3 };
    expect(qualityDrop([...ok(40, 0.9), ...ok(40, 0.5)], guard)).toBe(
      "accuracy fell from 90% (first 40 answers) to 50% (last 40)",
    );
    expect(qualityDrop([...ok(40, 0.9), ...ok(40, 0.7)], guard)).toBeNull();
    // A failed workspace is the failure breaker's business, not a sign of bad answers.
    const failed = Array.from({ length: 40 }, () => rec(false, "workspace failed: x"));
    expect(qualityDrop([...ok(40, 0.9), ...failed, ...ok(40, 0.9)], guard)).toBeNull();
    expect(qualityDrop([...ok(40, 0.9), ...ok(40, 0.1)], { ...guard, window: 0 })).toBeNull();
  });
});

describe("judging again", () => {
  it("finds the answers whose judge call failed and judges only those afterwards", async () => {
    fake = await startFakeServer({ mode: "recall" });
    const api = new MemoryApi(fake.url, "secret-key");
    const units = await planDataset("longmemeval", {}, await fixtureFile());
    // The judge's account ran out of credit during the run.
    const lexical = new LexicalJudge();
    const broke = Object.assign(Object.create(lexical), {
      judge: async () => {
        throw new Error("429 You have no credits remaining");
      },
    });
    const { records } = await runAll(api, broke, units, opts());
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(r.correct).toBeNull();
      expect(r.judgeReason).toContain("judge failed: 429");
      expect(judgingNeeded(r, "rubric")).toEqual({ rubric: true, beam: false });
    }
    const questions = new Map(
      (await Promise.all(units.map((u) => u.load()))).flatMap((u) =>
        u.questions.map((q) => [q.id, q]),
      ),
    );
    for (const r of records)
      await judgeAnswer(lexical, r, questions.get(r.id)!, "rubric", judgingNeeded(r, "rubric"));
    for (const r of records) {
      expect(typeof r.correct).toBe("boolean");
      expect(r.judgeReason).not.toContain("judge failed");
      expect(judgingNeeded(r, "rubric")).toEqual({ rubric: false, beam: false });
    }
  });
});

describe("cleanup", () => {
  it("lists a kept workspace's sessions so they can be deleted before the workspace", async () => {
    const { api, units } = await run({ mode: "recall" }, { cleanup: false });
    const ws = units[0]!.workspace;
    await expect(api.deleteWorkspace(ws)).rejects.toThrow("409");
    const sessions = await api.listSessions(ws);
    expect(sessions.length).toBe(units[0]!.sessions);
    for (const s of sessions) await api.deleteSession(ws, s);
    await api.deleteWorkspace(ws);
    expect(fake?.workspaces.has(ws)).toBe(false);
  });
});

describe("compare", () => {
  it("renders aligned tables and flags runs that are not comparable", async () => {
    const { records, units } = await run({ mode: "recall" });
    const base = {
      note: null,
      startedAt: "a",
      finishedAt: "b",
      target: { url: "x", authenticated: false },
      dataset: "longmemeval" as const,
      selection: {
        limit: null,
        offset: 0,
        types: null,
        order: "stratified" as const,
        questions: 3,
        units: 3,
      },
      concurrency: 2,
      questionConcurrency: 1,
      observeOthers: false,
      dream: false,
      judge: { kind: "llm" as const, model: "openai/gpt-5-mini" },
    };
    const a = buildResults(
      { ...base, label: "recall", level: "low", costModel: "recall-metered" },
      records,
      units,
    );
    const b = buildResults(
      { ...base, label: "honcho", level: "low", costModel: "honcho-list-estimate" },
      records,
      units,
    );
    const same = renderComparison(a, b);
    expect(same).not.toContain("Not directly comparable");
    expect(same).toContain("| Question type | recall | honcho |");
    expect(same).toContain("measured");
    expect(same).toContain("estimated");

    const c = buildResults(
      { ...base, label: "honcho", level: "high", costModel: "honcho-list-estimate" },
      records,
      units,
    );
    expect(renderComparison(a, c)).toContain("Not directly comparable");
  });
});
