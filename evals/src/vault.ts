/**
 * Optional: keeps benchmark results safe from the machine they ran on. Every run directory is
 * copied into `runs/<name>/` on the orphan branch `bench-results` of the checkout's `origin` and
 * pushed, during the run (checkpoints) and when it ends, so a lost container or a deleted scratch
 * folder no longer loses a paid run. The branch's README.md indexes every run with its score.
 *
 * The harness only pushes there when asked (`--vault`, which creates the branch) or when origin
 * already has the branch (a repository set up for it); a fresh clone or fork pushes nothing.
 *
 * The branch is checked out as a git worktree in `evals/.vault/` (ignored by the main branch).
 * Only the harness's own output files are copied, never anything else in the run directory.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Results } from "./results.js";
import { sleep } from "./util.js";

/** The Vercel project's root directory, and the config that turns deployments of this branch off. */
const VERCEL_DIR = "packages/server";
const NO_DEPLOY = `${JSON.stringify({ git: { deploymentEnabled: false } }, null, 2)}\n`;

const run = promisify(execFile);

export const VAULT_BRANCH = "bench-results";

/** The files a run directory may hold that belong in the vault. */
// official-lme.json: the LongMemEval re-grade with the benchmark's own judge (official-lme.ts).
const RUN_FILES = [
  "run.json",
  "results.json",
  "results.md",
  "units.jsonl",
  "records.jsonl",
  "official-lme.json",
];

const HERE = dirname(fileURLToPath(import.meta.url));

export interface VaultOptions {
  /** Repository root (default: the one this file lives in). */
  repo?: string;
  /** Where the branch is checked out (default `<repo>/evals/.vault`). */
  dir?: string;
  remote?: string;
  branch?: string;
  /**
   * Create the branch when the remote does not have it yet (default true). With false, `open`
   * returns null instead, so a checkout whose remote was never set up for results pushes nothing.
   */
  create?: boolean;
  /** Extra lines appended to every commit message, e.g. "Co-Authored-By: ..." (env EVAL_VAULT_TRAILERS). */
  trailers?: string;
  /** Delays between push attempts; the default retries four times (2, 4, 8, 16 s). */
  pushDelaysMs?: number[];
  log?: (line: string) => void;
}

/** Run name in the vault: the directory's name, prefixed with the run's start date when it lacks one. */
export function vaultName(runDir: string, startedAt: string | null): string {
  const base = basename(resolve(runDir))
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "");
  if (/^\d{4}-\d{2}-\d{2}/.test(base) || !startedAt) return base || "run";
  return `${startedAt.slice(0, 10)}-${base}`;
}

const pct = (x: number | null | undefined) =>
  typeof x === "number" ? `${(x * 100).toFixed(1)}%` : "";

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

async function countLines(path: string): Promise<number> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** README.md for the branch: one row per run, newest first. */
export async function renderIndex(runsDir: string): Promise<string> {
  const names = existsSync(runsDir) ? await readdir(runsDir) : [];
  const rows: { sortKey: string; line: string }[] = [];
  for (const name of names) {
    const dir = join(runsDir, name);
    let results: Results | null = null;
    try {
      results = JSON.parse(await readFile(join(dir, "results.json"), "utf8")) as Results;
    } catch {
      // still running, or stopped before results were written
    }
    if (results) {
      const s = results.settings;
      const overall = results.summary.accuracy.overall;
      const beam = results.summary.beam?.overall?.mean;
      const dataset = s.beamSplit ? `${s.dataset} ${s.beamSplit}` : s.dataset;
      const score = [
        overall.n ? `${pct(overall.accuracy)} of ${overall.n}` : "",
        typeof beam === "number" ? `BEAM ${pct(beam)}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      rows.push({
        sortKey: s.startedAt ?? name,
        line: `| ${cell(name)} | ${cell(dataset)} | ${score} | ${overall.errors} | ${(s.finishedAt ?? "").slice(0, 16).replace("T", " ")} | ${cell(s.label)} | ${cell(s.note ?? "")} |`,
      });
    } else {
      let startedAt = name;
      try {
        startedAt = (
          JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as { startedAt: string }
        ).startedAt;
      } catch {
        // no run.json either
      }
      const answered = await countLines(join(dir, "records.jsonl"));
      rows.push({
        sortKey: startedAt,
        line: `| ${cell(name)} | | not finished: ${answered} answered | | | | |`,
      });
    }
  }
  rows.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
  return [
    "# Benchmark results",
    "",
    "Every benchmark run, saved by the harness while it runs (`evals/src/vault.ts`). Each run keeps",
    "its settings, every question with the answer and the judgement (`records.jsonl`), and the",
    "summary (`results.md`). Scores are rubric accuracy; BEAM runs also show BEAM's own score.",
    "",
    "| Run | Dataset | Score | Errors | Finished (UTC) | Label | Note |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((r) => r.line),
    "",
  ].join("\n");
}

export class Vault {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly repo: string,
    readonly dir: string,
    private readonly remote: string,
    private readonly branch: string,
    private readonly trailers: string,
    private readonly pushDelaysMs: number[],
    private readonly log: (line: string) => void,
  ) {}

  /**
   * Checks the branch out (creating it on first use, unless `create` is false); null when this is
   * not a git checkout with the remote, or the remote has no such branch and `create` is false.
   */
  static async open(opts: VaultOptions = {}): Promise<Vault | null> {
    const log = opts.log ?? ((l: string) => console.error(l));
    const remote = opts.remote ?? "origin";
    const branch = opts.branch ?? VAULT_BRANCH;
    let repo: string;
    try {
      repo = (
        await run("git", ["rev-parse", "--show-toplevel"], { cwd: opts.repo ?? HERE })
      ).stdout.trim();
      await run("git", ["remote", "get-url", remote], { cwd: repo });
    } catch {
      return null;
    }
    const dir = resolve(opts.dir ?? join(repo, "evals", ".vault"));
    const git = (args: string[], cwd = repo) => run("git", args, { cwd });
    if (!existsSync(join(dir, ".git"))) {
      await git(["worktree", "prune"]);
      const fetched = await git(["fetch", remote, branch]).then(
        () => true,
        () => false,
      );
      if (fetched) await git(["worktree", "add", "-B", branch, dir, `${remote}/${branch}`]);
      else if (opts.create === false) return null;
      else await git(["worktree", "add", "--orphan", "-b", branch, dir]);
    }
    return new Vault(
      repo,
      dir,
      remote,
      branch,
      opts.trailers ?? process.env.EVAL_VAULT_TRAILERS ?? "",
      opts.pushDelaysMs ?? [2000, 4000, 8000, 16000],
      log,
    );
  }

  /**
   * Copies a run directory into the vault, commits and pushes. Saves are serialised; a failure
   * is logged and reported as false, never thrown, so it cannot break the run it protects.
   */
  save(runDir: string, opts: { name?: string; log?: string } = {}): Promise<boolean> {
    const next = this.queue.then(() => this.saveNow(runDir, opts));
    this.queue = next.catch(() => undefined);
    return next.catch((err) => {
      this.log(`vault: could not save ${runDir}: ${(err as Error).message.split("\n")[0]}`);
      return false;
    });
  }

  private git(args: string[]) {
    return run("git", args, { cwd: this.dir, maxBuffer: 16 * 1024 * 1024 });
  }

  /**
   * Holds a lock file while `fn` runs, so runs in several processes that share this checkout do
   * not commit at the same time. A lock older than two minutes is a crashed save and is taken over.
   */
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const lock = join(this.dir, ".save.lock");
    for (let waited = 0; ; waited += 250) {
      try {
        await (await open(lock, "wx")).close();
        break;
      } catch {
        const stale = await stat(lock).then(
          (st) => Date.now() - st.mtimeMs > 120_000,
          () => false,
        );
        if (stale) await rm(lock, { force: true });
        if (waited > 180_000) throw new Error("another save holds the vault lock");
        await sleep(250);
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { force: true });
    }
  }

  private saveNow(runDir: string, opts: { name?: string; log?: string }): Promise<boolean> {
    return this.locked(() => this.saveLocked(runDir, opts));
  }

  private async saveLocked(
    runDir: string,
    opts: { name?: string; log?: string },
  ): Promise<boolean> {
    const src = resolve(runDir);
    let startedAt: string | null = null;
    try {
      startedAt = (
        JSON.parse(await readFile(join(src, "run.json"), "utf8")) as { startedAt: string }
      ).startedAt;
    } catch {
      // a run directory without run.json still saves under its own name
    }
    const name = opts.name ?? vaultName(src, startedAt);
    const dest = join(this.dir, "runs", name);
    await mkdir(dest, { recursive: true });
    let copied = 0;
    for (const f of RUN_FILES) {
      if (!existsSync(join(src, f))) continue;
      await copyFile(join(src, f), join(dest, f));
      copied++;
    }
    if (opts.log && existsSync(opts.log)) {
      await copyFile(opts.log, join(dest, "run.log"));
      copied++;
    }
    if (copied === 0) throw new Error("no result files in the directory");
    await writeFile(join(this.dir, "README.md"), await renderIndex(join(this.dir, "runs")));
    // Vercel builds every pushed branch from the server's directory and reads that directory's
    // vercel.json; without one, each save here would use up a deployment of the daily quota.
    await mkdir(join(this.dir, VERCEL_DIR), { recursive: true });
    await writeFile(join(this.dir, VERCEL_DIR, "vercel.json"), NO_DEPLOY);

    await this.git(["add", "-A", "--", "runs", "README.md", VERCEL_DIR]);
    const clean = await this.git(["diff", "--cached", "--quiet"]).then(
      () => true,
      () => false,
    );
    if (clean) return true;
    const message = `runs: ${name}${this.trailers ? `\n\n${this.trailers.trim()}` : ""}`;
    await this.git(["commit", "-q", "-m", message]);
    await this.push();
    this.log(`vault: saved ${name} to ${this.branch}`);
    return true;
  }

  private async push(): Promise<void> {
    let rebases = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.git(["push", "-q", "-u", this.remote, this.branch]);
        return;
      } catch (err) {
        const text = String((err as { stderr?: string }).stderr ?? err);
        // Another machine saved a run meanwhile: replay ours on top (runs never touch each
        // other's folders; the index is regenerated after the rebase) and push again at once.
        if (/non-fast-forward|fetch first|rejected/.test(text) && rebases++ < 3) {
          await this.git(["fetch", "-q", this.remote, this.branch]);
          await this.git(["rebase", "-q", "-X", "theirs", `${this.remote}/${this.branch}`]).catch(
            async (e) => {
              await this.git(["rebase", "--abort"]).catch(() => undefined);
              throw e;
            },
          );
          await writeFile(join(this.dir, "README.md"), await renderIndex(join(this.dir, "runs")));
          await this.git(["add", "README.md"]);
          if (
            !(await this.git(["diff", "--cached", "--quiet"]).then(
              () => true,
              () => false,
            ))
          )
            await this.git(["commit", "-q", "-m", "runs: index"]);
          attempt--;
          continue;
        }
        const delay = this.pushDelaysMs[attempt];
        if (delay === undefined) throw err;
        await sleep(delay);
      }
    }
  }

  /** Waits for saves in flight. */
  async idle(): Promise<void> {
    await this.queue;
  }
}
