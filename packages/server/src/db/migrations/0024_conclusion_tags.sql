-- Tags: what a fact is about (the kind of thing, the named entities), so every fact on one thing
-- can be found for counting questions.
ALTER TABLE conclusions ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
CREATE INDEX conclusions_tags_idx ON conclusions USING gin (tags) WHERE deleted_at IS NULL;
