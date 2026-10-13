import type { AppContext } from "../context.js";
import type { Evidence } from "./format.js";

export interface ChatResult {
  content: string | null;
  evidence: Evidence | null;
  citations: string[];
  confidence: number;
  abstained: boolean;
  usage: { calls: number; inputTokens: number; outputTokens: number };
  cache: "hit" | "miss";
}

interface Entry {
  value: ChatResult;
  expires: number;
}

/**
 * In-memory answer cache. Keys embed the memory versions (collection versions,
 * message and summary watermarks), so an entry simply stops being asked for
 * once memory changes; the TTL only bounds how long dead entries linger.
 * Concurrent identical non-streaming requests share one generation.
 */
export class AnswerCache {
  private readonly map = new Map<string, Entry>();
  readonly inflight = new Map<string, Promise<ChatResult>>();
  constructor(
    private readonly ttlMs: number,
    private readonly max = 500,
  ) {}

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  get(key: string): ChatResult | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key); // refresh LRU position
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: ChatResult): void {
    if (!this.enabled) return;
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  clear(): void {
    this.map.clear();
  }
}

const caches = new WeakMap<AppContext, AnswerCache>();

export function answerCache(ctx: AppContext): AnswerCache {
  let c = caches.get(ctx);
  if (!c) {
    c = new AnswerCache(ctx.config.chatCacheTtlS * 1000);
    caches.set(ctx, c);
  }
  return c;
}
