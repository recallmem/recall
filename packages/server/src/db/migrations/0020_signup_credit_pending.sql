-- Welcome credits held back by the daily cap (RECALL_SIGNUP_CREDIT_DAILY_CAP_USD). A sign-up on a
-- day whose welcome credits already reached the cap used to get no credit at all; it now gets a
-- row here, and the billing sweep grants these oldest first as later days' caps allow
-- (src/billing/index.ts, grantPendingSignupCredits). Each grant re-runs the per-address and
-- per-network checks, so a network that signed up several accounts on a capped day still gets
-- one credit.
--
-- Unlike signup_credit_grants, a row belongs to its account: deleting the account drops the
-- promise with it. The hashes are the same keyed hashes as there (client network, normalised
-- email address), recorded with the grant when it is made.
CREATE TABLE signup_credit_pending (
  account_id    text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  ip_hash       text,
  email_hash    text,
  amount_micros bigint NOT NULL CHECK (amount_micros > 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signup_credit_pending_created_idx ON signup_credit_pending (created_at);

ALTER TABLE signup_credit_pending ENABLE ROW LEVEL SECURITY;
