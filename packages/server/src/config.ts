import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { parseDomainList } from "./core/disposable.js";
import { type LegalLinks, legalLinks } from "./lib/legal.js";
import { CLOUDFLARE_IPS, cidrProblem } from "./lib/network.js";
import { isPasswordHash } from "./lib/passwords.js";
import { freeModelsIn, type OpenRouterRouting, parseOpenRouterRouting } from "./llm/openrouter.js";
import { DEFAULT_PRICES, type Price } from "./llm/pricing.js";

/**
 * Runtime configuration, read once from the environment.
 *
 * Every setting has a working default so `recall-server` starts with zero
 * configuration: no DATABASE_URL means embedded Postgres (PGlite), and no
 * provider key means the offline mock provider. Model choices are per task
 * so the cheap bulk work (background reasoning, summaries) never runs on the
 * expensive model that answers hard questions.
 */

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase()),
  );

const int = (def: number) => z.coerce.number().int().default(def);

/** `RECALL_CORS_ORIGINS`: comma-separated origins (trailing slashes dropped); unset or `*` allows any. */
function parseOrigins(raw: string | undefined): string[] | null {
  const list = (raw ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return list.length === 0 || list.includes("*") ? null : list;
}

const EnvSchema = z.object({
  RECALL_DATABASE_URL: z.string().optional(),
  /** Max connections per process (keep the sum across machines under the pooler's limit). */
  RECALL_DATABASE_POOL_MAX: int(20),
  /** Longest a single SQL statement may run (ms; 0 = no limit), so no request can pin a database core. */
  RECALL_DATABASE_STATEMENT_TIMEOUT_MS: int(60_000),
  /** PEM CA certificate to verify the Postgres server against (e.g. Supabase's). */
  RECALL_DATABASE_CA: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  RECALL_DATA_DIR: z.string().default("./.recall"),
  RECALL_HOST: z.string().default("0.0.0.0"),
  RECALL_PORT: int(8000),
  RECALL_ROLE: z.enum(["all", "api", "worker"]).default("all"),
  RECALL_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  RECALL_PUBLIC_URL: z.string().optional(),
  /**
   * Origin of the customer dashboard (/app) when it has its own host, e.g.
   * `https://app.example.com`. Default: RECALL_PUBLIC_URL (one host for everything).
   */
  RECALL_DASHBOARD_URL: z.string().optional(),
  /**
   * Origin of the marketing site and docs when they have their own host, e.g.
   * `https://example.com` while the API is at RECALL_PUBLIC_URL `https://api.example.com`.
   * Default: RECALL_PUBLIC_URL.
   */
  RECALL_SITE_URL: z.string().optional(),
  /**
   * Browser origins allowed to call the API (comma-separated, e.g. `https://app.example.com`).
   * Unset: any origin (the API authenticates with bearer tokens, not cookies).
   */
  RECALL_CORS_ORIGINS: z.string().optional(),
  /**
   * Where the client's IP address (per-IP limits) comes from: `auto` (default: Vercel or Fly.io
   * when detected, else the socket), `vercel`, `fly`, `none` (the socket), or a number of
   * reverse proxies that each append to X-Forwarded-For.
   */
  RECALL_TRUSTED_PROXY: z.string().optional(),
  /** A request header the proxy in front sets to the client's address (overrides the above). */
  RECALL_CLIENT_IP_HEADER: z.string().optional(),
  /**
   * Only with Cloudflare's proxy in front: `on` (Cloudflare's published ranges, built in) or
   * comma-separated CIDRs. A request whose address is in them uses `CF-Connecting-IP`. Unset or
   * `off` (the default, for DNS-only setups): that header is never read.
   */
  RECALL_CLOUDFLARE_IPS: z.string().optional(),
  /** Set by Vercel at runtime ("1"); used to detect the platform. */
  VERCEL: z.string().optional(),
  /** Set by Fly.io on its machines; used to detect the platform. */
  FLY_APP_NAME: z.string().optional(),

  RECALL_AUTH_ENABLED: bool.default(false),
  RECALL_AUTH_SECRET: z.string().optional(),
  /** Hosted (multi-tenant) mode: refuses to start without auth and an admin token. */
  RECALL_HOSTED: bool.default(false),
  /** Bearer token for the operator control plane (/admin/v1); the routes are off when unset. */
  RECALL_ADMIN_TOKEN: z.string().optional(),
  /** Default per-API-key rate limit, requests per minute (0 = unlimited). */
  RECALL_KEY_RATE_LIMIT: int(600),
  /**
   * Chat questions (the LLM-heavy routes: REST chat, the MCP chat tools, the dashboard
   * playground) per minute per API key, OAuth connection or dashboard account; 0 = unlimited.
   */
  RECALL_KEY_CHAT_RATE_LIMIT: int(60),
  /** Failed API credentials (bad API key or JWT) per minute per client network before 429s; 0 = off. */
  RECALL_AUTH_FAILURE_LIMIT: int(30),
  /** How long a verified API key is cached in-process; bounds how fast a revocation lands. */
  RECALL_KEY_CACHE_TTL_MS: int(5_000),
  /** How long an account's month-to-date spend is cached before budget checks re-read it. */
  RECALL_BUDGET_CACHE_TTL_MS: int(15_000),
  /** While an account is over budget, its background reasoning is retried after this delay. */
  RECALL_BUDGET_RETRY_MS: int(300_000),

  RECALL_DEFAULT_PROVIDER: z.enum(["anthropic", "openai", "gemini", "openrouter"]).optional(),
  RECALL_MODEL_REASONER: z.string().optional(),
  RECALL_MODEL_SUMMARY: z.string().optional(),
  RECALL_MODEL_CARD: z.string().optional(),
  RECALL_MODEL_DREAM: z.string().optional(),
  RECALL_MODEL_CHAT_MINIMAL: z.string().optional(),
  RECALL_MODEL_CHAT_LOW: z.string().optional(),
  RECALL_MODEL_CHAT_MEDIUM: z.string().optional(),
  RECALL_MODEL_CHAT_HIGH: z.string().optional(),
  RECALL_MODEL_CHAT_MAX: z.string().optional(),
  RECALL_EMBEDDING_MODEL: z.string().optional(),
  RECALL_EMBEDDING_DIMENSIONS: int(1536),
  /** JSON object of "provider/model" -> {input, output, cacheRead?, cacheWrite?} USD per 1M tokens. */
  RECALL_PRICING_JSON: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  /** Separate OpenRouter key (own budget) for accounts whose metadata has llm_key: "eval". */
  OPENROUTER_API_KEY_EVAL: z.string().optional(),
  /**
   * Per-task OpenRouter routing (JSON, see the docs: recallmem.dev/docs#openrouter), e.g.
   * {"default": {"sort": "price", "data_collection": "deny"}, "reasoner": {"fallbacks": ["openai/gpt-oss-120b"]}}.
   */
  RECALL_OPENROUTER_ROUTING: z.string().optional(),
  RECALL_ANSWER_FALLBACK: z.string().optional(),
  /** Allow ":free" OpenRouter models in hosted mode (they may log or train on prompts). */
  RECALL_OPENROUTER_ALLOW_FREE: bool.default(false),
  /** Price OpenRouter models missing from the price table with its public list prices (fetched lazily). */
  RECALL_OPENROUTER_LIVE_PRICES: bool.default(true),
  GROQ_API_KEY: z.string().optional(),
  /** xAI's Grok models: "xai/<model>". */
  XAI_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  /** Together AI: "together/<model>" (serverless) and "together-dedicated/<project>/<endpoint>" (fine-tunes). */
  TOGETHER_API_KEY: z.string().optional(),
  /** Fireworks AI: "fireworks/accounts/<account>/models/<model>". */
  FIREWORKS_API_KEY: z.string().optional(),
  /** Any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, Together...). Use models as "compat/<name>". */
  RECALL_COMPAT_BASE_URL: z.string().optional(),
  RECALL_COMPAT_API_KEY: z.string().optional(),

  RECALL_WORKER_CONCURRENCY: int(4),
  RECALL_WORKER_POLL_MS: int(1000),
  RECALL_QUEUE_MAX_ATTEMPTS: int(5),
  /** A claimed job's lease; the worker extends it while the job runs, and expired leases are reclaimed. */
  RECALL_WORKER_LEASE_MS: int(120_000),
  /** First retry delay; doubles per attempt (capped at 10 minutes). */
  RECALL_WORKER_RETRY_BASE_MS: int(2_000),
  /** Serverless (Vercel): bearer token for POST /internal/tick, which runs queued jobs. */
  RECALL_CRON_SECRET: z.string().min(16).optional(),
  /** Background reasoning runs once this many tokens of unprocessed messages pile up in a session... */
  RECALL_REASONER_BATCH_TOKENS: int(1200),
  /** ...or once the oldest unprocessed message is this old, whichever comes first... */
  RECALL_REASONER_MAX_DELAY_MS: int(15_000),
  /** ...or once no new message has arrived in the session for this long (a finished exchange). */
  RECALL_REASONER_IDLE_MS: int(5_000),
  /** Largest transcript window per extraction call; smaller reads more carefully, costs more calls. */
  RECALL_REASONER_WINDOW_TOKENS: int(4000),
  RECALL_REASONER_ENABLED: bool.default(true),
  RECALL_DREAMS_ENABLED: bool.default(true),
  RECALL_SUMMARIES_ENABLED: bool.default(true),
  RECALL_WEBHOOKS_ENABLED: bool.default(true),
  RECALL_CHAT_CACHE_TTL_S: int(300),
  /** Dreams: new conclusions in a collection since its last dream before one is scheduled... */
  RECALL_DREAM_MIN_NEW_CONCLUSIONS: int(50),
  /** ...once the collection has been quiet this long... */
  RECALL_DREAM_IDLE_MS: int(600_000),
  /** ...and at least this long after the previous dream (manual dreams bypass all three). */
  RECALL_DREAM_MIN_INTERVAL_MS: int(3_600_000),
  /** Webhook signing secret (HMAC-SHA256, X-Recall-Signature). Without it, events are not sent. */
  RECALL_WEBHOOK_SECRET: z.string().optional(),
  /** Allow webhook delivery to private/loopback addresses (local development only). */
  RECALL_WEBHOOK_ALLOW_PRIVATE: bool.default(false),

  // ---- Hosted onboarding, dashboard and billing (all off unless RECALL_HOSTED=true) ----
  /** Self-serve sign-up at /app. Default: on when billing is configured, off otherwise. */
  RECALL_SIGNUP_ENABLED: bool.optional(),
  /**
   * App-directory review: the one account that may sign in with a password instead of an email
   * link (Anthropic and OpenAI reviewers need that). Set both; the hash comes from
   * `node scripts/hash-password.mjs`. The account must already exist.
   */
  RECALL_REVIEWER_EMAIL: z.string().trim().toLowerCase().email().optional(),
  RECALL_REVIEWER_PASSWORD_HASH: z
    .string()
    .trim()
    .refine(isPasswordHash, "a hash from scripts/hash-password.mjs (scrypt$N$salt$hash)")
    .optional(),
  /** Signs dashboard session cookies and CSRF tokens; derived from RECALL_AUTH_SECRET when unset. */
  RECALL_SESSION_SECRET: z.string().optional(),
  RECALL_SESSION_TTL_DAYS: int(30),
  /** Resend (https://resend.com) API key for magic-link email; without it the link is logged. */
  RESEND_API_KEY: z.string().optional(),
  /** Sender, e.g. "Recall <login@mail.example.com>" (a domain verified in Resend). */
  RECALL_EMAIL_FROM: z.string().optional(),
  /** Where error alerts go (needs RESEND_API_KEY): one email per distinct error per 15 minutes. */
  RECALL_ALERT_EMAIL: z.string().email().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /** Optional customer-portal configuration id (bpc_...); Stripe's default configuration otherwise. */
  STRIPE_PORTAL_CONFIGURATION: z.string().optional(),
  /**
   * Your Stripe custom domain for Checkout and the portal (e.g. pay.example.com), so the
   * dashboard's billing forms may redirect there; checkout.stripe.com stays allowed.
   */
  STRIPE_CUSTOM_DOMAIN: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
      "a host name, e.g. pay.example.com",
    )
    .optional(),
  /** Ask Stripe Checkout to issue an invoice for each top-up (Stripe Invoicing fees apply). */
  RECALL_STRIPE_INVOICES: bool.default(true),
  /**
   * Stripe Tax on top-ups: credit prices exclude tax and Stripe adds VAT/sales tax where you are
   * registered (set up Stripe Tax and your registrations first). Needs RECALL_STRIPE_INVOICES.
   */
  RECALL_STRIPE_TAX: bool.default(false),
  /**
   * Your terms page: when set, Checkout requires ticking "I agree to the Terms of Service and ask
   * Recall to make the credit available immediately" (with the consumer withdrawal right). Stripe
   * needs the same URL under Settings > Public details first.
   */
  RECALL_CHECKOUT_TERMS_URL: z.string().url().startsWith("https://").optional(),
  /**
   * Currency Checkout charges for credit, which is always in USD. `eur` charges the euro amount at
   * the European Central Bank's daily rate: local methods such as iDEAL and Bancontact need euros,
   * and Stripe can then show customers outside the euro area their own currency. Falls back to
   * USD while no rate is known.
   */
  RECALL_CHECKOUT_CURRENCY: z.enum(["usd", "eur"]).default("eur"),
  /**
   * Origin of your legal pages (/terms, /privacy, /dpa, /security, /support), e.g.
   * https://recallmem.dev. When set, the dashboard links to them, sign-in records acceptance of
   * the current terms version, auto top-up asks for consent, and every top-up gets the withdrawal
   * notice on its invoice and a confirmation email.
   */
  RECALL_LEGAL_URL: z.string().url().startsWith("https://").optional(),
  /**
   * Your own VAT number, printed on every top-up invoice as "Seller VAT number" (EU invoices must
   * show it). Leave unset when it is a tax ID in your Stripe settings, which prints it already.
   */
  RECALL_INVOICE_VAT_NUMBER: z.string().trim().min(1).max(140).optional(),
  // Customer price list in USD; the defaults are the hosted service's list prices.
  RECALL_PRICE_INGEST_PER_MTOK_USD: z.coerce.number().min(0).default(1.75),
  /**
   * Each message is billed as at least this many tokens: reasoning costs about the same per message
   * however short it is, so very short messages would otherwise be billed below cost.
   */
  RECALL_PRICE_INGEST_MIN_TOKENS: z.coerce.number().int().min(0).default(50),
  RECALL_PRICE_CHAT_MINIMAL_USD: z.coerce.number().min(0).default(0.0008),
  RECALL_PRICE_CHAT_LOW_USD: z.coerce.number().min(0).default(0.005),
  RECALL_PRICE_CHAT_MEDIUM_USD: z.coerce.number().min(0).default(0.025),
  RECALL_PRICE_CHAT_HIGH_USD: z.coerce.number().min(0).default(0.05),
  RECALL_PRICE_CHAT_MAX_USD: z.coerce.number().min(0).default(0.25),
  /** Free credit granted once to each new self-serve account. */
  RECALL_SIGNUP_CREDIT_USD: z.coerce.number().min(0).default(5),
  /** Welcome credits per client network (IPv4 address or IPv6 /64) within 30 days; 0 = no limit. */
  RECALL_SIGNUP_CREDIT_PER_IP: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().min(0).default(1),
  ),
  /** Most welcome credit granted per UTC day across all sign-ups, USD; 0 = no cap. */
  RECALL_SIGNUP_CREDIT_DAILY_CAP_USD: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().min(0).default(50),
  ),
  /** Extra email domains (comma-separated, subdomains included) refused for new sign-ups, besides the built-in disposable list. */
  RECALL_SIGNUP_BLOCKED_DOMAINS: z.string().optional(),
  /**
   * Dashboard users (comma-separated email addresses) who may open the operator console at
   * <dashboard>/admin. Unset: nobody (the console answers 404 like any unknown page).
   */
  RECALL_OPERATOR_EMAILS: z.string().optional(),
  /**
   * Weekly activation-funnel email to the operator (Mondays from 08:00 Europe/Amsterdam): to
   * RECALL_ALERT_EMAIL, else to RECALL_OPERATOR_EMAILS. `false` turns it off.
   */
  RECALL_FUNNEL_REPORT_ENABLED: bool.default(true),
  /** Top-up amounts offered as buttons, comma-separated USD. */
  RECALL_TOPUP_AMOUNTS_USD: z.string().default("10,25,50,100"),
  /** $10: below it, Stripe's fixed fee per payment is a large share of the top-up. */
  RECALL_TOPUP_MIN_USD: z.coerce.number().min(1).default(10),
  RECALL_TOPUP_MAX_USD: z.coerce.number().min(1).default(1000),
  /** Bearer token for GET /metrics. Required in hosted mode (the endpoint is off without it). */
  RECALL_METRICS_TOKEN: z.string().optional(),
  /**
   * OAuth 2.1 sign-in for the MCP endpoint (MCP clients connect without an API key). Default: on
   * whenever the dashboard is (hosted mode with RECALL_PUBLIC_URL); `false` switches it off.
   */
  RECALL_OAUTH_ENABLED: bool.optional(),
  /** Lifetime of an OAuth access token, seconds (60 to 86,400). */
  RECALL_OAUTH_ACCESS_TOKEN_TTL_S: int(3600),
  /** A refresh token expires after this many days unused (each refresh issues a new one); 1 to 365. */
  RECALL_OAUTH_REFRESH_TOKEN_TTL_DAYS: int(30),
  /** Dynamic client registrations per client network per hour (0 = unlimited). */
  RECALL_OAUTH_REGISTRATIONS_PER_HOUR: int(60),
  /** Token and revocation requests per minute per client network, and code exchanges per client (0 = unlimited). */
  RECALL_OAUTH_TOKEN_RATE_LIMIT: int(120),
});

export type Env = z.infer<typeof EnvSchema>;

export type LlmTask =
  | "reasoner"
  | "summary"
  | "card"
  | "dream"
  | "chat_minimal"
  | "chat_low"
  | "chat_medium"
  | "chat_high"
  | "chat_max";

export interface Config {
  env: Env;
  database:
    | {
        kind: "postgres";
        url: string;
        poolMax: number;
        ca: string | null;
        statementTimeoutMs: number;
      }
    | { kind: "pglite"; dataDir: string | null };
  server: {
    host: string;
    port: number;
    publicUrl: string | null;
    /**
     * Base URL of the dashboard (/app, sign-in links, the OAuth consent screen): RECALL_DASHBOARD_URL's
     * origin, else RECALL_PUBLIC_URL (without a trailing slash); null without either.
     */
    dashboardUrl: string | null;
    /** True when the dashboard has a host of its own (RECALL_DASHBOARD_URL differs from the public origin). */
    splitDashboard: boolean;
    /** Origin of the site and docs: RECALL_SITE_URL, else RECALL_PUBLIC_URL's origin; null without either. */
    siteUrl: string | null;
    /** True when the site has a host of its own (RECALL_SITE_URL differs from the public origin). */
    splitSite: boolean;
    /** Allowed browser origins; null allows any. */
    corsOrigins: string[] | null;
    /** Where the client's IP address is read from (http/common.ts clientIp). */
    clientIp: ClientIpConfig;
  };
  role: "all" | "api" | "worker";
  logLevel: Env["RECALL_LOG_LEVEL"];
  auth: { enabled: boolean; secret: string | null };
  tenancy: {
    hosted: boolean;
    adminToken: string | null;
    keyRateLimitPerMin: number;
    /** Chat questions per minute per key/connection/dashboard account (0 = unlimited). */
    chatRateLimitPerMin: number;
    /** Failed credential checks per minute per client network (0 = off). */
    authFailuresPerMin: number;
    keyCacheTtlMs: number;
    budgetCacheTtlMs: number;
    budgetRetryMs: number;
  };
  models: Record<LlmTask, string>;
  embedding: { model: string; dimensions: number };
  worker: {
    concurrency: number;
    pollMs: number;
    maxAttempts: number;
    leaseMs: number;
    retryBaseMs: number;
    /** Serverless: bearer token for POST /internal/tick; null disables the endpoint. */
    cronSecret: string | null;
  };
  reasoner: {
    enabled: boolean;
    batchTokens: number;
    maxDelayMs: number;
    /** A batch below `batchTokens` runs once the session has been quiet this long (capped by maxDelayMs). */
    idleMs: number;
    windowTokens: number;
  };
  features: { dreams: boolean; summaries: boolean; webhooks: boolean };
  chatCacheTtlS: number;
  dreams: { minNewConclusions: number; idleMs: number; minIntervalMs: number };
  webhook: { secret: string | null; allowPrivateHosts: boolean };
  pricingOverrides: Record<string, unknown>;
  /** "openrouter/..." models: per-task routing and data-policy rules. */
  openrouter: { routing: OpenRouterRouting; allowFree: boolean; livePrices: boolean };
  hosted: HostedConfig;
}

export type ChatLevel = "minimal" | "low" | "medium" | "high" | "max";

/** Self-serve dashboard, email, Stripe billing and metrics. */
export interface HostedConfig {
  /** The /app dashboard (hosted mode with RECALL_PUBLIC_URL set). */
  dashboard: boolean;
  signup: boolean;
  /** Operator-listed email domains refused for new sign-ups, in addition to the built-in disposable list. */
  signupBlockedDomains: string[];
  /** The operator's legal pages (RECALL_LEGAL_URL), if any. */
  legal: LegalLinks | null;
  /** The app-directory reviewer who may sign in with a password, if configured. */
  reviewer: { email: string; passwordHash: string } | null;
  /** Signed-in dashboard users allowed into the operator console (lower-cased emails). */
  operatorEmails: string[];
  /** The weekly activation-funnel email to the operator (RECALL_FUNNEL_REPORT_ENABLED). */
  funnelReport: boolean;
  /** Key for session cookies and CSRF tokens (32 bytes). */
  sessionSecret: Buffer;
  sessionTtlMs: number;
  email: { resendApiKey: string | null; from: string; alertTo: string | null };
  /** Prepaid billing: hosted mode and Stripe configured. */
  billing: {
    enabled: boolean;
    stripeSecretKey: string | null;
    stripeWebhookSecret: string | null;
    portalConfiguration: string | null;
    /** Stripe custom domain (host name) that Checkout and portal links use, if any. */
    customDomain: string | null;
    invoices: boolean;
    tax: boolean;
    /** Terms page the customer must accept at Checkout, if set. */
    checkoutTermsUrl: string | null;
    /** Currency Checkout charges in; credit stays in USD. */
    checkoutCurrency: "usd" | "eur";
    /** The seller's VAT number, added to invoices as a field. */
    invoiceVatNumber: string | null;
    /** Integer micro-USD (1 USD = 1,000,000). */
    prices: {
      ingestPerMTokMicros: number;
      /** Minimum billed tokens per message. */
      ingestMinTokens: number;
      chatMicros: Record<ChatLevel, number>;
    };
    signupCreditMicros: number;
    /** Welcome credits per client network within 30 days (0 = no limit). */
    signupCreditPerIp: number;
    /** Most welcome credit granted per UTC day, in micro-USD (0 = no cap). */
    signupCreditDailyCapMicros: number;
    topupAmountsMicros: number[];
    topupMinMicros: number;
    topupMaxMicros: number;
  };
  metrics: { token: string | null; requireToken: boolean };
  oauth: OAuthConfig;
}

/** OAuth 2.1 authorization server for the MCP endpoint (hosted mode, needs the dashboard for sign-in). */
export interface OAuthConfig {
  enabled: boolean;
  /** The issuer: RECALL_PUBLIC_URL's origin ("" when OAuth is off). */
  issuer: string;
  /**
   * The authorization endpoint: on the dashboard's host, because the consent screen needs the
   * dashboard's (host-only) session cookie. `${issuer}/oauth/authorize` with a single host.
   */
  authorizationEndpoint: string;
  /** The protected resource (RFC 8707 / RFC 9728): `${issuer}/mcp`. */
  resource: string;
  accessTtlMs: number;
  refreshTtlMs: number;
  /** Authorization codes are single use and live this long. */
  codeTtlMs: number;
  registrationsPerHour: number;
  /** Token/revocation requests per minute per client network, and code exchanges per client; 0 = off. */
  tokenRatePerMin: number;
  /** MAC key that binds refresh tokens to their grant, so reuse is detected after the used token is purged. */
  tokenKey: Buffer;
}

/** The origin of an absolute http(s) URL, or null. */
function originOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** An origin setting (scheme, host and optional port, no path), or null when unset. */
function hostSetting(name: "RECALL_DASHBOARD_URL" | "RECALL_SITE_URL", env: Env): string | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const origin = originOf(raw);
  if (!origin || new URL(raw).pathname.replace(/\/+$/, "") !== "" || /[?#]/.test(raw))
    throw new Error(
      `${name} must be an http(s) origin without a path, e.g. https://app.example.com`,
    );
  return origin;
}

/** The dashboard's own origin (RECALL_DASHBOARD_URL), or null: it then lives at RECALL_PUBLIC_URL. */
const dashboardOrigin = (env: Env) => hostSetting("RECALL_DASHBOARD_URL", env);

function oauthConfig(env: Env, dashboard: boolean, key: Buffer): OAuthConfig {
  const issuer = originOf(env.RECALL_PUBLIC_URL);
  const enabled = dashboard && !!issuer && (env.RECALL_OAUTH_ENABLED ?? true);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    enabled,
    issuer: enabled ? issuer! : "",
    authorizationEndpoint: enabled ? `${dashboardOrigin(env) ?? issuer}/oauth/authorize` : "",
    resource: enabled ? `${issuer}/mcp` : "",
    accessTtlMs: clamp(env.RECALL_OAUTH_ACCESS_TOKEN_TTL_S, 60, 86_400) * 1000,
    refreshTtlMs: clamp(env.RECALL_OAUTH_REFRESH_TOKEN_TTL_DAYS, 1, 365) * 86_400_000,
    codeTtlMs: 60_000,
    registrationsPerHour: Math.max(0, env.RECALL_OAUTH_REGISTRATIONS_PER_HOUR),
    tokenRatePerMin: Math.max(0, env.RECALL_OAUTH_TOKEN_RATE_LIMIT),
    tokenKey: createHmac("sha256", key).update("recall-oauth-refresh-v1").digest(),
  };
}

/**
 * Where the client's IP address comes from (per-IP limits: sign-in links, welcome credit,
 * OAuth registration and token requests). Only a header that the proxy in front sets and
 * overwrites can be trusted: anything else a client can send itself.
 *
 * - `header`: one header set by the trusted proxy (Fly's `fly-client-ip`, Vercel's
 *   `x-vercel-forwarded-for`, or one the operator names);
 * - `forwarded`: X-Forwarded-For, to which `hops` trusted proxies each append the address they
 *   saw: the entry `hops` places from the right (entries further left are the client's own);
 * - `socket`: the TCP peer (no proxy, or an unknown one).
 */
export type ClientIpSource =
  | { kind: "header"; header: string }
  | { kind: "forwarded"; hops: number }
  | { kind: "socket" };

export interface ClientIpConfig {
  source: ClientIpSource;
  /**
   * Cloudflare's edge ranges when its proxy is in front (RECALL_CLOUDFLARE_IPS), else null: when
   * the address from `source` is in one of them, the request came through Cloudflare and
   * `CF-Connecting-IP` (which Cloudflare overwrites) is the client. From any other address, and
   * always when null, that header is the client's own and is ignored.
   */
  cloudflare: readonly string[] | null;
}

function cloudflareRanges(env: Env): readonly string[] | null {
  const raw = env.RECALL_CLOUDFLARE_IPS?.trim() ?? "";
  if (["", "off", "none", "false", "0"].includes(raw.toLowerCase())) return null;
  if (["on", "true", "1", "cloudflare"].includes(raw.toLowerCase())) return CLOUDFLARE_IPS;
  const ranges = raw.split(/[\s,]+/).filter(Boolean);
  for (const r of ranges) {
    const problem = cidrProblem(r);
    if (problem) throw new Error(`RECALL_CLOUDFLARE_IPS: ${problem}`);
  }
  return ranges;
}

export function clientIpConfig(env: Env): ClientIpConfig {
  return { source: clientIpSource(env), cloudflare: cloudflareRanges(env) };
}

export function clientIpSource(env: Env): ClientIpSource {
  const proxy = (env.RECALL_TRUSTED_PROXY ?? "auto").trim().toLowerCase() || "auto";
  const hops = /^\d{1,2}$/.test(proxy) ? Number(proxy) : null;
  const header = env.RECALL_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (header) {
    if (!/^[a-z0-9-]{1,100}$/.test(header))
      throw new Error("RECALL_CLIENT_IP_HEADER must be a header name, e.g. x-real-ip");
    if (header === "x-forwarded-for") return { kind: "forwarded", hops: hops || 1 };
    return { kind: "header", header };
  }
  const platform =
    proxy === "auto" ? (env.VERCEL ? "vercel" : env.FLY_APP_NAME ? "fly" : "none") : proxy;
  if (platform === "vercel") return { kind: "header", header: "x-vercel-forwarded-for" };
  if (platform === "fly") return { kind: "header", header: "fly-client-ip" };
  if (platform === "none" || hops === 0) return { kind: "socket" };
  if (hops !== null) return { kind: "forwarded", hops };
  throw new Error(
    "RECALL_TRUSTED_PROXY must be auto, vercel, fly, none, or the number of proxies that append to X-Forwarded-For",
  );
}

/** The dashboard's base path: "" when it has its own host (it lives at that host's root), else "/app". */
export const dashboardBase = (config: Pick<Config, "server">): string =>
  config.server.splitDashboard ? "" : "/app";

/** `path` ("/keys", "/", "/?msg=x") under `base` ("" or "/app"): "/app" itself for the root. */
export function joinBase(base: string, path: string): string {
  if (!path.startsWith("/")) throw new Error(`dashboard paths start with "/": ${path}`);
  if (path === "/" || path.startsWith("/?") || path.startsWith("/#"))
    return base ? `${base}${path.slice(1)}` : path;
  return `${base}${path}`;
}

/**
 * The site's home page as the dashboard links to it: "/" while both share a host, else the
 * site's own origin (RECALL_SITE_URL, or the public URL when only the dashboard moved).
 */
export function siteHome(config: Pick<Config, "server">): string {
  const { splitDashboard, splitSite, siteUrl } = config.server;
  return (splitDashboard || splitSite) && siteUrl ? `${siteUrl}/` : "/";
}

/** An absolute link to a dashboard page (emails, Stripe return URLs, operator sign-in links). */
export function dashboardLink(config: Pick<Config, "server">, path: string): string {
  return `${config.server.dashboardUrl ?? ""}${joinBase(dashboardBase(config), path)}`;
}

export const usdToMicros = (usd: number): number => Math.round(usd * 1_000_000);

export function hostedConfig(env: Env): HostedConfig {
  const billingEnabled =
    env.RECALL_HOSTED && !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET;
  const amounts = env.RECALL_TOPUP_AMOUNTS_USD.split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0)
    .map(usdToMicros);
  const keyMaterial = env.RECALL_SESSION_SECRET ?? env.RECALL_AUTH_SECRET ?? randomHex();
  // Magic links must not trust the Host header, so the dashboard needs the public URL.
  const dashboard = env.RECALL_HOSTED && !!env.RECALL_PUBLIC_URL;
  return {
    dashboard,
    signup: env.RECALL_HOSTED && (env.RECALL_SIGNUP_ENABLED ?? billingEnabled),
    signupBlockedDomains: parseDomainList(env.RECALL_SIGNUP_BLOCKED_DOMAINS),
    legal: env.RECALL_LEGAL_URL ? legalLinks(new URL(env.RECALL_LEGAL_URL).origin) : null,
    reviewer:
      env.RECALL_REVIEWER_EMAIL && env.RECALL_REVIEWER_PASSWORD_HASH
        ? { email: env.RECALL_REVIEWER_EMAIL, passwordHash: env.RECALL_REVIEWER_PASSWORD_HASH }
        : null,
    operatorEmails: parseEmailList(env.RECALL_OPERATOR_EMAILS),
    funnelReport: env.RECALL_FUNNEL_REPORT_ENABLED,
    sessionSecret: createHmac("sha256", keyMaterial).update("recall-dashboard-v1").digest(),
    sessionTtlMs: Math.max(1, env.RECALL_SESSION_TTL_DAYS) * 86_400_000,
    email: {
      resendApiKey: env.RESEND_API_KEY ?? null,
      from: env.RECALL_EMAIL_FROM ?? "Recall <login@localhost>",
      alertTo: env.RECALL_ALERT_EMAIL ?? null,
    },
    billing: {
      enabled: billingEnabled,
      stripeSecretKey: env.STRIPE_SECRET_KEY ?? null,
      stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
      portalConfiguration: env.STRIPE_PORTAL_CONFIGURATION ?? null,
      customDomain: env.STRIPE_CUSTOM_DOMAIN ?? null,
      invoices: env.RECALL_STRIPE_INVOICES,
      tax: env.RECALL_STRIPE_TAX,
      checkoutTermsUrl: env.RECALL_CHECKOUT_TERMS_URL ?? null,
      checkoutCurrency: env.RECALL_CHECKOUT_CURRENCY,
      invoiceVatNumber: env.RECALL_INVOICE_VAT_NUMBER ?? null,
      prices: {
        ingestPerMTokMicros: usdToMicros(env.RECALL_PRICE_INGEST_PER_MTOK_USD),
        ingestMinTokens: env.RECALL_PRICE_INGEST_MIN_TOKENS,
        chatMicros: {
          minimal: usdToMicros(env.RECALL_PRICE_CHAT_MINIMAL_USD),
          low: usdToMicros(env.RECALL_PRICE_CHAT_LOW_USD),
          medium: usdToMicros(env.RECALL_PRICE_CHAT_MEDIUM_USD),
          high: usdToMicros(env.RECALL_PRICE_CHAT_HIGH_USD),
          max: usdToMicros(env.RECALL_PRICE_CHAT_MAX_USD),
        },
      },
      signupCreditMicros: usdToMicros(env.RECALL_SIGNUP_CREDIT_USD),
      signupCreditPerIp: env.RECALL_SIGNUP_CREDIT_PER_IP,
      signupCreditDailyCapMicros: usdToMicros(env.RECALL_SIGNUP_CREDIT_DAILY_CAP_USD),
      topupAmountsMicros: amounts.length ? amounts : [usdToMicros(25)],
      topupMinMicros: usdToMicros(env.RECALL_TOPUP_MIN_USD),
      topupMaxMicros: usdToMicros(Math.max(env.RECALL_TOPUP_MIN_USD, env.RECALL_TOPUP_MAX_USD)),
    },
    metrics: { token: env.RECALL_METRICS_TOKEN ?? null, requireToken: env.RECALL_HOSTED },
    oauth: oauthConfig(env, dashboard, Buffer.from(keyMaterial, "utf8")),
  };
}

/** A comma- or space-separated list of email addresses, lower-cased and de-duplicated. */
export function parseEmailList(raw: string | undefined): string[] {
  const emails = (raw ?? "")
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+$/.test(e));
  return [...new Set(emails)];
}

const randomHex = () => randomBytes(32).toString("hex");

/**
 * Per-provider model choices for each task. Bulk background work uses each
 * provider's cheapest capable tier; chat escalates only at high/max levels.
 */
const PROVIDER_MODELS: Record<string, Record<LlmTask, string>> = {
  anthropic: {
    reasoner: "claude-haiku-5-5",
    summary: "claude-haiku-5-5",
    card: "claude-haiku-5-5",
    dream: "claude-haiku-5-5",
    chat_minimal: "claude-haiku-5-5",
    chat_low: "claude-haiku-5-5",
    chat_medium: "claude-haiku-5-5",
    chat_high: "claude-sonnet-5-5",
    chat_max: "claude-opus-5-5",
  },
  openai: {
    reasoner: "gpt-6-luna",
    summary: "gpt-6-luna",
    card: "gpt-6-luna",
    dream: "gpt-6-luna",
    chat_minimal: "gpt-6-luna",
    chat_low: "gpt-6-luna",
    chat_medium: "gpt-6-luna",
    chat_high: "gpt-6-luna",
    chat_max: "gpt-6-luna",
  },
  // One OpenRouter key for everything: the same OpenAI models, metered at OpenRouter's reported cost.
  // RECALL_MODEL_<TASK> picks another model (any vendor on OpenRouter) for a single task.
  openrouter: {
    reasoner: "openai/gpt-6-luna",
    summary: "openai/gpt-6-luna",
    card: "openai/gpt-6-luna",
    dream: "openai/gpt-6-luna",
    chat_minimal: "openai/gpt-6-luna",
    chat_low: "openai/gpt-6-luna",
    chat_medium: "openai/gpt-6-luna",
    chat_high: "openai/gpt-6-luna",
    chat_max: "openai/gpt-6-luna",
  },
  gemini: {
    reasoner: "gemini-2.5-flash-lite",
    summary: "gemini-2.5-flash-lite",
    card: "gemini-2.5-flash-lite",
    dream: "gemini-2.5-flash",
    chat_minimal: "gemini-2.5-flash-lite",
    chat_low: "gemini-2.5-flash",
    chat_medium: "gemini-2.5-flash",
    chat_high: "gemini-2.5-pro",
    chat_max: "gemini-2.5-pro",
  },
};

/** Blended $/MTok assuming a 3:1 input:output mix; unknown prices sort last. */
function blendedPrice(ref: string, prices: Record<string, Price>): number {
  const p = prices[ref];
  return p ? (3 * p.input + p.output) / 4 : Number.POSITIVE_INFINITY;
}

/**
 * Provider-neutral defaults: for every task, the cheapest model among the
 * providers that have a key. RECALL_DEFAULT_PROVIDER pins one provider, and
 * RECALL_MODEL_<TASK> overrides a single task (any provider, including
 * OpenRouter, Groq, DeepSeek or a local OpenAI-compatible server).
 */
/**
 * RECALL_ANSWER_FALLBACK (an OpenRouter model id): answers routed through OpenRouter fall back to
 * it when their own model's vendor is unavailable or refuses the call (OpenRouter's `models`
 * list), so chat keeps answering. Routing the operator set for a task, or a default fallback list,
 * is left as it is; without the setting nothing is added.
 */
export function withAnswerFallbacks(
  routing: OpenRouterRouting,
  models: Record<LlmTask, string>,
  fallback?: string,
): OpenRouterRouting {
  const out: OpenRouterRouting = { ...routing };
  if (!fallback) return out;
  for (const [task, ref] of Object.entries(models)) {
    if (!task.startsWith("chat_") || !ref.startsWith("openrouter/")) continue;
    if (ref === `openrouter/${fallback}`) continue;
    if (out[task]?.fallbacks || out.default?.fallbacks) continue;
    out[task] = { ...(out[task] ?? {}), fallbacks: [fallback] };
  }
  return out;
}

function defaultModels(
  env: Env,
  prices: Record<string, Price>,
): Record<LlmTask, string> & { embedding: string } {
  const keyed = Object.keys(PROVIDER_MODELS).filter(
    (p) =>
      (p === "anthropic" && env.ANTHROPIC_API_KEY) ||
      (p === "openai" && env.OPENAI_API_KEY) ||
      (p === "gemini" && env.GEMINI_API_KEY) ||
      (p === "openrouter" && env.OPENROUTER_API_KEY),
  );
  // A pinned provider is used even before its key is set: calls then fail with a
  // clear configuration error instead of silently answering from the mock model.
  const pinned = env.RECALL_DEFAULT_PROVIDER;
  const providers = pinned ? [pinned] : keyed;

  const embedding =
    env.OPENAI_API_KEY || pinned === "openai"
      ? "openai/text-embedding-3-small"
      : env.GEMINI_API_KEY || pinned === "gemini"
        ? "gemini/gemini-embedding-001"
        : env.OPENROUTER_API_KEY || pinned === "openrouter"
          ? "openrouter/openai/text-embedding-3-small"
          : providers.length
            ? "local/Xenova/multilingual-e5-small"
            : "mock/hash";

  const pick = (task: LlmTask): string => {
    const candidates = providers.map((p) => `${p}/${PROVIDER_MODELS[p]![task]}`);
    candidates.sort((a, b) => blendedPrice(a, prices) - blendedPrice(b, prices));
    return candidates[0] ?? "mock/default";
  };

  const tasks: LlmTask[] = [
    "reasoner",
    "summary",
    "card",
    "dream",
    "chat_minimal",
    "chat_low",
    "chat_medium",
    "chat_high",
    "chat_max",
  ];
  return {
    ...(Object.fromEntries(tasks.map((t) => [t, pick(t)])) as Record<LlmTask, string>),
    embedding,
  };
}

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const env = EnvSchema.parse(source);
  const dbUrl = env.RECALL_DATABASE_URL ?? env.DATABASE_URL;
  const dataDir = env.RECALL_DATA_DIR;

  if (env.RECALL_AUTH_ENABLED && !env.RECALL_AUTH_SECRET) {
    throw new Error("RECALL_AUTH_ENABLED=true requires RECALL_AUTH_SECRET");
  }
  if (env.RECALL_ADMIN_TOKEN !== undefined && env.RECALL_ADMIN_TOKEN.length < 24) {
    throw new Error("RECALL_ADMIN_TOKEN must be at least 24 characters");
  }
  if (env.RECALL_HOSTED) {
    if (!env.RECALL_AUTH_ENABLED)
      throw new Error("RECALL_HOSTED=true requires RECALL_AUTH_ENABLED=true");
    if (!env.RECALL_ADMIN_TOKEN) throw new Error("RECALL_HOSTED=true requires RECALL_ADMIN_TOKEN");
    if (!(env.RECALL_DATABASE_URL ?? env.DATABASE_URL))
      throw new Error("RECALL_HOSTED=true requires RECALL_DATABASE_URL");
    if (env.RECALL_STRIPE_TAX && !env.RECALL_STRIPE_INVOICES)
      throw new Error(
        "RECALL_STRIPE_TAX needs RECALL_STRIPE_INVOICES (auto top-ups are taxed through invoices)",
      );
    if (!!env.RECALL_REVIEWER_EMAIL !== !!env.RECALL_REVIEWER_PASSWORD_HASH)
      throw new Error(
        "Set both RECALL_REVIEWER_EMAIL and RECALL_REVIEWER_PASSWORD_HASH, or neither",
      );
    if (!!env.STRIPE_SECRET_KEY !== !!env.STRIPE_WEBHOOK_SECRET)
      throw new Error("Billing needs both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET");
    if (env.STRIPE_SECRET_KEY && !env.RECALL_PUBLIC_URL)
      throw new Error("Billing requires RECALL_PUBLIC_URL (Checkout and magic-link URLs)");
  }
  for (const name of ["RECALL_DASHBOARD_URL", "RECALL_SITE_URL"] as const)
    if (env[name]?.trim() && !env.RECALL_PUBLIC_URL)
      throw new Error(`${name} requires RECALL_PUBLIC_URL (the API's and issuer's URL)`);
  const siteOrigin = hostSetting("RECALL_SITE_URL", env);
  const dashboardUrl =
    dashboardOrigin(env) ?? env.RECALL_PUBLIC_URL?.trim().replace(/\/+$/, "") ?? null;
  if (env.RECALL_SESSION_SECRET !== undefined && env.RECALL_SESSION_SECRET.length < 32)
    throw new Error("RECALL_SESSION_SECRET must be at least 32 characters");
  if (env.RECALL_METRICS_TOKEN !== undefined && env.RECALL_METRICS_TOKEN.length < 16)
    throw new Error("RECALL_METRICS_TOKEN must be at least 16 characters");
  if (env.RESEND_API_KEY && !env.RECALL_EMAIL_FROM)
    throw new Error("RESEND_API_KEY requires RECALL_EMAIL_FROM");

  let pricingOverrides: Record<string, unknown> = {};
  if (env.RECALL_PRICING_JSON) {
    pricingOverrides = JSON.parse(env.RECALL_PRICING_JSON) as Record<string, unknown>;
  }
  const defaults = defaultModels(env, {
    ...DEFAULT_PRICES,
    ...(pricingOverrides as Record<string, Price>),
  });

  const models: Record<LlmTask, string> = {
    reasoner: env.RECALL_MODEL_REASONER ?? defaults.reasoner,
    summary: env.RECALL_MODEL_SUMMARY ?? defaults.summary,
    card: env.RECALL_MODEL_CARD ?? defaults.card,
    dream: env.RECALL_MODEL_DREAM ?? defaults.dream,
    chat_minimal: env.RECALL_MODEL_CHAT_MINIMAL ?? defaults.chat_minimal,
    chat_low: env.RECALL_MODEL_CHAT_LOW ?? defaults.chat_low,
    chat_medium: env.RECALL_MODEL_CHAT_MEDIUM ?? defaults.chat_medium,
    chat_high: env.RECALL_MODEL_CHAT_HIGH ?? defaults.chat_high,
    chat_max: env.RECALL_MODEL_CHAT_MAX ?? defaults.chat_max,
  };
  const openrouterRouting = withAnswerFallbacks(
    parseOpenRouterRouting(env.RECALL_OPENROUTER_ROUTING),
    models,
    env.RECALL_ANSWER_FALLBACK,
  );
  if (env.RECALL_HOSTED && !env.RECALL_OPENROUTER_ALLOW_FREE) {
    const free = freeModelsIn(Object.values(models), openrouterRouting);
    if (free.length) {
      throw new Error(
        `RECALL_HOSTED=true refuses free OpenRouter models (${free.join(", ")}): they may log or train on prompts. Set RECALL_OPENROUTER_ALLOW_FREE=true to override.`,
      );
    }
  }

  return {
    env,
    database: dbUrl
      ? {
          kind: "postgres",
          url: dbUrl,
          poolMax: env.RECALL_DATABASE_POOL_MAX,
          statementTimeoutMs: env.RECALL_DATABASE_STATEMENT_TIMEOUT_MS,
          ca: env.RECALL_DATABASE_CA?.replaceAll("\\n", "\n") ?? null,
        }
      : { kind: "pglite", dataDir: dataDir === "memory" ? null : `${dataDir}/db` },
    server: {
      host: env.RECALL_HOST,
      port: env.RECALL_PORT,
      publicUrl: env.RECALL_PUBLIC_URL ?? null,
      dashboardUrl,
      splitDashboard:
        dashboardOrigin(env) !== null && dashboardOrigin(env) !== originOf(env.RECALL_PUBLIC_URL),
      siteUrl: siteOrigin ?? originOf(env.RECALL_PUBLIC_URL),
      splitSite: siteOrigin !== null && siteOrigin !== originOf(env.RECALL_PUBLIC_URL),
      corsOrigins: parseOrigins(env.RECALL_CORS_ORIGINS),
      clientIp: clientIpConfig(env),
    },
    role: env.RECALL_ROLE,
    logLevel: env.RECALL_LOG_LEVEL,
    auth: { enabled: env.RECALL_AUTH_ENABLED, secret: env.RECALL_AUTH_SECRET ?? null },
    tenancy: {
      hosted: env.RECALL_HOSTED,
      adminToken: env.RECALL_ADMIN_TOKEN ?? null,
      keyRateLimitPerMin: Math.max(0, env.RECALL_KEY_RATE_LIMIT),
      chatRateLimitPerMin: Math.max(0, env.RECALL_KEY_CHAT_RATE_LIMIT),
      authFailuresPerMin: Math.max(0, env.RECALL_AUTH_FAILURE_LIMIT),
      keyCacheTtlMs: Math.max(0, env.RECALL_KEY_CACHE_TTL_MS),
      budgetCacheTtlMs: Math.max(0, env.RECALL_BUDGET_CACHE_TTL_MS),
      budgetRetryMs: Math.max(1_000, env.RECALL_BUDGET_RETRY_MS),
    },
    models,
    embedding: {
      model: env.RECALL_EMBEDDING_MODEL ?? defaults.embedding,
      dimensions: env.RECALL_EMBEDDING_DIMENSIONS,
    },
    worker: {
      concurrency: env.RECALL_WORKER_CONCURRENCY,
      pollMs: env.RECALL_WORKER_POLL_MS,
      maxAttempts: env.RECALL_QUEUE_MAX_ATTEMPTS,
      leaseMs: env.RECALL_WORKER_LEASE_MS,
      retryBaseMs: env.RECALL_WORKER_RETRY_BASE_MS,
      cronSecret: env.RECALL_CRON_SECRET ?? null,
    },
    reasoner: {
      enabled: env.RECALL_REASONER_ENABLED,
      batchTokens: env.RECALL_REASONER_BATCH_TOKENS,
      maxDelayMs: env.RECALL_REASONER_MAX_DELAY_MS,
      idleMs: Math.max(0, env.RECALL_REASONER_IDLE_MS),
      windowTokens: Math.max(500, env.RECALL_REASONER_WINDOW_TOKENS),
    },
    features: {
      dreams: env.RECALL_DREAMS_ENABLED,
      summaries: env.RECALL_SUMMARIES_ENABLED,
      webhooks: env.RECALL_WEBHOOKS_ENABLED,
    },
    chatCacheTtlS: env.RECALL_CHAT_CACHE_TTL_S,
    dreams: {
      minNewConclusions: env.RECALL_DREAM_MIN_NEW_CONCLUSIONS,
      idleMs: env.RECALL_DREAM_IDLE_MS,
      minIntervalMs: env.RECALL_DREAM_MIN_INTERVAL_MS,
    },
    webhook: {
      secret: env.RECALL_WEBHOOK_SECRET ?? null,
      allowPrivateHosts: env.RECALL_WEBHOOK_ALLOW_PRIVATE,
    },
    pricingOverrides,
    openrouter: {
      routing: openrouterRouting,
      allowFree: env.RECALL_OPENROUTER_ALLOW_FREE,
      livePrices: env.RECALL_OPENROUTER_LIVE_PRICES,
    },
    hosted: hostedConfig(env),
  };
}
