import { sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { llmUsage } from "./db/schema.js";
import { metrics } from "./lib/metrics.js";
import type { UsageRecord, UsageSink } from "./llm/types.js";

/** Buffers LLM/embedding usage records and writes them in batches. */
export class UsageRecorder implements UsageSink {
  private buffer: UsageRecord[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Records whose write failed once; they get one more try, then are dropped. */
  private readonly retried = new WeakSet<UsageRecord>();

  constructor(
    private readonly db: Db,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  record(entry: UsageRecord): void {
    recordLlmMetrics(entry);
    this.buffer.push(entry);
    if (this.buffer.length >= 50) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), 2000);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.buffer;
    this.buffer = [];
    if (!batch.length) return;
    try {
      await this.db.insert(llmUsage).values(
        batch.map((r) => ({
          workspaceId: r.workspaceId,
          // Attributed now, so the account's spend survives the workspace being deleted.
          accountId: r.workspaceId
            ? sql`(SELECT account_id FROM workspaces WHERE id = ${r.workspaceId})`
            : null,
          task: r.task,
          provider: r.provider,
          model: r.model,
          inputTokens: r.usage.inputTokens,
          outputTokens: r.usage.outputTokens,
          cacheReadTokens: r.usage.cacheReadTokens,
          cacheWriteTokens: r.usage.cacheWriteTokens,
          costUsd: r.costUsd,
          costEstimated: r.costEstimated ?? null,
          latencyMs: r.latencyMs,
          createdAt: r.at,
        })),
      );
    } catch (err) {
      this.onError(err);
      // A brief database blip should not lose the provider-cost record: one more try with
      // the next batch, bounded so a database that stays down cannot grow the buffer.
      const again = batch.filter((r) => !this.retried.has(r)).slice(0, 500);
      for (const r of again) this.retried.add(r);
      if (again.length) {
        this.buffer.unshift(...again);
        this.timer ??= setTimeout(() => void this.flush(), 2000);
      }
    }
  }
}

function recordLlmMetrics(r: UsageRecord): void {
  const labels = { task: r.task, model: `${r.provider}/${r.model}` };
  metrics.llmCalls.inc(labels);
  metrics.llmTokens.inc({ ...labels, type: "input" }, r.usage.inputTokens);
  metrics.llmTokens.inc({ ...labels, type: "output" }, r.usage.outputTokens);
  metrics.llmTokens.inc({ ...labels, type: "cache_read" }, r.usage.cacheReadTokens ?? 0);
  metrics.llmTokens.inc({ ...labels, type: "cache_write" }, r.usage.cacheWriteTokens ?? 0);
  if (r.costUsd) metrics.llmCost.inc(labels, r.costUsd);
}
