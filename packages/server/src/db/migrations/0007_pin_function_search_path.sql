-- Pin the ledger guard's search_path to the one the migrations run with, so a
-- caller's search_path cannot change which `accounts` table it checks.
ALTER FUNCTION credit_ledger_guard() SET search_path FROM CURRENT;
