-- Activation funnel for the operator (the console's Funnel page and the weekly report,
-- src/core/funnel.ts). Most steps are read from existing tables. Two cannot be read back reliably,
-- so the account keeps when they first happened:
--
-- * first_app_at: the first app connected over OAuth. Grant rows are purged once they lapse
--   (src/core/oauth.ts purgeOAuth), so an app that was connected and later dropped leaves no row.
-- * first_message_at: the first message stored. Messages can be deleted with their session or
--   workspace, and their created_at may be set by the client (backfills), so it is not the time
--   they were stored.
--
-- Each is set once, by the transaction that creates the grant or the messages, and is a time only
-- (nothing of the content). Nullable without a default, so adding them rewrites nothing. Existing
-- accounts are backfilled from what is still there: the earliest surviving grant, and the earliest
-- stored message or billed learning, kept between the account's creation and now (approximate).
ALTER TABLE accounts ADD COLUMN first_app_at timestamptz;
ALTER TABLE accounts ADD COLUMN first_message_at timestamptz;
UPDATE accounts a SET first_app_at = g.first
  FROM (SELECT account_id, min(created_at) AS first FROM oauth_grants GROUP BY account_id) g
  WHERE g.account_id = a.id;
UPDATE accounts a SET first_message_at = LEAST(now(), GREATEST(a.created_at, x.first))
  FROM (
    SELECT e.account_id, min(e.first) AS first FROM (
      SELECT w.account_id,
             (SELECT min(m.created_at) FROM messages m WHERE m.workspace_id = w.id) AS first
      FROM workspaces w
      UNION ALL
      SELECT account_id, min(created_at) FROM credit_ledger WHERE kind = 'ingest' GROUP BY account_id
    ) e
    WHERE e.first IS NOT NULL AND e.account_id IS NOT NULL
    GROUP BY e.account_id
  ) x
  WHERE x.account_id = a.id;

-- Operator reports sent (the weekly funnel email): one row per report and period, claimed with
-- INSERT ... ON CONFLICT DO NOTHING before the email goes out, so that several workers (or
-- several serverless instances) send each report once.
CREATE TABLE operator_reports (
  report  text NOT NULL,
  period  text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report, period)
);
ALTER TABLE operator_reports ENABLE ROW LEVEL SECURITY;
