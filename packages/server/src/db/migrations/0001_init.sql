-- Recall initial schema. Runs on Postgres 16+ (pgvector >= 0.6) and PGlite.
-- __EMBEDDING_DIM__ is substituted by the migrator from RECALL_EMBEDDING_DIMENSIONS.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE workspaces (
  id            text PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  metadata      jsonb NOT NULL DEFAULT '{}',
  configuration jsonb NOT NULL DEFAULT '{}',
  internal      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspaces_created_at_idx ON workspaces (created_at, id);

-- Scopes are peers named "scope.<id>" with is_scope = true (Honcho-compatible facade).
CREATE TABLE peers (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  is_scope      boolean NOT NULL DEFAULT false,
  metadata      jsonb NOT NULL DEFAULT '{}',
  configuration jsonb NOT NULL DEFAULT '{}',
  internal      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
CREATE INDEX peers_list_idx ON peers (workspace_id, created_at, id);

CREATE TABLE sessions (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  metadata      jsonb NOT NULL DEFAULT '{}',
  configuration jsonb NOT NULL DEFAULT '{}',
  internal      jsonb NOT NULL DEFAULT '{}',
  -- next per-session message sequence number to assign
  next_seq      bigint NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
CREATE INDEX sessions_list_idx ON sessions (workspace_id, created_at, id);

CREATE TABLE session_peers (
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id    text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  peer_id       text NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  configuration jsonb NOT NULL DEFAULT '{}',
  joined_at     timestamptz NOT NULL DEFAULT now(),
  left_at       timestamptz,
  PRIMARY KEY (session_id, peer_id)
);
CREATE INDEX session_peers_peer_idx ON session_peers (peer_id);

CREATE TABLE messages (
  seq             bigserial PRIMARY KEY,           -- global insertion order (internal)
  id              text NOT NULL UNIQUE,            -- public 21-char id
  workspace_id    text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id      text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  peer_id         text NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  seq_in_session  bigint NOT NULL,
  content         text NOT NULL,
  metadata        jsonb NOT NULL DEFAULT '{}',
  internal        jsonb NOT NULL DEFAULT '{}',
  token_count     integer NOT NULL,
  idempotency_key text,
  embedding       vector(__EMBEDDING_DIM__),
  embedding_model text,
  -- set once the reasoner has processed this message (null = pending or skipped by config)
  reasoned_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  UNIQUE (session_id, seq_in_session)
);
CREATE INDEX messages_session_idx ON messages (session_id, seq);
CREATE INDEX messages_workspace_idx ON messages (workspace_id, seq);
CREATE INDEX messages_peer_idx ON messages (peer_id, seq);
CREATE INDEX messages_created_at_idx ON messages (workspace_id, created_at);
CREATE INDEX messages_tsv_idx ON messages USING gin (tsv);
CREATE INDEX messages_embedding_idx ON messages USING hnsw (embedding vector_cosine_ops);
CREATE UNIQUE INDEX messages_idempotency_idx ON messages (session_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX messages_unreasoned_idx ON messages (session_id, seq) WHERE reasoned_at IS NULL;

-- One per (observer, observed) pair: what `observer` believes about `observed`.
-- Holds the peer card and the bookkeeping that drives caching and dreams.
CREATE TABLE collections (
  id                text PRIMARY KEY,
  workspace_id      text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  observer_id       text NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  observed_id       text NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  peer_card         jsonb NOT NULL DEFAULT '[]',     -- ordered list of short strings
  card_updated_at   timestamptz,
  version           bigint NOT NULL DEFAULT 0,       -- bumped on every change; keys answer caches
  new_since_dream   integer NOT NULL DEFAULT 0,
  last_dream_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (observer_id, observed_id)
);
CREATE INDEX collections_workspace_idx ON collections (workspace_id);

-- Honcho calls these "conclusions" (formerly documents/observations).
CREATE TABLE conclusions (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  collection_id  text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  observer_id    text NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  observed_id    text NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  session_id     text REFERENCES sessions(id) ON DELETE CASCADE,
  content        text NOT NULL,
  level          text NOT NULL DEFAULT 'explicit'
                   CHECK (level IN ('explicit', 'deductive', 'inductive', 'contradiction')),
  category       text,                               -- e.g. identity, preference, plan, relationship, event
  confidence     real NOT NULL DEFAULT 0.8,
  importance     real NOT NULL DEFAULT 0.5,
  times_derived  integer NOT NULL DEFAULT 1,
  source_ids     text[] NOT NULL DEFAULT '{}',      -- premise conclusion ids (non-explicit levels)
  message_ids    text[] NOT NULL DEFAULT '{}',      -- provenance: public message ids
  valid_from     timestamptz,                        -- when the fact started to hold (message time)
  valid_to       timestamptz,                        -- set when superseded
  superseded_by  text,
  embedding      vector(__EMBEDDING_DIM__),
  embedding_model text,
  internal       jsonb NOT NULL DEFAULT '{}',
  deleted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  tsv            tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);
CREATE INDEX conclusions_collection_idx ON conclusions (collection_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX conclusions_workspace_idx ON conclusions (workspace_id, created_at, id);
CREATE INDEX conclusions_observed_idx ON conclusions (observed_id) WHERE deleted_at IS NULL;
CREATE INDEX conclusions_session_idx ON conclusions (session_id);
CREATE INDEX conclusions_sources_idx ON conclusions USING gin (source_ids);
CREATE INDEX conclusions_tsv_idx ON conclusions USING gin (tsv);
CREATE INDEX conclusions_embedding_idx ON conclusions USING hnsw (embedding vector_cosine_ops);

-- Incremental summaries: each block of messages is summarised once.
CREATE TABLE summary_blocks (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id     text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('block', 'short', 'long')),
  start_seq      bigint NOT NULL,                    -- seq_in_session range covered (inclusive)
  end_seq        bigint NOT NULL,
  last_message_id text NOT NULL,                     -- public id of the last covered message
  content        text NOT NULL,
  token_count    integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX summary_blocks_session_idx ON summary_blocks (session_id, kind, end_seq);

CREATE TABLE webhook_endpoints (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url           text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, url)
);

-- Background work. Jobs with the same work_key run strictly one at a time.
CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL,     -- reason | summarize | dream | webhook | delete_session | delete_workspace | scope_backfill | scope_removal | embed
  work_key      text NOT NULL,
  workspace_id  text,
  session_id    text,
  payload       jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts      integer NOT NULL DEFAULT 0,
  run_after     timestamptz NOT NULL DEFAULT now(),
  locked_by     text,
  locked_until  timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX jobs_ready_idx ON jobs (run_after, id) WHERE status = 'pending';
CREATE INDEX jobs_workspace_idx ON jobs (workspace_id, status);
CREATE INDEX jobs_running_key_idx ON jobs (work_key) WHERE status = 'running';
-- At most one pending job per key for kinds that coalesce (reason, summarize, dream).
CREATE UNIQUE INDEX jobs_pending_coalesce_idx ON jobs (work_key)
  WHERE status = 'pending' AND kind IN ('reason', 'summarize', 'dream');

CREATE TABLE llm_usage (
  id                 bigserial PRIMARY KEY,
  workspace_id       text,
  task               text NOT NULL,
  provider           text NOT NULL,
  model              text NOT NULL,
  input_tokens       integer NOT NULL DEFAULT 0,
  output_tokens      integer NOT NULL DEFAULT 0,
  cache_read_tokens  integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  cost_usd           double precision,
  latency_ms         integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_usage_workspace_idx ON llm_usage (workspace_id, created_at);
