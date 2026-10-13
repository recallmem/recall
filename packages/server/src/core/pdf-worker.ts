import { parentPort, workerData } from "node:worker_threads";
import { readPdfText } from "./pdf-text.js";

/**
 * Reads a PDF's text off the main thread (see extractPdf in files.ts): a crafted file can make
 * the reader decompress hundreds of megabytes, and here that only costs this worker, which is
 * stopped at its deadline or memory limit.
 */
const { bytes, limits } = workerData as {
  bytes: Uint8Array;
  limits: { maxPages: number; maxChars: number };
};
readPdfText(bytes, limits).then(
  (result) => parentPort!.postMessage({ ok: true, result }),
  (err: unknown) =>
    parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }),
);
