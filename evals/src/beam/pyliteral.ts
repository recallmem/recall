/**
 * BEAM stores `probing_questions` as the Python `repr` of a dict (single quotes, `None`, ...),
 * not as JSON. This is a small, safe parser for Python literals: dict, list, tuple, set,
 * strings, numbers, True/False/None. It never evaluates anything.
 */
export class PyLiteralError extends Error {
  constructor(message: string, source: string, at: number) {
    super(`${message} at offset ${at}: ...${source.slice(Math.max(0, at - 30), at + 30)}...`);
    this.name = "PyLiteralError";
  }
}

const SIMPLE_ESCAPES: Record<string, string> = {
  "\\": "\\",
  "'": "'",
  '"': '"',
  n: "\n",
  r: "\r",
  t: "\t",
  a: "\x07",
  b: "\b",
  f: "\f",
  v: "\v",
};

export function parsePythonLiteral(src: string): unknown {
  let i = 0;
  const fail = (msg: string): never => {
    throw new PyLiteralError(msg, src, i);
  };
  const skip = () => {
    for (;;) {
      const c = src[i];
      if (c === " " || c === "\n" || c === "\t" || c === "\r") i++;
      else if (c === "#") while (i < src.length && src[i] !== "\n") i++;
      else return;
    }
  };

  function string(): string {
    // optional prefix: u / r (b and f never occur in repr output of a str)
    let raw = false;
    while (/[uUrR]/.test(src[i] ?? "")) {
      if (/[rR]/.test(src[i] as string)) raw = true;
      i++;
    }
    const quote = src[i];
    if (quote !== "'" && quote !== '"') return fail("expected a string");
    const triple = src.startsWith(quote.repeat(3), i);
    const closer = triple ? quote.repeat(3) : quote;
    i += closer.length;
    let out = "";
    for (;;) {
      if (i >= src.length) return fail("unterminated string");
      if (src.startsWith(closer, i)) {
        i += closer.length;
        return out;
      }
      const c = src[i] as string;
      if (c === "\n" && !triple) return fail("newline in string");
      if (c !== "\\" || raw) {
        out += c;
        i++;
        continue;
      }
      const e = src[i + 1];
      i += 2;
      if (e === undefined) return fail("dangling backslash");
      if (e in SIMPLE_ESCAPES) out += SIMPLE_ESCAPES[e];
      else if (e === "\n")
        continue; // line continuation
      else if (e === "x" || e === "u" || e === "U") {
        const len = e === "x" ? 2 : e === "u" ? 4 : 8;
        const hex = src.slice(i, i + len);
        if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) return fail("bad hex escape");
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += len;
      } else if (/[0-7]/.test(e)) {
        let oct = e;
        while (oct.length < 3 && /[0-7]/.test(src[i] ?? "")) oct += src[i++];
        out += String.fromCharCode(Number.parseInt(oct, 8));
      } else out += `\\${e}`; // unknown escapes keep the backslash, as in Python
    }
  }

  function sequence(close: string): unknown[] {
    const items: unknown[] = [];
    for (;;) {
      skip();
      if (src[i] === close) {
        i++;
        return items;
      }
      items.push(value());
      skip();
      if (src[i] === ",") i++;
      else if (src[i] !== close) fail(`expected ',' or '${close}'`);
    }
  }

  function dict(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (;;) {
      skip();
      if (src[i] === "}") {
        i++;
        return out;
      }
      const key = value();
      skip();
      if (src[i] !== ":") fail("expected ':'");
      i++;
      out[String(key)] = value();
      skip();
      if (src[i] === ",") i++;
      else if (src[i] !== "}") fail("expected ',' or '}'");
    }
  }

  function value(): unknown {
    skip();
    const c = src[i];
    if (c === "{") {
      i++;
      const bodyStart = i;
      skip();
      if (src[i] === "}") {
        i++;
        return {};
      }
      // A dict has ':' after its first element; anything else is a set (read as a list).
      value();
      skip();
      const isDict = src[i] === ":";
      i = bodyStart;
      return isDict ? dict() : sequence("}");
    }
    if (c === "[") {
      i++;
      return sequence("]");
    }
    if (c === "(") {
      i++;
      return sequence(")");
    }
    if (c === "'" || c === '"' || /[uUrR]/.test(c ?? "")) {
      if (/[uUrR]/.test(c ?? "") && !/^[uUrR]{1,2}['"]/.test(src.slice(i, i + 3))) return word();
      return string();
    }
    if (c === "-" || c === "+" || /[0-9.]/.test(c ?? "")) return number();
    return word();
  }

  function number(): number {
    const m = /^[+-]?(?:\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
    if (!m) return fail("bad number");
    i += m[0].length;
    return Number(m[0].replace(/_/g, ""));
  }

  function word(): unknown {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    const w = m?.[0];
    const known: Record<string, unknown> = {
      None: null,
      True: true,
      False: false,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
    };
    if (w !== undefined && w in known) {
      i += w.length;
      return known[w];
    }
    return fail(`unexpected ${w ? `name '${w}'` : `character '${src[i] ?? "end of input"}'`}`);
  }

  const result = value();
  skip();
  if (i < src.length) fail("trailing characters");
  return result;
}

/**
 * Reads BEAM's `probing_questions`: normally a Python-repr string, but JSON text and an
 * already-parsed object are accepted too.
 */
export function parseProbingQuestions(raw: unknown): Record<string, unknown[]> {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    try {
      value = JSON.parse(text);
    } catch {
      value = parsePythonLiteral(text);
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("probing_questions is not an object keyed by memory ability");
  }
  const out: Record<string, unknown[]> = {};
  for (const [ability, qs] of Object.entries(value as Record<string, unknown>)) {
    out[ability] = Array.isArray(qs) ? qs : [];
  }
  return out;
}
