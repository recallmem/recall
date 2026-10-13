#!/usr/bin/env -S node --import tsx
/**
 * Cheap end-to-end check of the whole pipeline: starts an offline Recall server
 * (embedded Postgres, mock LLM provider, no API keys, nothing leaves the machine),
 * runs a handful of questions through the real harness, and shuts the server down.
 * Accuracy is meaningless here; what it proves is that ingest -> idle -> chat ->
 * judge -> metered cost -> report all work.
 *
 *   pnpm --filter @recall-memory/evals smoke [--dataset locomo|longmemeval|beam|all] [--limit 5] [--beam-split 100k]
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sleep } from "./util.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVALS = join(HERE, "..");
const SERVER_MAIN = join(EVALS, "..", "packages", "server", "src", "main.ts");

const { values } = parseArgs({
  options: {
    dataset: { type: "string", default: "locomo" },
    "beam-split": { type: "string", default: "100k" },
    limit: { type: "string", default: "5" },
    level: { type: "string", default: "low" },
  },
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** A clean environment: no provider keys, no database URL, so the server is guaranteed offline. */
function offlineEnv(port: number): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "TMPDIR", "NODE_OPTIONS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return {
    ...env,
    RECALL_DATA_DIR: "memory",
    RECALL_HOST: "127.0.0.1",
    RECALL_PORT: String(port),
    RECALL_LOG_LEVEL: "warn",
  };
}

async function waitForHealth(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`server did not become healthy within ${timeoutMs / 1000}s`);
}

function runCli(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(HERE, "cli.ts"), ...args], {
      cwd: EVALS,
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

const datasets =
  values.dataset === "all" ? ["locomo", "longmemeval", "beam"] : [values.dataset as string];
const port = await freePort();
const url = `http://127.0.0.1:${port}`;

console.error(`starting an offline Recall server on ${url} (mock provider, embedded Postgres)...`);
const server = spawn(process.execPath, ["--import", "tsx", SERVER_MAIN], {
  cwd: EVALS,
  env: offlineEnv(port),
  stdio: ["ignore", "inherit", "inherit"],
});

let code = 0;
try {
  await waitForHealth(url, server, 180_000);
  console.error("server is healthy");
  for (const dataset of datasets) {
    const status = await runCli([
      "run",
      "--target-url",
      url,
      "--dataset",
      dataset,
      ...(dataset === "beam" ? ["--beam-split", values["beam-split"] as string] : []),
      "--limit",
      values.limit as string,
      "--level",
      values.level as string,
      "--judge-model",
      "mock",
      "--label",
      "recall-offline",
      "--out",
      join(EVALS, "results", `smoke-${dataset}`),
    ]);
    if (status !== 0) code = status;
  }
} catch (err) {
  console.error(`smoke test failed: ${err instanceof Error ? err.message : err}`);
  code = 1;
} finally {
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      server.kill("SIGKILL");
      resolve();
    }, 5000);
    server.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    if (server.exitCode !== null) resolve();
  });
}
process.exit(code);
