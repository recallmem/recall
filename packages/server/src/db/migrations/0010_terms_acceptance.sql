-- Which version of the Terms of Service (and DPA) each user accepted, and when: recorded at
-- sign-up and again at the first sign-in after a new version (RECALL_LEGAL_URL deployments).
ALTER TABLE users ADD COLUMN terms_version text;
ALTER TABLE users ADD COLUMN terms_accepted_at timestamptz;

-- Auto top-ups are purchases of their own: the consent to start each one at once (and the
-- terms version it was given under) is recorded when auto top-up is switched on.
ALTER TABLE billing_accounts ADD COLUMN auto_topup_consent_version text;
ALTER TABLE billing_accounts ADD COLUMN auto_topup_consent_at timestamptz;
