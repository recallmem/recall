-- Accounts: the tenant boundary of the hosted service. Every workspace belongs to
-- exactly one account, and workspace names are unique per account (two customers
-- can both have a workspace called "default"). Self-hosted and JWT callers act on
-- the built-in account "default", so existing installs see no change.

CREATE TABLE accounts (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  -- Optional monthly spend cap in USD, compared against llm_usage for the current UTC month.
  monthly_budget_usd double precision CHECK (monthly_budget_usd IS NULL OR monthly_budget_usd >= 0),
  -- Signs this account's webhook deliveries; null falls back to RECALL_WEBHOOK_SECRET
  -- (the default account only: hosted accounts always get their own).
  webhook_secret     text,
  metadata           jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounts_created_at_idx ON accounts (created_at, id);
INSERT INTO accounts (id, name) VALUES ('default', 'default');

-- No column default on purpose: an insert that forgets the account fails instead of
-- silently landing in the default account.
ALTER TABLE workspaces ADD COLUMN account_id text REFERENCES accounts(id) ON DELETE CASCADE;
UPDATE workspaces SET account_id = 'default';
ALTER TABLE workspaces ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE workspaces DROP CONSTRAINT workspaces_name_key;
CREATE UNIQUE INDEX workspaces_account_name_idx ON workspaces (account_id, name);
CREATE INDEX workspaces_account_created_idx ON workspaces (account_id, created_at, id);

-- Customer API keys ("pk_live_..." / "pk_test_..."). Only a SHA-256 of the key is
-- stored, plus a short display prefix. A key without workspace/peer/session is an
-- account-admin key; otherwise the scope mirrors the JWT claims w/p/s.
CREATE TABLE api_keys (
  id                 text PRIMARY KEY,
  account_id         text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name               text NOT NULL DEFAULT '',
  key_hash           text NOT NULL UNIQUE,
  prefix             text NOT NULL,
  mode               text NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'test')),
  workspace          text,
  peer               text,
  session            text,
  rate_limit_per_min integer CHECK (rate_limit_per_min IS NULL OR rate_limit_per_min > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  expires_at         timestamptz,
  revoked_at         timestamptz,
  CHECK ((peer IS NULL AND session IS NULL) OR workspace IS NOT NULL)
);
CREATE INDEX api_keys_account_idx ON api_keys (account_id, created_at, id);

-- Spend is attributed to the account at record time, so deleting a workspace does
-- not reset the month's spend. No foreign key: usage is flushed in batches and an
-- account deleted mid-flush must not fail the batch (account deletion removes its rows).
ALTER TABLE llm_usage ADD COLUMN account_id text;
UPDATE llm_usage u SET account_id = w.account_id FROM workspaces w WHERE w.id = u.workspace_id;
CREATE INDEX llm_usage_account_idx ON llm_usage (account_id, created_at);
