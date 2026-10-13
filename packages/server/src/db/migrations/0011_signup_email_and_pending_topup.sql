-- One welcome credit per email address, also after the account is deleted: each grant records a
-- keyed hash of the normalised address (plus-tags and Gmail dots removed), never the address.
-- Rows with an email hash are kept for a year; network-only rows still go after 35 days.
ALTER TABLE signup_credit_grants ADD COLUMN email_hash text;
CREATE INDEX signup_credit_grants_email_idx ON signup_credit_grants (email_hash, created_at)
  WHERE email_hash IS NOT NULL;

-- The auto top-up still being processed (a payment intent or invoice id): no new attempt starts
-- until its webhook settles it, so a slow bank debit is never followed by a second one.
ALTER TABLE billing_accounts ADD COLUMN auto_topup_pending_ref text;
