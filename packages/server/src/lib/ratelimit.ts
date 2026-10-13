/**
 * In-process token buckets, one per key. A bucket holds up to `perMin` tokens
 * and refills continuously at `perMin / 60` tokens a second, so a key may burst
 * up to its per-minute limit and then sustain the average rate.
 *
 * Limits are per process: with N API machines a key can reach N x its limit.
 *
 * At most `maxBuckets` keys are tracked. When that many are in use, buckets that
 * have refilled are dropped first (they would start full anyway), then the least
 * recently used ones. With `failClosed` (budgets of failures, where a flood of new
 * keys must not wipe out the budget being enforced) nothing in use is dropped:
 * a key that finds no room is treated as having no tokens until room frees up.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number; cap: number }>();

  constructor(
    private readonly maxBuckets = 50_000,
    private readonly opts: { failClosed?: boolean } = {},
  ) {}

  /** Takes one token. Returns 0 when allowed, else the seconds until a token is available. */
  take(key: string, perMin: number, now = Date.now()): number {
    if (perMin <= 0) return 0;
    const ratePerMs = perMin / 60_000;
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxBuckets && !this.makeRoom(now)) return 60 / perMin;
      b = { tokens: perMin, at: now, cap: perMin };
    } else {
      b.tokens = Math.min(perMin, b.tokens + (now - b.at) * ratePerMs);
      b.at = now;
      b.cap = perMin;
      // Re-inserted to keep the map in least-recently-used order.
      this.buckets.delete(key);
    }
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return (1 - b.tokens) / ratePerMs / 1000;
  }

  /**
   * Seconds until `take` would allow one more (0 when it would now), without taking
   * anything: for budgets spent only on failures, checked before each attempt.
   */
  peek(key: string, perMin: number, now = Date.now()): number {
    if (perMin <= 0) return 0;
    const b = this.buckets.get(key);
    if (!b) {
      if (this.opts.failClosed && this.buckets.size >= this.maxBuckets && !this.makeRoom(now))
        return 60 / perMin;
      return 0;
    }
    const ratePerMs = perMin / 60_000;
    const tokens = Math.min(perMin, b.tokens + (now - b.at) * ratePerMs);
    return tokens >= 1 ? 0 : (1 - tokens) / ratePerMs / 1000;
  }

  /** Frees at least one slot; false when none may be freed (fail-closed and all in use). */
  private makeRoom(now: number): boolean {
    for (const [k, b] of this.buckets)
      if (b.tokens + ((now - b.at) * b.cap) / 60_000 >= b.cap) this.buckets.delete(k);
    if (this.buckets.size < this.maxBuckets) return true;
    if (this.opts.failClosed) return false;
    // Least recently used first: a tenth of the buckets, so this does not run on every call.
    let drop = Math.max(1, Math.floor(this.maxBuckets / 10));
    for (const k of this.buckets.keys()) {
      this.buckets.delete(k);
      if (--drop === 0) break;
    }
    return true;
  }
}
