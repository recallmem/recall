-- Idempotency-Key on chat: the first request's response, replayed for a retry of the same request
-- and refused (409) for a different request under the same key. Kept for a day.
-- `scope` is a hash of the credential and the route, so one caller's keys never meet another's;
-- `account_id` is filled in when the response is stored (account deletion removes the rows).
CREATE TABLE idempotency_records (
  scope text NOT NULL,
  key text NOT NULL,
  fingerprint text NOT NULL,
  account_id text,
  status text NOT NULL DEFAULT 'pending',
  response_status integer,
  response_headers jsonb,
  response_body text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
CREATE INDEX idempotency_records_created_idx ON idempotency_records (created_at);
CREATE INDEX idempotency_records_account_idx ON idempotency_records (account_id)
  WHERE account_id IS NOT NULL;
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
