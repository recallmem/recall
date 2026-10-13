import { RecallConnectionError } from "./errors.js";
import type { Evidence } from "./types.js";
import { evidenceFromWire } from "./wire.js";

/**
 * A streamed chat answer. Iterate it for text deltas; afterwards `getFinalResponse()`
 * has the whole text and `evidence`, `citations`, `confidence` and `abstained` are set.
 * It can be consumed once, but `getFinalResponse()` and `toArray()` work at any point.
 */
export class DialecticStream implements AsyncIterable<string> {
  readonly #chunks: string[] = [];
  #evidence: Evidence | null = null;
  #citations: string[] = [];
  #confidence: number | null = null;
  #abstained = false;
  #done = false;
  #iterator: AsyncGenerator<string, void, undefined> | null = null;

  constructor(
    private readonly response: Response,
    private readonly signal?: AbortSignal,
  ) {}

  get evidence(): Evidence | null {
    return this.#evidence;
  }
  get citations(): string[] {
    return this.#citations;
  }
  get confidence(): number | null {
    return this.#confidence;
  }
  get abstained(): boolean {
    return this.#abstained;
  }
  /** True once the server's final event has arrived. */
  get isComplete(): boolean {
    return this.#done;
  }

  [Symbol.asyncIterator](): AsyncGenerator<string, void, undefined> {
    this.#iterator ??= this.#read();
    return this.#iterator;
  }

  /** Drains whatever has not been read yet and returns the complete answer text. */
  async getFinalResponse(): Promise<string> {
    for await (const _ of this) {
      // keep reading
    }
    return this.#chunks.join("");
  }

  /** Drains the stream and returns the deltas in order (including any already consumed). */
  async toArray(): Promise<string[]> {
    await this.getFinalResponse();
    return [...this.#chunks];
  }

  /** Cancels the underlying request. */
  async cancel(): Promise<void> {
    await this.response.body?.cancel().catch(() => undefined);
  }

  async *#read(): AsyncGenerator<string, void, undefined> {
    const body = this.response.body;
    if (!body) return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const handle = (event: string): string | undefined => {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) return undefined;
      let payload: {
        delta?: { content?: string };
        done?: boolean;
        evidence?: unknown;
        citations?: string[];
        confidence?: number;
        abstained?: boolean;
      };
      try {
        payload = JSON.parse(data);
      } catch {
        return undefined;
      }
      if (payload.done) {
        this.#done = true;
        this.#evidence = evidenceFromWire(payload.evidence);
        this.#citations = payload.citations ?? [];
        this.#confidence = payload.confidence ?? null;
        this.#abstained = payload.abstained ?? false;
      }
      const text = payload.delta?.content;
      return text ? text : undefined;
    };
    try {
      for (;;) {
        let step: ReadableStreamReadResult<Uint8Array>;
        try {
          step = await reader.read();
        } catch (err) {
          if (this.signal?.aborted) throw this.signal.reason ?? err;
          throw new RecallConnectionError(
            `Stream interrupted: ${(err as Error).message ?? String(err)}`,
            { cause: err },
          );
        }
        if (step.done) break;
        buffer += decoder.decode(step.value, { stream: true });
        for (;;) {
          const match = /\r?\n\r?\n/.exec(buffer);
          if (!match) break;
          const event = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const text = handle(event);
          if (text !== undefined) {
            this.#chunks.push(text);
            yield text;
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const text = handle(buffer);
        if (text !== undefined) {
          this.#chunks.push(text);
          yield text;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}
