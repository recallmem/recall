-- Pinned facts: set by a person (API or dashboard). The reasoner and dreams never close, merge
-- or rewrite them; a statement that disagrees is kept next to it and flagged as a conflict.
ALTER TABLE conclusions ADD COLUMN pinned boolean NOT NULL DEFAULT false;
