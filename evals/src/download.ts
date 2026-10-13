import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  BEAM_SOURCES,
  type BeamSplit,
  type DatasetName,
  type FileDatasetName,
  SOURCES,
} from "./sources.js";
import { sleep } from "./util.js";

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

export function dataPath(name: FileDatasetName): string {
  return join(DATA_DIR, SOURCES[name].file);
}

export function beamPath(split: BeamSplit): string {
  return join(DATA_DIR, BEAM_SOURCES[split].file);
}

interface DownloadOptions {
  force?: boolean;
  log?: (line: string) => void;
}

/** Downloads one single-file dataset to `evals/data/`. Skips files that are already complete. */
export async function downloadDataset(
  name: FileDatasetName,
  opts: DownloadOptions = {},
): Promise<{ path: string; bytes: number; skipped: boolean }> {
  const log = opts.log ?? (() => {});
  const source = SOURCES[name];
  const path = dataPath(name);
  await mkdir(DATA_DIR, { recursive: true });

  if (!opts.force) {
    const existing = await stat(path).catch(() => null);
    if (existing && existing.size > source.approxBytes * 0.5) {
      log(`${name}: already downloaded (${mb(existing.size)}), use --force to refetch`);
      return { path, bytes: existing.size, skipped: true };
    }
  }

  log(`${name}: downloading ${source.url}`);
  const res = await fetch(source.url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`${name}: HTTP ${res.status} ${res.statusText} for ${source.url}`);
  }
  // fetch() transparently gunzips, so content-length only matches the bytes we see when
  // the response was not content-encoded.
  const expected = res.headers.get("content-encoding")
    ? 0
    : Number(res.headers.get("content-length") ?? 0);
  const tmp = `${path}.part`;
  let received = 0;
  let lastLogged = 0;
  const body = Readable.fromWeb(res.body as never);
  body.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received - lastLogged > 25_000_000) {
      lastLogged = received;
      log(`${name}: ${mb(received)}${expected ? ` / ${mb(expected)}` : ""}`);
    }
  });
  try {
    await pipeline(body, createWriteStream(tmp));
    if (expected && received !== expected) {
      throw new Error(`${name}: truncated download (${received} of ${expected} bytes)`);
    }
    if (received < source.approxBytes * 0.5) {
      throw new Error(
        `${name}: file is only ${mb(received)}, expected about ${mb(source.approxBytes)}`,
      );
    }
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  log(`${name}: saved ${path} (${mb(received)})`);
  return { path, bytes: received, skipped: false };
}

// ------------------------------------------------------------------ BEAM ----

const DATASETS_SERVER = "https://datasets-server.huggingface.co";

/**
 * The fields of a BEAM row the harness uses. The rows also carry the generator's scaffolding
 * (plan, narratives, user_questions = a second copy of the user turns); it is left out on
 * purpose: smaller files, and nothing that could leak the answers into an ingest.
 */
export const BEAM_KEPT_FIELDS = [
  "conversation_id",
  "conversation_seed",
  "chat",
  "probing_questions",
];

export interface BeamDownloadOptions extends DownloadOptions {
  /** Base URL of the datasets-server (overridable for tests). */
  apiBase?: string;
  /** Attempts per row for transient failures. */
  attempts?: number;
  /** Base back-off between attempts. */
  backoffMs?: number;
  /** Output directory (default evals/data); tests point it at a temp dir. */
  dir?: string;
  /** Expected size of the finished file, for the sanity check (default: the split's known size). */
  approxBytes?: number;
}

/** Fetches one row, retrying transient failures (the API sometimes answers with an HTML error page). */
async function fetchBeamRow(
  api: string,
  repo: string,
  split: string,
  offset: number,
  attempts: number,
  backoffMs: number,
): Promise<{ row: Record<string, unknown>; total: number }> {
  const url = `${api}/rows?dataset=${encodeURIComponent(repo)}&config=default&split=${encodeURIComponent(split)}&offset=${offset}&length=1`;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      const text = await res.text();
      if (!res.ok) {
        // 4xx other than rate limiting will not get better by retrying.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`), {
            fatal: true,
          });
        }
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
      }
      let body: {
        rows?: { row?: Record<string, unknown>; truncated_cells?: unknown[] }[];
        num_rows_total?: number;
      };
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`non-JSON answer: ${text.slice(0, 80).replace(/\s+/g, " ")}`);
      }
      const entry = body.rows?.[0];
      if (!entry?.row) throw new Error("no row in the answer");
      if (entry.truncated_cells?.length) {
        throw Object.assign(
          new Error(`the API truncated cells ${JSON.stringify(entry.truncated_cells)}`),
          { fatal: true },
        );
      }
      return { row: entry.row, total: body.num_rows_total ?? 0 };
    } catch (err) {
      last = err;
      if ((err as { fatal?: boolean }).fatal || attempt === attempts) break;
      await sleep(backoffMs * 2 ** (attempt - 1));
    }
  }
  throw new Error(
    `row ${offset} of ${repo}/${split}: ${last instanceof Error ? last.message : String(last)}`,
  );
}

/**
 * Downloads one BEAM split as a JSON array of rows (only BEAM_KEPT_FIELDS), one request per
 * conversation. Skips a file that is already complete. The 10M split cannot be served by the
 * datasets-server (its rows are ~900 MB); for it, convert the parquet with tools/beam-parquet-to-json.py.
 */
export async function downloadBeam(
  split: BeamSplit,
  opts: BeamDownloadOptions = {},
): Promise<{ path: string; bytes: number; skipped: boolean }> {
  const log = opts.log ?? (() => {});
  const source = {
    ...BEAM_SOURCES[split],
    approxBytes: opts.approxBytes ?? BEAM_SOURCES[split].approxBytes,
  };
  const dir = opts.dir ?? DATA_DIR;
  const path = opts.dir ? join(dir, source.file) : beamPath(split);
  const name = `beam-${split}`;
  await mkdir(dir, { recursive: true });

  if (!opts.force) {
    const existing = await stat(path).catch(() => null);
    if (existing && existing.size > source.approxBytes * 0.5) {
      log(`${name}: already downloaded (${mb(existing.size)}), use --force to refetch`);
      return { path, bytes: existing.size, skipped: true };
    }
  }

  const api = opts.apiBase ?? DATASETS_SERVER;
  const attempts = opts.attempts ?? 6;
  const backoffMs = opts.backoffMs ?? 2000;
  const tmp = `${path}.part`;
  const fh = await open(tmp, "w");
  let bytes = 0;
  const write = async (text: string) => {
    bytes += Buffer.byteLength(text);
    await fh.write(text);
  };
  try {
    log(
      `${name}: fetching ${source.repo} split ${source.split} from the Hugging Face datasets-server`,
    );
    await write("[\n");
    let total = source.conversations;
    for (let i = 0; i < total; i++) {
      const { row, total: reported } = await fetchBeamRow(
        api,
        source.repo,
        source.split,
        i,
        attempts,
        backoffMs,
      );
      if (i === 0 && reported && reported !== source.conversations) {
        log(
          `${name}: the server reports ${reported} conversations (expected ${source.conversations}); using ${reported}`,
        );
        total = reported;
      }
      const slim = Object.fromEntries(BEAM_KEPT_FIELDS.map((k) => [k, row[k] ?? null]));
      await write(`${i ? ",\n" : ""}${JSON.stringify(slim)}`);
      log(`${name}: ${i + 1}/${total} conversations (${mb(bytes)})`);
    }
    await write("\n]\n");
    await fh.close();
    if (bytes < source.approxBytes * 0.5) {
      throw new Error(
        `${name}: file is only ${mb(bytes)}, expected about ${mb(source.approxBytes)}`,
      );
    }
    await rename(tmp, path);
  } catch (err) {
    await fh.close().catch(() => undefined);
    await rm(tmp, { force: true });
    if (!source.viewer) {
      throw new Error(
        `${name}: ${(err as Error).message}\nThe Hugging Face datasets-server cannot serve ${source.repo} (rows are too large). Download the parquet from https://huggingface.co/datasets/${source.repo}/tree/main/data and convert it:\n  python3 -I evals/tools/beam-parquet-to-json.py <downloaded.parquet> ${path}`,
      );
    }
    throw err;
  }
  log(`${name}: saved ${path} (${mb(bytes)})`);
  return { path, bytes, skipped: false };
}

export async function downloadAll(
  names: DatasetName[],
  opts: DownloadOptions & { beamSplits?: BeamSplit[] } = {},
): Promise<void> {
  for (const name of names) {
    if (name === "beam") {
      for (const split of opts.beamSplits ?? (["100k", "500k", "1m"] as BeamSplit[])) {
        await downloadBeam(split, opts);
      }
    } else await downloadDataset(name, opts);
  }
}

const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;
