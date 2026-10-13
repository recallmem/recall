-- Row Level Security on every table, with no policies.
--
-- Supabase exposes the `public` schema through its Data API (PostgREST) to the
-- `anon` and `authenticated` roles. With RLS enabled and no policies, those roles
-- see no rows and can write none. Recall connects as the tables' owner, which
-- RLS does not apply to (we never FORCE it), so the server is unaffected; on plain
-- Postgres and embedded PGlite this is a no-op for the same reason.
-- New tables must be added here (or in a later migration) as well.
ALTER TABLE recall_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE peers ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_peers ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE conclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE summary_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_usage ENABLE ROW LEVEL SECURITY;
