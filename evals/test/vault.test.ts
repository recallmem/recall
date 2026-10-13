import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault, vaultName } from "../src/vault.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let root: string;
let remote: string;
let checkout: string;

/** A clone with one commit on main, pushed to a bare remote. */
async function makeRepo(name: string): Promise<string> {
  const dir = join(root, name);
  git(root, "clone", "-q", remote, dir);
  git(dir, "config", "user.email", "bench@example.com");
  git(dir, "config", "user.name", "Bench");
  return dir;
}

async function makeRun(name: string, extra: Record<string, string> = {}): Promise<string> {
  const dir = join(root, "scratch", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({ runId: "abc", startedAt: "2026-10-10T05:00:00Z" }),
  );
  await writeFile(join(dir, "records.jsonl"), '{"id":"q1"}\n{"id":"q2"}\n');
  await writeFile(join(dir, "secret.env"), "KEY=do-not-copy\n");
  for (const [f, text] of Object.entries(extra)) await writeFile(join(dir, f), text);
  return dir;
}

const results = (accuracy: number) =>
  JSON.stringify({
    schema: 1,
    settings: {
      label: "recall-lme",
      note: "hosted",
      dataset: "longmemeval",
      beamSplit: null,
      startedAt: "2026-10-10T05:00:00Z",
      finishedAt: "2026-10-10T06:00:00Z",
    },
    summary: {
      accuracy: { overall: { n: 2, correct: 1, accuracy, ci95: null, errors: 0, unjudged: 0 } },
    },
    units: [],
    records: [],
  });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vault-"));
  remote = join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "main", seed);
  git(seed, "config", "user.email", "bench@example.com");
  git(seed, "config", "user.name", "Bench");
  await writeFile(join(seed, "README.md"), "main\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main");
  checkout = await makeRepo("checkout");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("vault", () => {
  it("names runs after their directory, dated by run.json", () => {
    expect(vaultName("/x/lme-s500", "2026-10-10T05:00:00Z")).toBe("2026-10-10-lme-s500");
    expect(vaultName("/x/2026-09-01-abc-recall", "2026-10-10T05:00:00Z")).toBe(
      "2026-09-01-abc-recall",
    );
    expect(vaultName("/x/odd name!", null)).toBe("odd-name-");
  });

  it("pushes a run to the bench-results branch, only the harness's files, with an index", async () => {
    const vault = await Vault.open({ repo: checkout, log: () => undefined, pushDelaysMs: [] });
    expect(vault).not.toBeNull();
    const dir = await makeRun("lme-s500", { "results.json": results(0.5) });
    expect(await vault?.save(dir)).toBe(true);

    const files = git(remote, "ls-tree", "-r", "--name-only", "bench-results").trim().split("\n");
    expect(files.sort()).toEqual([
      "README.md",
      "packages/server/vercel.json",
      "runs/2026-10-10-lme-s500/records.jsonl",
      "runs/2026-10-10-lme-s500/results.json",
      "runs/2026-10-10-lme-s500/run.json",
    ]);
    // Vercel must not spend a deployment on every save.
    expect(JSON.parse(git(remote, "show", "bench-results:packages/server/vercel.json"))).toEqual({
      git: { deploymentEnabled: false },
    });
    const index = git(remote, "show", "bench-results:README.md");
    expect(index).toContain("| 2026-10-10-lme-s500 | longmemeval | 50.0% of 2 | 0 |");
    // main is untouched
    expect(git(remote, "ls-tree", "--name-only", "main").trim()).toBe("README.md");
  });

  it("indexes a run that has not finished, and saves again without a new commit when nothing changed", async () => {
    const vault = await Vault.open({ repo: checkout, log: () => undefined, pushDelaysMs: [] });
    const dir = await makeRun("beam-wip");
    await vault?.save(dir);
    const before = git(remote, "rev-parse", "bench-results").trim();
    await vault?.save(dir);
    expect(git(remote, "rev-parse", "bench-results").trim()).toBe(before);
    expect(git(remote, "show", "bench-results:README.md")).toContain("not finished: 2 answered");
  });

  it("merges with runs another machine pushed meanwhile", async () => {
    const other = await makeRepo("other");
    const a = await Vault.open({ repo: checkout, log: () => undefined, pushDelaysMs: [] });
    await a?.save(await makeRun("first", { "results.json": results(0.5) }));
    const b = await Vault.open({ repo: other, log: () => undefined, pushDelaysMs: [] });
    await b?.save(await makeRun("second", { "results.json": results(1) }));
    // a's checkout is now behind: its next save has to rebase onto b's run
    expect(
      await a?.save(await makeRun("third", { "results.json": results(0) }), { name: "third" }),
    ).toBe(true);

    const files = git(remote, "ls-tree", "-r", "--name-only", "bench-results");
    expect(files).toContain("runs/2026-10-10-first/results.json");
    expect(files).toContain("runs/2026-10-10-second/results.json");
    expect(files).toContain("runs/third/results.json");
    const index = git(remote, "show", "bench-results:README.md");
    for (const name of ["2026-10-10-first", "2026-10-10-second", "third"])
      expect(index).toContain(`| ${name} |`);
  });

  it("lets two processes that share a checkout save at the same time", async () => {
    // Two Vault objects on one checkout stand in for two harness processes.
    const a = await Vault.open({ repo: checkout, log: () => undefined, pushDelaysMs: [] });
    const b = await Vault.open({ repo: checkout, log: () => undefined, pushDelaysMs: [] });
    const [x, y] = await Promise.all([
      a?.save(await makeRun("left", { "results.json": results(0.5) })),
      b?.save(await makeRun("right", { "results.json": results(1) })),
    ]);
    expect([x, y]).toEqual([true, true]);
    const files = git(remote, "ls-tree", "-r", "--name-only", "bench-results");
    expect(files).toContain("runs/2026-10-10-left/results.json");
    expect(files).toContain("runs/2026-10-10-right/results.json");
  });

  it("reports a failed save instead of throwing", async () => {
    const lines: string[] = [];
    const vault = await Vault.open({ repo: checkout, log: (l) => lines.push(l), pushDelaysMs: [] });
    expect(await vault?.save(join(root, "missing"))).toBe(false);
    expect(lines.join("\n")).toMatch(/could not save/);
    expect(await readFile(join(checkout, "README.md"), "utf8")).toBe("main\n");
  });

  it("pushes nothing to a remote without the branch unless asked to create it", async () => {
    // What the harness does without --vault: a fresh clone or a fork is left alone...
    expect(await Vault.open({ repo: checkout, create: false, log: () => undefined })).toBeNull();
    expect(git(remote, "branch", "--list", "bench-results").trim()).toBe("");
    expect(git(checkout, "worktree", "list")).not.toContain(".vault");
    // ...while a remote that already has the branch keeps receiving runs.
    const first = await Vault.open({ repo: checkout, log: () => undefined, pushDelaysMs: [] });
    await first?.save(await makeRun("seeded", { "results.json": results(0.5) }));
    const other = await makeRepo("other");
    const again = await Vault.open({
      repo: other,
      create: false,
      log: () => undefined,
      pushDelaysMs: [],
    });
    expect(again).not.toBeNull();
    expect(await again?.save(await makeRun("later", { "results.json": results(1) }))).toBe(true);
    expect(git(remote, "ls-tree", "-r", "--name-only", "bench-results")).toContain(
      "runs/2026-10-10-later/results.json",
    );
  });

  it("is unavailable outside a git checkout", async () => {
    const plain = await mkdtemp(join(tmpdir(), "plain-"));
    try {
      expect(await Vault.open({ repo: plain })).toBeNull();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
