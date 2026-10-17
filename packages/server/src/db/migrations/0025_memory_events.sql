-- The memory change log: every change to a fact or a peer card, with who made it (the reasoner,
-- a dream, the API, a dashboard user or the system), why, its sources (message or fact ids) and
-- what changed. It goes with the fact or the collection it is about (ON DELETE CASCADE), so
-- forgetting a person or deleting a fact leaves nothing of it here.
CREATE TABLE memory_events (
  id             bigserial PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  collection_id  text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  conclusion_id  text REFERENCES conclusions(id) ON DELETE CASCADE,
  action         text NOT NULL,
  actor          text NOT NULL,
  actor_ref      text,
  reason         text,
  sources        text[] NOT NULL DEFAULT '{}',
  before         jsonb,
  after          jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_events_conclusion_idx ON memory_events (conclusion_id, id) WHERE conclusion_id IS NOT NULL;
CREATE INDEX memory_events_collection_idx ON memory_events (collection_id, id);
ALTER TABLE memory_events ENABLE ROW LEVEL SECURITY;
