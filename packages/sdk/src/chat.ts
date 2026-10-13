import { RecallError } from "./errors.js";
import type { CallOptions, HttpClient } from "./http.js";
import { DialecticStream } from "./stream.js";
import type {
  ChatResponse,
  JsonSchema,
  ReasoningLevel,
  ResponseFormat,
  SchemaLike,
  TypedResponseFormat,
} from "./types.js";
import { type IdLike, idOf, type Obj } from "./util.js";
import { evidenceFromWire } from "./wire.js";

export interface ChatOptions extends CallOptions {
  /** Prefer this conversation's messages. */
  session?: IdLike;
  /** Answer from the memory of these scopes instead of a peer's own. */
  scope?: IdLike | readonly IdLike[];
  reasoningLevel?: ReasoningLevel;
  /** Ask for JSON: a JSON Schema, or `{ jsonSchema, parse }` to also get a typed result. */
  responseFormat?: ResponseFormat;
  /** Return a `ChatResponse` (evidence, citations, confidence, abstained) instead of just the text. */
  includeEvidence?: boolean;
}
export interface PeerChatOptions extends ChatOptions {
  /** Ask what this peer knows about another peer. Default: about themself. */
  target?: IdLike;
  /** Restrict to these sessions. */
  sessions?: readonly IdLike[];
}

interface ResolvedFormat {
  schema: JsonSchema;
  parse: ((data: unknown) => unknown) | null;
}

export function resolveFormat(format: ResponseFormat): ResolvedFormat {
  const f = format as Partial<TypedResponseFormat<unknown>> & Partial<SchemaLike<unknown>>;
  if (typeof f.parse === "function") {
    const parse = f.parse.bind(format);
    if (f.jsonSchema && typeof f.jsonSchema === "object") return { schema: f.jsonSchema, parse };
    if (typeof f.toJSONSchema === "function") return { schema: f.toJSONSchema(), parse };
    throw new TypeError("responseFormat has parse() but no jsonSchema (or toJSONSchema())");
  }
  return { schema: format as JsonSchema, parse: null };
}

/**
 * Client-side rule: `scope` replaces the memory that is read, so it cannot be combined with
 * `sessions` or `session`. Throws before any request is made. (`session` together with a `sessions`
 * allowlist that includes it is a valid request, so it is left to the server.)
 */
export function checkRecallScope(opts: {
  scope?: unknown;
  sessions?: unknown;
  session?: unknown;
}): void {
  if (opts.scope === undefined) return;
  for (const other of ["sessions", "session"] as const) {
    if (opts[other] !== undefined) {
      throw new TypeError(`\`scope\` and \`${other}\` are mutually exclusive`);
    }
  }
}

/** `sessions` as a `filters` allowlist. An empty list is kept: it means "recall nothing". */
export function sessionFilter(sessions: readonly IdLike[] | undefined): Obj | undefined {
  return sessions === undefined ? undefined : { session_id: sessions.map(idOf) };
}

export function buildChatBody(query: string, stream: boolean, opts: PeerChatOptions): Obj {
  if (typeof query !== "string" || !query) throw new TypeError("query must be a non-empty string");
  checkRecallScope(opts);
  const scope =
    opts.scope === undefined
      ? undefined
      : Array.isArray(opts.scope)
        ? (opts.scope as readonly IdLike[]).map(idOf)
        : idOf(opts.scope as IdLike);
  const filters = sessionFilter(opts.sessions);
  return {
    query,
    stream,
    ...(opts.target === undefined ? {} : { target: idOf(opts.target) }),
    ...(opts.session === undefined ? {} : { session_id: idOf(opts.session) }),
    ...(opts.reasoningLevel === undefined ? {} : { reasoning_level: opts.reasoningLevel }),
    ...(opts.responseFormat === undefined
      ? {}
      : { response_format: resolveFormat(opts.responseFormat).schema }),
    ...(opts.includeEvidence === undefined ? {} : { include_evidence: opts.includeEvidence }),
    ...(scope === undefined ? {} : { scope }),
    ...(filters === undefined ? {} : { filters }),
  };
}

/** Sends a non-streaming chat request and shapes the answer as the options ask. */
export async function chatOnce(
  http: HttpClient,
  path: string,
  query: string,
  opts: PeerChatOptions,
): Promise<unknown> {
  const raw = await http.request<Obj>({
    method: "POST",
    path,
    body: buildChatBody(query, false, opts),
    idempotent: true,
    ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const content = (raw.content as string | null | undefined) ?? null;
  if (opts.includeEvidence) {
    const response: ChatResponse = {
      content,
      evidence: evidenceFromWire(raw.evidence),
      citations: Array.isArray(raw.citations) ? (raw.citations as string[]) : [],
      confidence: typeof raw.confidence === "number" ? raw.confidence : null,
      abstained: raw.abstained === true,
    };
    return response;
  }
  if (opts.responseFormat === undefined || content === null) return content;
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new RecallError(
      "The model did not return valid JSON for the requested responseFormat",
      0,
      {
        code: "invalid_json",
        body: content,
      },
    );
  }
  const { parse } = resolveFormat(opts.responseFormat);
  return parse ? parse(json) : json;
}

export async function chatStream(
  http: HttpClient,
  path: string,
  query: string,
  opts: PeerChatOptions,
): Promise<DialecticStream> {
  const response = await http.stream({
    method: "POST",
    path,
    body: buildChatBody(query, true, opts),
    headers: { accept: "text/event-stream" },
    idempotent: true,
    ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return new DialecticStream(response, opts.signal);
}
