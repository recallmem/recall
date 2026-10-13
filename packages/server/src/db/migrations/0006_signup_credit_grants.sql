-- Hosted sign-up abuse limits: one row per welcome credit granted, so the
-- per-network and per-day limits can be counted.
--
-- A row holds no account id and no address, only a keyed hash (HMAC with the
-- server secret) of the client network, so it identifies nobody on its own.
-- Rows are deliberately not tied to the account: deleting an account must not
-- reset the limits, or sign-up, delete and sign-up again would farm credit.
-- The billing sweep purges rows after 35 days (the per-network window is 30).
CREATE TABLE signup_credit_grants (
  id            bigserial PRIMARY KEY,
  ip_hash       text,
  amount_micros bigint NOT NULL CHECK (amount_micros > 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signup_credit_grants_ip_idx ON signup_credit_grants (ip_hash, created_at);
CREATE INDEX signup_credit_grants_created_idx ON signup_credit_grants (created_at);

ALTER TABLE signup_credit_grants ENABLE ROW LEVEL SECURITY;
