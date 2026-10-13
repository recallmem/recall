/**
 * Citation markers. The model tags claims with "[F3]" (fact), "[M2]" (excerpt) or
 * "[S1]" (conversation log note); the server strips them from the visible answer
 * and reports the ids instead. Lists ("[F3, M2]", "[S12; F21]") and ranges
 * ("[F21–F23]") are stripped too, so no internal id reaches the reader.
 * Streaming-safe: a marker split across chunks is held back until it completes.
 */
const LABEL = String.raw`[FMS]\d+(?:\s*[-–—]\s*[FMS]?\d+)?`;
const LABELS = String.raw`${LABEL}(?:\s*[,;]\s*${LABEL})*`;
const FULL = new RegExp(String.raw`\s*\[(${LABELS})\]`, "g");
const PART = String.raw`[FMS]\d*(?:\s*[-–—]\s*[FMS]?\d*)?`;
const PARTS = String.raw`(?:${PART}(?:\s*[,;]\s*(?:${PART})?)*)?\s*$`;
const PARTIAL_MARKER = new RegExp(String.raw`\s*\[${PARTS}`);
/** The same ids in parentheses ("(F3)", "(F3, M2)"), which a model sometimes writes instead. */
const PAREN = new RegExp(String.raw`\s*\((${LABELS})\)`, "g");
const PARTIAL_PAREN = new RegExp(String.raw`\s*\(${PARTS}`);
const TRAILING_SPACE = /\s+$/;
/** Section labels are not citable; strip them if the model brackets one anyway. */
const SECTION_LABEL =
  /\s*\[(?:Profile|Facts?|Excerpts?|Session|Summary|No longer true|Conversation log)\]/gi;
/** Longest range expanded into separate labels; longer ones keep only their ends. */
const MAX_RANGE = 30;

/** "F21–F23" → F21, F22, F23; "F4" → F4. */
function expand(label: string): string[] {
  const m = label.match(/^([FMS])(\d+)\s*[-–—]\s*([FMS])?(\d+)$/);
  if (!m) return [label];
  const [, kind, from, toKind, to] = m as unknown as [
    string,
    string,
    string,
    string | undefined,
    string,
  ];
  const a = Number(from);
  const b = Number(to);
  if ((toKind && toKind !== kind) || b < a || b - a > MAX_RANGE) {
    return [`${kind}${a}`, `${toKind ?? kind}${b}`];
  }
  return Array.from({ length: b - a + 1 }, (_, i) => `${kind}${a + i}`);
}

const labelsOf = (list: string): string[] =>
  list.split(/[,;]/).flatMap((l) => expand(l.trim()).filter(Boolean));

export interface MarkerOptions {
  /**
   * Also treat parenthesised ids ("(F3)") as markers when this accepts their labels. Off by
   * default: "(M1)" can be a chip and "(S3)" a storage class, so the caller decides, typically
   * by checking that the label occurs nowhere in the question or the memory.
   */
  parens?: (labels: string[]) => boolean;
}

export class MarkerFilter {
  private pending = "";
  /** Labels in order of first appearance, e.g. ["F3", "M1"]. */
  readonly cited: string[] = [];

  constructor(private readonly opts: MarkerOptions = {}) {}

  private cite(labels: string[]): void {
    for (const label of labels) if (!this.cited.includes(label)) this.cited.push(label);
  }

  private strip(s: string): string {
    let out = s.replace(SECTION_LABEL, "").replace(FULL, (_m, list: string) => {
      this.cite(labelsOf(list));
      return "";
    });
    const parens = this.opts.parens;
    if (parens)
      out = out.replace(PAREN, (m, list: string) => {
        const labels = labelsOf(list);
        if (!parens(labels)) return m;
        this.cite(labels);
        return "";
      });
    return out;
  }

  /** Feeds a chunk; returns the text that is safe to show now. */
  push(chunk: string): string {
    const s = this.strip(this.pending + chunk);
    const hold =
      s.match(PARTIAL_MARKER) ??
      (this.opts.parens ? s.match(PARTIAL_PAREN) : null) ??
      s.match(TRAILING_SPACE);
    if (!hold || hold.index === undefined) {
      this.pending = "";
      return s;
    }
    this.pending = s.slice(hold.index);
    return s.slice(0, hold.index);
  }

  /** Releases whatever is still held at the end of the stream. */
  flush(): string {
    const rest = this.strip(this.pending);
    this.pending = "";
    return rest;
  }
}

/** Whole-text convenience for non-streaming answers. */
export function stripMarkers(
  text: string,
  opts: MarkerOptions = {},
): { text: string; cited: string[] } {
  const f = new MarkerFilter(opts);
  const out = f.push(text) + f.flush();
  return { text: out, cited: f.cited };
}

/**
 * Strips markers from every string in a JSON value (a structured answer), at any depth, and
 * reports the labels cited across all of them in order of first appearance.
 */
export function stripJsonMarkers(
  value: unknown,
  opts: MarkerOptions = {},
): { value: unknown; cited: string[] } {
  const f = new MarkerFilter(opts);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const out = f.push(v) + f.flush();
      return out === v ? v : out.trim();
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value), cited: f.cited };
}
