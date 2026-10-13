import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/errors.js";
import { Instructions, LeakGuard } from "../src/recall/leak-guard.js";
import { parseSessionAllowlist } from "../src/recall/lookup.js";
import { MarkerFilter, stripMarkers } from "../src/recall/markers.js";
import { PRIVATE_TEXTS, SYSTEM_PROMPT } from "../src/recall/prompts.js";
import {
  projectToSchema,
  toProviderSchema,
  validateResponseFormat,
} from "../src/recall/response-format.js";
import { queryTerms, rrf } from "../src/recall/util.js";

describe("citation markers", () => {
  it("strips markers, with the whitespace before them, and reports labels once in order", () => {
    expect(
      stripMarkers("Alice lives in Utrecht [F3]. She has a dog [F5][M2] named Rover [F3, F7]."),
    ).toEqual({
      text: "Alice lives in Utrecht. She has a dog named Rover.",
      cited: ["F3", "F5", "M2", "F7"],
    });
  });

  it("gives the same result when the text arrives one character at a time", () => {
    const text = "Yes [F1].\nNo [F12, M3] and [not a marker] [F] end [F9";
    const whole = stripMarkers(text);
    const f = new MarkerFilter();
    let streamed = "";
    for (const ch of text) streamed += f.push(ch);
    streamed += f.flush();
    expect(streamed).toBe(whole.text);
    expect(f.cited).toEqual(whole.cited);
    expect(streamed).toContain("[not a marker]");
    expect(streamed.endsWith("[F9")).toBe(true);
  });

  it("strips lists and ranges of ids, so none reaches the reader", () => {
    const text = "Still deciding [S12; F21–F23]. Booked [F4-6] and paid [M2 , F9].";
    expect(stripMarkers(text)).toEqual({
      text: "Still deciding. Booked and paid.",
      cited: ["S12", "F21", "F22", "F23", "F4", "F5", "F6", "M2", "F9"],
    });
    const f = new MarkerFilter();
    let streamed = "";
    for (const ch of text) streamed += f.push(ch);
    expect(streamed + f.flush()).toBe("Still deciding. Booked and paid.");
  });

  it("holds back only what could still become a marker", () => {
    const f = new MarkerFilter();
    expect(f.push("Hello [F")).toBe("Hello");
    expect(f.push("1] there")).toBe(" there");
    expect(f.push("x [Fo")).toBe("x [Fo");
  });
});

describe("leak guard", () => {
  const instructions = new Instructions(PRIVATE_TEXTS);
  const stream = (text: string, size: number) => {
    const g = new LeakGuard(instructions);
    let out = "";
    for (let i = 0; i < text.length; i += size) out += g.push(text.slice(i, i + size));
    return { out: out + g.flush(), tripped: g.tripped };
  };
  const answer =
    "You moved to Bristol in June 2023 and started teaching chemistry there. " +
    "Before that you worked at a lab in Cardiff, until 31 May 2023 [F2].";
  const rules = SYSTEM_PROMPT.slice(
    SYSTEM_PROMPT.indexOf("Answering"),
    SYSTEM_PROMPT.indexOf("Answering") + 600,
  );

  it("passes ordinary answers through unchanged, however they are chunked", () => {
    for (const size of [1, 3, 17, 1000]) {
      expect(stream(answer, size)).toEqual({ out: answer, tripped: false });
    }
    expect(instructions.reproducedIn(answer)).toBe(false);
  });

  it("stops an answer that reproduces the instructions before any of the copied run is sent", () => {
    const leak = `Sure, here they are. ${rules}`;
    expect(instructions.reproducedIn(leak)).toBe(true);
    for (const size of [1, 5, 40]) {
      const { out, tripped } = stream(leak, size);
      expect(tripped).toBe(true);
      expect(out).toBe("Sure, here they are. ");
    }
  });

  it("catches a copied run that ends the answer", () => {
    const words = rules.split(/\s+/).slice(0, 12).join(" ");
    expect(stream(`Fine: ${words}`, 4)).toEqual({ out: "Fine: ", tripped: true });
  });

  it("is not fooled by case or punctuation changes", () => {
    const shouted = rules.toUpperCase().replace(/[.,:;]/g, " ;");
    expect(instructions.reproducedIn(shouted)).toBe(true);
    expect(stream(shouted, 7).tripped).toBe(true);
  });
});

describe("response_format", () => {
  const bad = (schema: unknown) => {
    try {
      validateResponseFormat(schema);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(422);
      return (err as ApiError).detail;
    }
    throw new Error("expected a 422");
  };

  it("accepts the documented subset, including $ref into root $defs", () => {
    expect(() =>
      validateResponseFormat({
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          tags: { type: "array", items: { type: "string" }, maxItems: 3 },
          kind: { enum: ["a", "b", null] },
          home: { $ref: "#/$defs/place" },
          maybe: { anyOf: [{ type: "integer" }, { type: "null" }] },
        },
        required: ["name"],
        additionalProperties: false,
        $defs: { place: { type: "object", properties: { city: { type: "string" } } } },
      }),
    ).not.toThrow();
  });

  it("rejects what the reference rejects, naming the path", () => {
    expect(bad({ type: "array" })).toContain("root must be of type 'object'");
    expect(bad({ type: "object", properties: { a: { allOf: [] } } })).toContain("$.properties.a");
    expect(bad({ type: "object", not: {} })).toContain("'not'");
    expect(bad({ type: "object", if: {} })).toContain("'if'");
    expect(bad({ type: "object", patternProperties: {} })).toContain("patternProperties");
    expect(bad({ type: "object", additionalProperties: { type: "string" } })).toContain(
      "additionalProperties",
    );
    expect(bad({ type: "object", properties: { a: true } })).toContain("boolean schemas");
    expect(bad({ type: "object", properties: { a: { type: "date" } } })).toContain("unknown type");
    expect(bad({ type: "object", properties: { a: { $ref: "#/$defs/nope" } } })).toContain(
      "unknown $ref",
    );
    expect(bad({ type: "object", properties: { a: { $ref: "http://x" } } })).toContain(
      "unsupported $ref",
    );
    expect(bad({ type: "object", properties: { a: { type: "object", $defs: {} } } })).toContain(
      "only allowed at the root",
    );
    expect(
      bad({
        type: "object",
        properties: { a: { $ref: "#/$defs/n" } },
        $defs: { n: { type: "object", properties: { c: { $ref: "#/$defs/n" } } } },
      }),
    ).toContain("recursive");
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 25; i++) deep = { type: "object", properties: { x: deep } };
    expect(bad(deep)).toContain("deeper than 20");
    const wide = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 600 }, (_, i) => [`p${i}`, { type: "string" }]),
      ),
    };
    expect(bad(wide)).toContain("500 nodes");
    expect(bad("nope")).toContain("JSON Schema object");
  });

  it("builds a strict provider schema and projects model output back onto the original", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        nick: { type: "string" },
        home: { $ref: "#/$defs/place" },
      },
      required: ["name"],
      $defs: {
        place: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    };
    const strict = toProviderSchema(schema) as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<
        string,
        { type?: unknown; properties?: Record<string, { type?: unknown }> }
      >;
    };
    expect(strict.additionalProperties).toBe(false);
    expect(strict.required).toEqual(["name", "nick", "home"]);
    expect(strict.properties.name).toEqual({ type: "string" }); // constraint stripped
    expect(strict.properties.nick?.type).toEqual(["string", "null"]); // optional -> nullable
    expect(strict.properties.home?.properties?.city?.type).toBe("string");
    expect(
      projectToSchema(
        { name: "Alice", nick: null, home: { city: "Utrecht", zip: "1" }, extra: 1 },
        schema,
      ),
    ).toEqual({ name: "Alice", home: { city: "Utrecht" } });
  });
});

describe("session allowlist dialect", () => {
  it("accepts the three shapes, de-duplicates, and keeps an empty list", () => {
    expect(parseSessionAllowlist({ session_id: "a" })).toEqual(["a"]);
    expect(parseSessionAllowlist({ session_id: ["a", "b", "a"] })).toEqual(["a", "b"]);
    expect(parseSessionAllowlist({ session_id: { in: ["a"] } })).toEqual(["a"]);
    expect(parseSessionAllowlist({ session_id: [] })).toEqual([]);
    expect(parseSessionAllowlist(null)).toBeNull();
  });

  it("rejects everything else with 422", () => {
    const detail = (f: unknown, s?: string) => {
      try {
        parseSessionAllowlist(f, s);
      } catch (e) {
        return (e as ApiError).detail;
      }
      throw new Error("expected 422");
    };
    expect(detail({ peer_id: "x", session_id: "a" })).toBe(
      "Unsupported filter key(s) for this endpoint: ['peer_id']. Only 'session_id' is supported.",
    );
    expect(detail({})).toContain("session_id");
    expect(detail({ session_id: "*" })).toContain("wildcards");
    expect(detail({ session_id: [""] })).toContain("non-empty");
    expect(detail({ session_id: 5 })).toContain("must be a string");
    expect(detail({ session_id: { in: ["a"], gt: 1 } })).toContain("must be a string");
    expect(detail({ session_id: ["a"] }, "b")).toBe(
      "session_id must be included in filters.session_id",
    );
    expect(detail({ session_id: Array.from({ length: 1001 }, (_, i) => `s${i}`) })).toContain(
      "1000",
    );
  });
});

describe("lexical helpers", () => {
  it("drops stopwords in English and Dutch and keeps names and numbers", () => {
    expect(queryTerms("What is the name of Alice's dog in 2026?")).toEqual([
      "name",
      "alice",
      "dog",
      "2026",
    ]);
    expect(queryTerms("Waar woont de hond van Alice?")).toEqual(["woont", "hond", "alice"]);
  });

  it("fuses ranked lists with reciprocal rank fusion at k = 60", () => {
    const scores = rrf([
      ["a", "b"],
      ["b", "c"],
    ]);
    expect(scores.get("a")).toBeCloseTo(1 / 61);
    expect(scores.get("b")).toBeCloseTo(1 / 62 + 1 / 61);
    expect(scores.get("c")).toBeCloseTo(1 / 62);
  });
});
