-- Onboarding emails to new self-serve accounts (src/core/onboarding.ts): a welcome email shortly
-- after sign-up, and one reminder 48 hours later if the account has not used Recall yet. Each is
-- sent at most once: the send claims its column with a conditional UPDATE (... WHERE x IS NULL)
-- before the email goes out, so several workers or serverless instances send it once.
--
-- * welcome_email_at, nudge_email_at: when that email was claimed (sent).
-- * onboarding_emails_off_at: when the account turned these emails off, with the link in each
--   of them. Sign-in links, billing emails and spend alerts are not affected.
--
-- Accounts that exist now are marked as sent (the time of this migration, not a real send), so
-- deploying this sends nothing to them: only accounts created from now on get these emails.
ALTER TABLE accounts ADD COLUMN welcome_email_at timestamptz;
ALTER TABLE accounts ADD COLUMN nudge_email_at timestamptz;
ALTER TABLE accounts ADD COLUMN onboarding_emails_off_at timestamptz;
UPDATE accounts SET welcome_email_at = now(), nudge_email_at = now();
