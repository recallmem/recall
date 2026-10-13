import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { ApiError, unprocessable } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { stripNul } from "../lib/json.js";
import { type PdfText, readPdfText } from "./pdf-text.js";
import { MAX_MESSAGE_CHARS } from "./schemas.js";

/** File upload to messages (spec 01 section 3.5.2): text extraction and chunking. */

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const SUPPORTED_UPLOAD_TYPES = ["application/pdf", "application/json", "text/*"] as const;

export interface Chunk {
  text: string;
  start: number;
  end: number;
}

export interface ExtractedFile {
  text: string;
  contentType: string;
}

/** The declared media type without parameters (`text/plain; charset=utf-8` becomes `text/plain`). */
export const baseContentType = (declared: string): string =>
  declared.split(";")[0]!.trim().toLowerCase();

export function assertSupportedType(declared: string): string {
  const type = baseContentType(declared);
  if (type === "application/pdf" || type === "application/json" || type.startsWith("text/"))
    return type;
  throw new ApiError(
    415,
    `Unsupported file type: ${type || "unknown"}. Supported types: [${SUPPORTED_UPLOAD_TYPES.map((t) => `'${t}'`).join(", ")}]`,
  );
}

function decodeText(bytes: Uint8Array): string {
  const utf8 = (() => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  })();
  if (utf8 !== null) return utf8;
  // UTF-16 only with a byte-order mark: without one, Latin-1 text decodes as UTF-16 garbage.
  const le = bytes[0] === 0xff && bytes[1] === 0xfe;
  const be = bytes[0] === 0xfe && bytes[1] === 0xff;
  if (le || be) {
    try {
      return new TextDecoder(le ? "utf-16le" : "utf-16be", { fatal: true }).decode(bytes);
    } catch {
      // fall through to Latin-1
    }
  }
  return new TextDecoder("latin1").decode(bytes);
}

/** Limits on what one uploaded PDF may make the server read. */
export const PDF_LIMITS = { maxPages: 500, maxChars: 2_000_000, timeoutMs: 20_000, memoryMb: 256 };

/**
 * Reads a PDF in a worker thread with a deadline and a memory cap, so a file built to inflate
 * to gigabytes stops there instead of stalling the server. Where the worker script is not
 * available (tests run from source), the same limits apply in process.
 */
async function extractPdf(bytes: Uint8Array): Promise<string> {
  let read: PdfText;
  try {
    const worker = new URL("./pdf-worker.js", import.meta.url);
    read = existsSync(fileURLToPath(worker))
      ? await inWorker(worker, bytes)
      : await readPdfText(bytes, PDF_LIMITS);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw unprocessable(
      `Could not read PDF: ${err instanceof Error ? err.message : "invalid file"}`,
    );
  }
  if (read.truncated === "pages")
    throw new ApiError(413, `The PDF has more than ${PDF_LIMITS.maxPages} pages`);
  if (read.truncated === "chars")
    throw new ApiError(413, `The PDF holds more than ${PDF_LIMITS.maxChars} characters of text`);
  return read.pages.map((page, i) => `[Page ${i + 1}]\n${page.trim()}`).join("\n\n");
}

function inWorker(script: URL, bytes: Uint8Array): Promise<PdfText> {
  return new Promise((resolve, reject) => {
    const w = new Worker(script, {
      workerData: { bytes, limits: PDF_LIMITS },
      resourceLimits: { maxOldGenerationSizeMb: PDF_LIMITS.memoryMb },
    });
    const timer = setTimeout(() => {
      void w.terminate();
      reject(new ApiError(422, "Could not read PDF: it took too long to read"));
    }, PDF_LIMITS.timeoutMs);
    w.once("message", (m: { ok: boolean; result?: PdfText; error?: string }) => {
      clearTimeout(timer);
      void w.terminate();
      if (m.ok) resolve(m.result!);
      else reject(new Error(m.error));
    });
    w.once("error", (err) => {
      clearTimeout(timer);
      reject(
        /memory/i.test(err.message)
          ? new ApiError(422, "Could not read PDF: it needs too much memory to read")
          : err,
      );
    });
  });
}

/** Extracts plain text from an uploaded file according to its declared type. */
export async function extractFileText(
  bytes: Uint8Array,
  declaredType: string,
): Promise<ExtractedFile> {
  const contentType = assertSupportedType(declaredType);
  let text: string;
  if (contentType === "application/pdf") {
    text = await extractPdf(bytes);
    if (!text.replace(/\[Page \d+\]/g, "").trim())
      throw unprocessable("No extractable text found in the PDF");
  } else if (contentType === "application/json") {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      text = JSON.stringify(JSON.parse(decoded));
    } catch {
      throw unprocessable("Invalid JSON file: the file must be UTF-8 encoded, valid JSON");
    }
  } else {
    text = decodeText(bytes);
  }
  text = stripNul(text.replace(/^﻿/, ""));
  if (!text.trim()) throw unprocessable("The file is empty");
  return { text, contentType };
}

/**
 * Splits text into chunks of at most `max` characters, preferring to break
 * after a paragraph break, then a newline, then a sentence end, then a space.
 * Breaks in the first half of the window are ignored so chunks stay sizeable.
 * Chunks are contiguous and together cover the text exactly.
 */
export function chunkText(text: string, max = MAX_MESSAGE_CHARS): Chunk[] {
  const chunks: Chunk[] = [];
  let pos = 0;
  while (pos < text.length) {
    if (text.length - pos <= max) {
      chunks.push({ text: text.slice(pos), start: pos, end: text.length });
      break;
    }
    const window = text.slice(pos, pos + max);
    let cut = -1;
    for (const separator of ["\n\n", "\n", ". ", " "]) {
      const idx = window.lastIndexOf(separator);
      if (idx >= max / 2) {
        cut = idx + separator.length;
        break;
      }
    }
    if (cut < 0) {
      cut = max;
      const code = window.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // never split a surrogate pair
    }
    chunks.push({ text: window.slice(0, cut), start: pos, end: pos + cut });
    pos += cut;
  }
  return chunks.filter((c) => c.text.trim().length > 0);
}

/** Per-message private provenance recorded for uploaded files. */
export function fileProvenance(args: {
  fileId: string;
  filename: string;
  size: number;
  contentType: string;
  chunks: Chunk[];
}) {
  return args.chunks.map((chunk, index) => ({
    file: {
      file_id: args.fileId,
      filename: args.filename,
      chunk_index: index,
      total_chunks: args.chunks.length,
      original_file_size: args.size,
      content_type: args.contentType,
      chunk_character_range: [chunk.start, chunk.end],
    },
  }));
}

export const newFileId = () => newId();
