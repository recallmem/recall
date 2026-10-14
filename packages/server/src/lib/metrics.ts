/**
 * A small Prometheus registry (text exposition format 0.0.4), process-global so
 * any module can record without plumbing. Counters and histograms live in this
 * process; queue and billing gauges are read from the database at scrape time
 * (see http/routes/hosted.ts), so they are correct whichever machine is scraped.
 */

type Labels = Record<string, string>;

const escapeLabel = (v: string) =>
  v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');

export function labelString(labels: Labels): string {
  const keys = Object.keys(labels);
  if (!keys.length) return "";
  return `{${keys.map((k) => `${k}="${escapeLabel(labels[k] ?? "")}"`).join(",")}}`;
}

const fmt = (n: number) =>
  Number.isFinite(n) ? String(n) : n > 0 ? "+Inf" : n < 0 ? "-Inf" : "NaN";

/** Series keyed by their label string; a label set is fixed at creation. */
abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: "counter" | "gauge" | "histogram",
  ) {}
  abstract lines(): string[];
  render(): string {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`, ...this.lines()]
      .join("\n")
      .concat("\n");
  }
}

const MAX_SERIES = 5_000;

export class Counter extends Metric {
  private readonly values = new Map<string, number>();
  constructor(name: string, help: string) {
    super(name, help, "counter");
  }
  inc(labels: Labels = {}, by = 1): void {
    if (!(by > 0)) return;
    const key = labelString(labels);
    if (!this.values.has(key) && this.values.size >= MAX_SERIES) return;
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }
  get(labels: Labels = {}): number {
    return this.values.get(labelString(labels)) ?? 0;
  }
  lines(): string[] {
    return [...this.values].map(([k, v]) => `${this.name}${k} ${fmt(v)}`);
  }
}

export class Histogram extends Metric {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number }>();
  constructor(
    name: string,
    help: string,
    private readonly buckets: number[],
  ) {
    super(name, help, "histogram");
  }
  observe(labels: Labels, value: number): void {
    const key = labelString(labels);
    let s = this.series.get(key);
    if (!s) {
      if (this.series.size >= MAX_SERIES) return;
      s = { labels, counts: new Array(this.buckets.length + 1).fill(0), sum: 0 };
      this.series.set(key, s);
    }
    let i = this.buckets.findIndex((b) => value <= b);
    if (i < 0) i = this.buckets.length;
    s.counts[i]! += 1;
    s.sum += value;
  }
  lines(): string[] {
    const out: string[] = [];
    for (const s of this.series.values()) {
      let cumulative = 0;
      this.buckets.forEach((b, i) => {
        cumulative += s.counts[i]!;
        out.push(`${this.name}_bucket${labelString({ ...s.labels, le: fmt(b) })} ${cumulative}`);
      });
      cumulative += s.counts[this.buckets.length]!;
      out.push(`${this.name}_bucket${labelString({ ...s.labels, le: "+Inf" })} ${cumulative}`);
      out.push(`${this.name}_sum${labelString(s.labels)} ${fmt(s.sum)}`);
      out.push(`${this.name}_count${labelString(s.labels)} ${cumulative}`);
    }
    return out;
  }
}

/** A gauge whose samples are supplied at render time. */
export class SampledGauge extends Metric {
  samples: { labels: Labels; value: number }[] = [];
  constructor(name: string, help: string) {
    super(name, help, "gauge");
  }
  lines(): string[] {
    return this.samples.map((s) => `${this.name}${labelString(s.labels)} ${fmt(s.value)}`);
  }
}

export const metrics = {
  httpRequests: new Counter(
    "recall_http_requests_total",
    "HTTP requests by method, route pattern and status.",
  ),
  httpDuration: new Histogram(
    "recall_http_request_duration_seconds",
    "HTTP request latency by method, route pattern and status class.",
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  ),
  jobFailures: new Counter(
    "recall_job_failures_total",
    "Background job failures by kind (final=true when the job will not be retried).",
  ),
  llmCalls: new Counter("recall_llm_calls_total", "LLM and embedding calls by task and model."),
  llmTokens: new Counter(
    "recall_llm_tokens_total",
    "LLM tokens by task, model and type (input, output, cache_read, cache_write).",
  ),
  llmCost: new Counter(
    "recall_llm_cost_usd_total",
    "Provider cost in USD by task and model (this process).",
  ),
  ledgerCredits: new Counter(
    "recall_ledger_credits_usd_total",
    "Customer credit added to the ledger, by kind (topup, auto_topup, signup_credit, grant).",
  ),
  ledgerDebits: new Counter(
    "recall_ledger_debits_usd_total",
    "Customer credit spent, by kind (ingest, chat_<level>, refund).",
  ),
  ledgerEntries: new Counter(
    "recall_ledger_entries_total",
    "Ledger entries written, by kind and direction (credit, debit).",
  ),
  autoTopups: new Counter(
    "recall_auto_topups_total",
    "Off-session auto top-up attempts by outcome (succeeded, failed, disabled).",
  ),
  signupCreditSkipped: new Counter(
    "recall_signup_credit_skipped_total",
    "Welcome credits withheld from new accounts, by reason (email_limit, ip_limit, daily_cap).",
  ),
  signupCreditDeferred: new Counter(
    "recall_signup_credit_deferred_total",
    "Welcome credits held back by the daily cap and settled on a later day, by outcome (granted, dropped).",
  ),
};

const startedAt = Date.now();

/** Everything in the registry plus process gauges, and any extra (DB-derived) gauges. */
export function renderMetrics(extra: SampledGauge[] = []): string {
  const process_ = new SampledGauge("process_resident_memory_bytes", "Resident memory size.");
  process_.samples = [{ labels: {}, value: process.memoryUsage().rss }];
  const uptime = new SampledGauge("process_uptime_seconds", "Seconds since the process started.");
  uptime.samples = [{ labels: {}, value: (Date.now() - startedAt) / 1000 }];
  return [...Object.values(metrics), ...extra, process_, uptime].map((m) => m.render()).join("");
}
