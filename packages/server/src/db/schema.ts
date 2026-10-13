import {
  bigint,
  bigserial,
  boolean,
  customType,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  vector,
} from "drizzle-orm/pg-core";

/**
 * Drizzle mirror of migrations/*.sql, used for typed queries. The SQL
 * migration is the source of truth (the vector dimension is set at install
 * time); keep the two in sync by hand.
 */

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const json = <T>(name: string) => jsonb(name).$type<T>();
type Obj = Record<string, unknown>;

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  monthlyBudgetUsd: doublePrecision("monthly_budget_usd"),
  webhookSecret: text("webhook_secret"),
  metadata: json<Obj>("metadata").notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
  suspendedAt: ts("suspended_at"),
  suspendedReason: text("suspended_reason"),
  /** First app connected over OAuth, for the operator's activation funnel (0018_activation_funnel.sql). */
  firstAppAt: ts("first_app_at"),
  /** When the first message was stored (not its client-set created_at), 0018_activation_funnel.sql. */
  firstMessageAt: ts("first_message_at"),
});

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  name: text("name").notNull().default(""),
  keyHash: text("key_hash").notNull(),
  prefix: text("prefix").notNull(),
  mode: text("mode").$type<"live" | "test">().notNull().default("live"),
  workspace: text("workspace"),
  peer: text("peer"),
  session: text("session"),
  rateLimitPerMin: integer("rate_limit_per_min"),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastUsedAt: ts("last_used_at"),
  expiresAt: ts("expires_at"),
  revokedAt: ts("revoked_at"),
  /** The key that minted this one via POST /v3/keys; revoked with it (0012). */
  mintedBy: text("minted_by"),
});

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  name: text("name").notNull(),
  metadata: json<Obj>("metadata").notNull().default({}),
  configuration: json<Obj>("configuration").notNull().default({}),
  internal: json<Obj>("internal").notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const peers = pgTable("peers", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  isScope: boolean("is_scope").notNull().default(false),
  metadata: json<Obj>("metadata").notNull().default({}),
  configuration: json<Obj>("configuration").notNull().default({}),
  internal: json<Obj>("internal").notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  metadata: json<Obj>("metadata").notNull().default({}),
  configuration: json<Obj>("configuration").notNull().default({}),
  internal: json<Obj>("internal").notNull().default({}),
  nextSeq: bigint("next_seq", { mode: "number" }).notNull().default(1),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const sessionPeers = pgTable(
  "session_peers",
  {
    workspaceId: text("workspace_id").notNull(),
    sessionId: text("session_id").notNull(),
    peerId: text("peer_id").notNull(),
    configuration: json<{ observe_me?: boolean | null; observe_others?: boolean | null }>(
      "configuration",
    )
      .notNull()
      .default({}),
    joinedAt: ts("joined_at").notNull().defaultNow(),
    leftAt: ts("left_at"),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.peerId] })],
);

export const messages = pgTable("messages", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  id: text("id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  sessionId: text("session_id").notNull(),
  peerId: text("peer_id").notNull(),
  seqInSession: bigint("seq_in_session", { mode: "number" }).notNull(),
  content: text("content").notNull(),
  metadata: json<Obj>("metadata").notNull().default({}),
  internal: json<Obj>("internal").notNull().default({}),
  tokenCount: integer("token_count").notNull(),
  idempotencyKey: text("idempotency_key"),
  embedding: vector("embedding", { dimensions: 1536 }),
  embeddingModel: text("embedding_model"),
  reasonedAt: ts("reasoned_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  tsv: tsvector("tsv"),
});

export const collections = pgTable("collections", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  observerId: text("observer_id").notNull(),
  observedId: text("observed_id").notNull(),
  peerCard: json<string[]>("peer_card").notNull().default([]),
  /** Per card entry key, the message time it was set from (0014_ordered_learning.sql). */
  cardDates: json<Record<string, string>>("card_dates").notNull().default({}),
  cardUpdatedAt: ts("card_updated_at"),
  version: bigint("version", { mode: "number" }).notNull().default(0),
  newSinceDream: integer("new_since_dream").notNull().default(0),
  lastDreamAt: ts("last_dream_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export type ConclusionLevel = "explicit" | "deductive" | "inductive" | "contradiction";

export const conclusions = pgTable("conclusions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  collectionId: text("collection_id").notNull(),
  observerId: text("observer_id").notNull(),
  observedId: text("observed_id").notNull(),
  sessionId: text("session_id"),
  content: text("content").notNull(),
  level: text("level").$type<ConclusionLevel>().notNull().default("explicit"),
  category: text("category"),
  confidence: real("confidence").notNull().default(0.8),
  importance: real("importance").notNull().default(0.5),
  timesDerived: integer("times_derived").notNull().default(1),
  sourceIds: text("source_ids").array().notNull().default([]),
  messageIds: text("message_ids").array().notNull().default([]),
  validFrom: ts("valid_from"),
  validTo: ts("valid_to"),
  supersededBy: text("superseded_by"),
  embedding: vector("embedding", { dimensions: 1536 }),
  embeddingModel: text("embedding_model"),
  internal: json<Obj>("internal").notNull().default({}),
  deletedAt: ts("deleted_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  tsv: tsvector("tsv"),
});

export const summaryBlocks = pgTable("summary_blocks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  sessionId: text("session_id").notNull(),
  kind: text("kind").$type<"block" | "short" | "long">().notNull(),
  startSeq: bigint("start_seq", { mode: "number" }).notNull(),
  endSeq: bigint("end_seq", { mode: "number" }).notNull(),
  lastMessageId: text("last_message_id").notNull(),
  content: text("content").notNull(),
  tokenCount: integer("token_count").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  url: text("url").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export type JobStatus = "pending" | "running" | "done" | "failed";

export const jobs = pgTable("jobs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  kind: text("kind").notNull(),
  workKey: text("work_key").notNull(),
  workspaceId: text("workspace_id"),
  sessionId: text("session_id"),
  payload: json<Obj>("payload").notNull().default({}),
  status: text("status").$type<JobStatus>().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  runAfter: ts("run_after").notNull().defaultNow(),
  lockedBy: text("locked_by"),
  lockedUntil: ts("locked_until"),
  lastError: text("last_error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
});

// Idempotency-Key on chat (0015_idempotency_records.sql): the first response per (scope, key),
// replayed for a retry of the same request. `scope` hashes the credential and the route;
// `account_id` is set when the key is claimed, so account deletion removes the rows
// (src/http/idempotency.ts).
export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    accountId: text("account_id"),
    status: text("status").$type<"pending" | "done">().notNull().default("pending"),
    responseStatus: integer("response_status"),
    responseHeaders: json<Record<string, string>>("response_headers"),
    responseBody: text("response_body"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.key] })],
);

export const llmUsage = pgTable("llm_usage", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  workspaceId: text("workspace_id"),
  accountId: text("account_id"),
  task: text("task").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  costUsd: doublePrecision("cost_usd"),
  /** Cost is the list price of the tokens, not a provider-reported cost (0017_llm_usage_cost_estimated.sql). */
  costEstimated: boolean("cost_estimated"),
  latencyMs: integer("latency_ms").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Hosted onboarding and prepaid billing (0005_hosted_billing.sql)

export type MemberRole = "owner" | "admin" | "member";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull().default(""),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastLoginAt: ts("last_login_at"),
  termsVersion: text("terms_version"),
  termsAcceptedAt: ts("terms_accepted_at"),
});

export const accountMembers = pgTable(
  "account_members",
  {
    accountId: text("account_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").$type<MemberRole>().notNull().default("owner"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.userId] })],
);

export const loginTokens = pgTable("login_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  email: text("email").notNull(),
  ipHash: text("ip_hash"),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  /** Where to continue after signing in (an /oauth/authorize request), 0008_oauth.sql. */
  nextPath: text("next_path"),
  /** Keyed hash of the requesting browser's anonymous cookie (0012_link_browser_and_minted_keys.sql). */
  nextBrowser: text("next_browser"),
});

export const userSessions = pgTable("user_sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  userId: text("user_id").notNull(),
  accountId: text("account_id").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  revokedAt: ts("revoked_at"),
});

export const billingAccounts = pgTable("billing_accounts", {
  accountId: text("account_id").primaryKey(),
  stripeCustomerId: text("stripe_customer_id"),
  paymentMethodId: text("payment_method_id"),
  balanceMicros: bigint("balance_micros", { mode: "number" }).notNull().default(0),
  autoTopupEnabled: boolean("auto_topup_enabled").notNull().default(false),
  autoTopupThresholdMicros: bigint("auto_topup_threshold_micros", { mode: "number" })
    .notNull()
    .default(5_000_000),
  autoTopupAmountMicros: bigint("auto_topup_amount_micros", { mode: "number" })
    .notNull()
    .default(25_000_000),
  autoTopupPendingAt: ts("auto_topup_pending_at"),
  autoTopupPendingRef: text("auto_topup_pending_ref"),
  autoTopupAttempts: integer("auto_topup_attempts").notNull().default(0),
  autoTopupFailures: integer("auto_topup_failures").notNull().default(0),
  autoTopupRetryAfter: ts("auto_topup_retry_after"),
  autoTopupLastError: text("auto_topup_last_error"),
  autoTopupConsentVersion: text("auto_topup_consent_version"),
  autoTopupConsentAt: ts("auto_topup_consent_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const creditLedger = pgTable("credit_ledger", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  accountId: text("account_id").notNull(),
  amountMicros: bigint("amount_micros", { mode: "number" }).notNull(),
  kind: text("kind").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  balanceAfterMicros: bigint("balance_after_micros", { mode: "number" }).notNull(),
  detail: json<Obj>("detail").notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  accountId: text("account_id"),
  processedAt: ts("processed_at").notNull().defaultNow(),
});

// Welcome credits granted, for the sign-up abuse limits (0006_signup_credit_grants.sql,
// 0011_signup_email_and_pending_topup.sql). Keyed hashes of the client network and the normalised email
// address only; deliberately not tied to the account.
export const signupCreditGrants = pgTable("signup_credit_grants", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ipHash: text("ip_hash"),
  emailHash: text("email_hash"),
  amountMicros: bigint("amount_micros", { mode: "number" }).notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// Spend alerts per account (0016_account_alerts.sql): which emails are on, the low-balance line,
// and when each alert was last sent (so it goes out once per crossing; src/billing/alerts.ts).
export const accountAlerts = pgTable("account_alerts", {
  accountId: text("account_id").primaryKey(),
  lowBalanceEnabled: boolean("low_balance_enabled").notNull().default(true),
  lowBalanceMicros: bigint("low_balance_micros", { mode: "number" }).notNull().default(2_000_000),
  outOfCreditEnabled: boolean("out_of_credit_enabled").notNull().default(true),
  budget80Enabled: boolean("budget_80_enabled").notNull().default(true),
  budget100Enabled: boolean("budget_100_enabled").notNull().default(true),
  lowBalanceSentAt: ts("low_balance_sent_at"),
  outOfCreditSentAt: ts("out_of_credit_sent_at"),
  budget80SentFor: text("budget_80_sent_for"),
  budget100SentFor: text("budget_100_sent_for"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// Operator reports sent, one row per report and period (0018_activation_funnel.sql): the weekly
// funnel email claims its week here before it goes out, so it is sent once (src/core/funnel-report.ts).
export const operatorReports = pgTable(
  "operator_reports",
  {
    report: text("report").notNull(),
    period: text("period").notNull(),
    sentAt: ts("sent_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.report, t.period] })],
);

// ---------------------------------------------------------------------------
// OAuth 2.1 for the hosted MCP endpoint (0008_oauth.sql). Secrets are stored as SHA-256 only.

export const oauthClients = pgTable("oauth_clients", {
  id: text("id").primaryKey(),
  kind: text("kind").$type<"registered" | "metadata_document">().notNull(),
  name: text("name").notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  metadata: json<Obj>("metadata").notNull().default({}),
  registrationIpHash: text("registration_ip_hash"),
  createdAt: ts("created_at").notNull().defaultNow(),
  refreshAfter: ts("refresh_after"),
  lastUsedAt: ts("last_used_at"),
});

export const oauthGrants = pgTable("oauth_grants", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  userId: text("user_id").notNull(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  resource: text("resource").notNull(),
  scope: text("scope").notNull(),
  /** null: every workspace of the account. */
  workspaces: text("workspaces").array(),
  defaultWorkspace: text("default_workspace").notNull(),
  defaultPeer: text("default_peer"),
  /** The app saves lasting facts without being asked (0013_oauth_auto_remember.sql). */
  autoRemember: boolean("auto_remember").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
  revokedReason: text("revoked_reason"),
});

export const oauthCodes = pgTable("oauth_codes", {
  id: text("id").primaryKey(),
  codeHash: text("code_hash").notNull(),
  clientId: text("client_id").notNull(),
  accountId: text("account_id").notNull(),
  userId: text("user_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  resource: text("resource").notNull(),
  scope: text("scope").notNull(),
  workspaces: text("workspaces").array(),
  defaultWorkspace: text("default_workspace").notNull(),
  defaultPeer: text("default_peer"),
  /** The app saves lasting facts without being asked (0013_oauth_auto_remember.sql). */
  autoRemember: boolean("auto_remember").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  replayedAt: ts("replayed_at"),
  grantId: text("grant_id"),
});

export const oauthTokens = pgTable("oauth_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  grantId: text("grant_id").notNull(),
  kind: text("kind").$type<"access" | "refresh">().notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  revokedAt: ts("revoked_at"),
});
