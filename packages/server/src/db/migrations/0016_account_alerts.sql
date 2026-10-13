-- Spend alerts (hosted mode): emails to an account's owners when its credit runs low or out, and
-- at 80% and 100% of its monthly budget (src/billing/alerts.ts). One row per account, written the
-- first time its alerts are checked or saved; an account without a row has every alert on and a
-- low-balance line of $2.
--
-- The *_sent_* columns make each alert go out once per crossing: a check claims an alert with a
-- conditional UPDATE, so concurrent checks send it once. A balance alert's time is cleared when
-- the balance recovers past the line; a budget alert records the month and cap it was sent for
-- ("2026-10:50000000"), so it comes back next month or after the cap changes.
CREATE TABLE account_alerts (
  account_id            text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  low_balance_enabled   boolean NOT NULL DEFAULT true,
  low_balance_micros    bigint NOT NULL DEFAULT 2000000,
  out_of_credit_enabled boolean NOT NULL DEFAULT true,
  budget_80_enabled     boolean NOT NULL DEFAULT true,
  budget_100_enabled    boolean NOT NULL DEFAULT true,
  low_balance_sent_at   timestamptz,
  out_of_credit_sent_at timestamptz,
  budget_80_sent_for    text,
  budget_100_sent_for   text,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE account_alerts ENABLE ROW LEVEL SECURITY;
