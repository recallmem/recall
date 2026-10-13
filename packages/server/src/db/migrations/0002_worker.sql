-- Worker: the database enforces "one running job per work key". The worker
-- treats a unique violation on claim as "someone else got there first".
DROP INDEX IF EXISTS jobs_running_key_idx;
CREATE UNIQUE INDEX jobs_running_key_uniq ON jobs (work_key) WHERE status = 'running';
-- Stale-lease recovery scans running jobs by lease expiry.
CREATE INDEX jobs_lease_idx ON jobs (locked_until) WHERE status = 'running';
-- Queue status and metrics group by kind and status per workspace.
CREATE INDEX jobs_status_kind_idx ON jobs (workspace_id, kind, status);
-- Current (not deleted, not superseded) facts of a collection: the reasoner's hot path.
CREATE INDEX conclusions_current_idx ON conclusions (collection_id, created_at)
  WHERE deleted_at IS NULL AND valid_to IS NULL;
-- Copies of one fact filed into several observers' collections share internal.key.
CREATE INDEX conclusions_fact_key_idx ON conclusions ((internal->>'key')) WHERE deleted_at IS NULL;
