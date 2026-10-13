import { type Logger, pino } from "pino";
import type Stripe from "stripe";
import { Billing } from "./billing/index.js";
import { type Config, dashboardLink } from "./config.js";
import { BudgetGuard } from "./core/accounts.js";
import { ApiKeyVerifier } from "./core/apikeys.js";
import { OAuthTokenVerifier } from "./core/oauth.js";
import { type Db, migrate, openDatabase } from "./db/client.js";
import { OpsAlerts } from "./lib/alerts.js";
import { safeErr } from "./lib/log-safety.js";
import { LogMailer, type Mailer, ResendMailer } from "./lib/mailer.js";
import { RateLimiter } from "./lib/ratelimit.js";
import { LlmClient } from "./llm/client.js";
import { EmbeddingClient } from "./llm/embeddings.js";
import { accountKeyPool, accountModels } from "./llm/key-pool.js";
import { UsageRecorder } from "./usage.js";

/** Everything a request handler or background job needs. Created once per process. */
export interface AppContext {
  config: Config;
  db: Db;
  dbKind: "postgres" | "pglite";
  llm: LlmClient;
  embeddings: EmbeddingClient;
  usage: UsageRecorder;
  /** Multi-tenant state: API key cache, per-key rate limits, spend caps. */
  tenancy: Tenancy;
  /** Prepaid credits and Stripe (hosted mode); inert when `billing.enabled` is false. */
  billing: Billing;
  /** Magic-link and billing email (Resend, or logged in development). */
  mailer: Mailer;
  log: Logger;
  close(): Promise<void>;
}

export interface Tenancy {
  keys: ApiKeyVerifier;
  /** OAuth access tokens for the MCP endpoint (hosted mode; unused when OAuth is off). */
  oauth: OAuthTokenVerifier;
  limiter: RateLimiter;
  /** Budgets of failed sign-ins per network: never emptied by a flood of new networks. */
  failures: RateLimiter;
  budget: BudgetGuard;
}

export async function createContext(
  config: Config,
  opts: {
    log?: Logger;
    stripe?: Stripe;
    mailer?: Mailer;
    usdPerEur?: () => Promise<number | null>;
  } = {},
): Promise<AppContext> {
  const alerts = new OpsAlerts();
  const log =
    opts.log ??
    pino({ level: config.logLevel, hooks: alerts.hooks, serializers: { err: safeErr } });
  const database = await openDatabase(config);
  const applied = await migrate(database.db, config.embedding.dimensions);
  if (applied.length) log.info({ applied }, "applied migrations");
  const usage = new UsageRecorder(database.db, (err) => log.error({ err }, "usage flush failed"));
  const hosted = config.hosted;
  const budget = new BudgetGuard(
    database.db,
    usage,
    config.tenancy.budgetCacheTtlMs,
    hosted.billing.enabled,
  );
  const mailer =
    opts.mailer ??
    (hosted.email.resendApiKey
      ? new ResendMailer(hosted.email.resendApiKey, hosted.email.from)
      : new LogMailer(log));
  if (hosted.email.alertTo && mailer.live)
    alerts.attach(mailer, hosted.email.alertTo, config.server.siteUrl ?? "https://recallmem.dev");
  const billing = new Billing({
    config: hosted,
    // Checkout and portal return to the dashboard's billing page (on its own host when it has one).
    dashboardLink: (path) => dashboardLink(config, path),
    db: database.db,
    log,
    budget,
    mailer,
    stripe: opts.stripe,
    usdPerEur: opts.usdPerEur,
  });
  // Benchmark accounts spend from their own OpenRouter key once one is configured, and accounts
  // enabled for experiments can run tasks on other models (operator-set account metadata).
  const llm = new LlmClient(config, usage, {
    ...(config.env.OPENROUTER_API_KEY_EVAL ? { keyPool: accountKeyPool(database.db) } : {}),
    accountModels: accountModels(database.db),
  });
  for (const [task, ref] of Object.entries(config.models)) {
    // OpenRouter reports each call's cost; mock and local models are free.
    if (/^(mock|local|openrouter)\//.test(ref) || llm.prices.price(ref)) continue;
    log.warn(
      { task, model: ref },
      "model has no price: its usage is recorded without cost and unbilled spend caps ignore it; price it with RECALL_PRICING_JSON",
    );
  }
  return {
    config,
    db: database.db,
    dbKind: database.kind,
    llm,
    embeddings: new EmbeddingClient(config, usage),
    usage,
    tenancy: {
      keys: new ApiKeyVerifier(database.db, config.tenancy.keyCacheTtlMs, (err) =>
        log.warn({ err }, "could not record API key use"),
      ),
      oauth: new OAuthTokenVerifier(database.db, config.tenancy.keyCacheTtlMs, (err) =>
        log.warn({ err }, "could not record OAuth token use"),
      ),
      limiter: new RateLimiter(),
      failures: new RateLimiter(50_000, { failClosed: true }),
      budget,
    },
    billing,
    mailer,
    log,
    async close() {
      await usage.flush();
      await database.close();
    },
  };
}
