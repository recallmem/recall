-- Operator suspension of an account (abuse, fraud, unpaid use). While `suspended_at`
-- is set, the account's API keys, OAuth access tokens and dashboard sessions are
-- refused with 403; jobs already queued still run. `suspended_reason` is the
-- operator's note, shown only in the operator console and the admin API.
ALTER TABLE accounts ADD COLUMN suspended_at timestamptz;
ALTER TABLE accounts ADD COLUMN suspended_reason text;

-- The operator console totals money and model cost over recent days across all
-- accounts; these let those range scans skip older rows (the existing indexes on
-- both tables lead with account_id).
CREATE INDEX IF NOT EXISTS credit_ledger_created_idx ON credit_ledger (created_at);
CREATE INDEX IF NOT EXISTS llm_usage_created_idx ON llm_usage (created_at);
