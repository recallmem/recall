import { constants, inflateSync } from "node:zlib";

/**
 * A cheap pass over an uploaded PDF before pdf.js reads it: how large its compressed streams
 * become once inflated. pdf.js keeps decoded streams in buffers outside the JS heap, so the
 * worker's heap limit does not stop a small file that inflates to gigabytes (a "zip bomb").
 *
 * Every FlateDecode stream that is not an image is inflated here with a running output limit, and
 * the file is refused as soon as the total passes it. Images are left alone: text extraction never
 * decodes them. Run-length streams count at their worst case (128x), and LZW is refused outright:
 * it can expand thousands of times and is not used by current PDF writers.
 */

export type PdfInflation = { ok: true; bytes: number } | { ok: false; reason: "too_large" | "lzw" };

/** One stream: where its data is and what its dictionary says. */
interface StreamRef {
  dict: string;
  start: number;
  end: number;
}

const STREAM_KEYWORD = /stream\r?\n/g;
const RUN_LENGTH_WORST = 128;

/** The streams of a PDF, with their dictionaries and data ranges (latin1 view of the bytes). */
function streams(text: string): StreamRef[] {
  const out: StreamRef[] = [];
  for (const m of text.matchAll(STREAM_KEYWORD)) {
    const at = m.index!;
    if (text.slice(Math.max(0, at - 3), at) === "end") continue;
    // The dictionary: back to the object header ("N G obj") that opens it.
    const from = text.lastIndexOf(" obj", at);
    const dict = text.slice(from < 0 ? Math.max(0, at - 4096) : from, at);
    const start = at + m[0].length;
    // The data ends where /Length says (a direct number, or "N G R" resolved), else at endstream.
    let length = lengthOf(text, dict);
    if (length === null || start + length > text.length) {
      const stop = text.indexOf("endstream", start);
      length = (stop < 0 ? text.length : stop) - start;
    }
    out.push({ dict, start, end: start + length });
  }
  return out;
}

function lengthOf(text: string, dict: string): number | null {
  const direct = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
  if (direct) return Number(direct[1]);
  const ref = dict.match(/\/Length\s+(\d+)\s+(\d+)\s+R/);
  if (!ref) return null;
  const obj = new RegExp(`(?:^|[^0-9])${ref[1]}\\s+${ref[2]}\\s+obj\\s*(\\d+)\\s*endobj`).exec(
    text,
  );
  return obj ? Number(obj[1]) : null;
}

/** ASCIIHexDecode: pairs of hex digits up to ">", whitespace ignored. */
function asciiHex(data: Buffer): Buffer {
  const hex = data
    .toString("latin1")
    .split(">")[0]!
    .replace(/[^0-9a-fA-F]/g, "");
  return Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex");
}

/** ASCII85Decode: groups of five characters from "!" to "u", "z" for four zero bytes, up to "~>". */
function ascii85(data: Buffer): Buffer {
  const text = data.toString("latin1").split("~>")[0]!.replace(/\s/g, "");
  const out: number[] = [];
  let group: number[] = [];
  const flush = (n: number) => {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * 85 + (group[i] ?? 84);
    for (let i = 0; i < n; i++) out.push((v >>> (24 - 8 * i)) & 0xff);
  };
  for (const ch of text) {
    if (ch === "z" && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) continue;
    group.push(c);
    if (group.length === 5) {
      flush(4);
      group = [];
    }
  }
  if (group.length > 1) flush(group.length - 1);
  return Buffer.from(out);
}

/** The filters named in a stream dictionary, in order (`/Filter /FlateDecode` or an array). */
function filtersOf(dict: string): string[] {
  const m = dict.match(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+|\d+\s+\d+\s+R)/);
  if (!m) return [];
  // An indirect filter is treated as Flate: inflating data that is not zlib just fails quietly.
  if (/R$/.test(m[1]!)) return ["FlateDecode"];
  return [...m[1]!.matchAll(/\/([A-Za-z0-9]+)/g)].map((f) => f[1]!);
}

/**
 * The total inflated size of the PDF's non-image streams, or why it is refused: past `budget`
 * bytes, or an LZW stream. Inflation stops at the budget, so this never allocates much more.
 */
export function pdfInflation(bytes: Uint8Array, budget: number): PdfInflation {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = buf.toString("latin1");
  let total = 0;
  for (const s of streams(text)) {
    if (/\/Subtype\s*\/Image\b/.test(s.dict)) continue;
    const filters = filtersOf(s.dict);
    if (filters.some((f) => f === "LZWDecode" || f === "LZW")) return { ok: false, reason: "lzw" };
    let data: Buffer = buf.subarray(s.start, s.end);
    let size = data.length;
    for (const f of filters) {
      if (f === "FlateDecode" || f === "Fl") {
        try {
          data = inflateSync(data, {
            maxOutputLength: Math.max(1, budget - total + 1),
            finishFlush: constants.Z_SYNC_FLUSH,
          });
        } catch (err) {
          if (err instanceof RangeError) return { ok: false, reason: "too_large" };
          break; // not zlib data: pdf.js will reject or skip it
        }
        size = data.length;
      } else if (f === "ASCIIHexDecode" || f === "AHx") {
        data = asciiHex(data);
        size = data.length;
      } else if (f === "ASCII85Decode" || f === "A85") {
        data = ascii85(data);
        size = data.length;
      } else if (f === "RunLengthDecode" || f === "RL") {
        size *= RUN_LENGTH_WORST;
        break;
      } else break; // image codecs: not decoded for text, and not expanding past this point
    }
    total += size;
    if (total > budget) return { ok: false, reason: "too_large" };
  }
  return { ok: true, bytes: total };
}
