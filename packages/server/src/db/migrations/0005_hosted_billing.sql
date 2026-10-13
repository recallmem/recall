-- Hosted onboarding and prepaid billing.
--
-- Users sign in with email magic links and belong to accounts through
-- memberships (one owner today; invites can add more later). Prepaid credit is
-- an append-only ledger in integer micro-USD (1 USD = 1,000,000); the balance is
-- cached on billing_accounts and updated in the same transaction as each entry.
-- An account is billed (metered and blocked at zero balance) only when it has a
-- billing_accounts row, which hosted sign-up creates; self-hosted installs and
-- operator-created accounts have none and are unaffected.

CREATE TABLE users (
  id            text PRIMARY KEY,
  -- Stored lowercased; the unique index makes sign-up idempotent per address.
  email         text NOT NULL UNIQUE,
  name          text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE account_members (
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX account_members_user_idx ON account_members (user_id);

-- Single-use magic-link tokens: only a SHA-256 of the token is stored. `ip_hash`
-- (keyed hash, never the raw address) backs the per-IP rate limit.
CREATE TABLE login_tokens (
  id         text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  email      text NOT NULL,
  ip_hash    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX login_tokens_email_idx ON login_tokens (email, created_at);
CREATE INDEX login_tokens_ip_idx ON login_tokens (ip_hash, created_at);

-- Dashboard sessions. The cookie carries a random token (HMAC-signed); the
-- database keeps its SHA-256, so a database leak does not leak live sessions.
CREATE TABLE user_sessions (
  id           text PRIMARY KEY,
  token_hash   text NOT NULL UNIQUE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id   text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);

CREATE TABLE billing_accounts (
  account_id                  text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  stripe_customer_id          text UNIQUE,
  -- Saved card for off-session auto top-ups (set by a Checkout that saved it).
  payment_method_id           text,
  balance_micros              bigint NOT NULL DEFAULT 0,
  auto_topup_enabled          boolean NOT NULL DEFAULT false,
  auto_topup_threshold_micros bigint NOT NULL DEFAULT 5000000 CHECK (auto_topup_threshold_micros >= 0),
  auto_topup_amount_micros    bigint NOT NULL DEFAULT 25000000 CHECK (auto_topup_amount_micros > 0),
  -- An auto top-up in progress (claimed by one process); stale claims expire.
  auto_topup_pending_at       timestamptz,
  auto_topup_attempts         integer NOT NULL DEFAULT 0,
  auto_topup_failures         integer NOT NULL DEFAULT 0,
  auto_topup_retry_after      timestamptz,
  auto_topup_last_error       text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- Append-only: rows are never updated, and deleted only together with their
-- account (GDPR erasure). `idempotency_key` makes every credit and debit
-- exactly-once (a Stripe payment, a reasoning batch, a chat request).
CREATE TABLE credit_ledger (
  id                   bigserial PRIMARY KEY,
  account_id           text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount_micros        bigint NOT NULL,
  kind                 text NOT NULL,
  idempotency_key      text NOT NULL,
  balance_after_micros bigint NOT NULL,
  detail               jsonb NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key)
);
CREATE INDEX credit_ledger_account_idx ON credit_ledger (account_id, created_at);

CREATE FUNCTION credit_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id) THEN RETURN OLD; END IF; RAISE EXCEPTION 'credit_ledger is append-only'; END $$;
CREATE TRIGGER credit_ledger_append_only BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_guard();

-- Stripe webhook deliveries already processed (idempotency by event id).
CREATE TABLE stripe_events (
  id           text PRIMARY KEY,
  type         text NOT NULL,
  account_id   text,
  processed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;
