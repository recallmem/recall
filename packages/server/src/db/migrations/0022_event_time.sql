-- When the thing a fact describes happened, separate from when it was said. `valid_from` stays the
-- time the fact was learned (its source message); `event_start` is the date of the event or the
-- start of the state ("moved to Porto in the week of 2025-05-26"), `event_end` its end when known
-- (a trip, a job that ended, a range like "last week"), and `event_precision` how exact the start
-- is: day, month or year. Facts without a time of their own (preferences, traits) leave all three
-- null. Superseding, ordering and time-window questions use `event_start` and fall back to
-- `valid_from`.
ALTER TABLE conclusions ADD COLUMN event_start timestamptz;
ALTER TABLE conclusions ADD COLUMN event_end timestamptz;
ALTER TABLE conclusions ADD COLUMN event_precision text
  CHECK (event_precision IN ('day', 'month', 'year'));
CREATE INDEX conclusions_event_idx ON conclusions (workspace_id, event_start)
  WHERE deleted_at IS NULL AND event_start IS NOT NULL;
