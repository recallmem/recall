-- Learning in message-time order (backfills of backdated sessions).
--
-- A peer card remembers, per entry (its label, e.g. "attribute:location"), the message time of
-- the statement the entry was last set from, so learning older messages later never moves an
-- entry back to an older value.
ALTER TABLE collections ADD COLUMN card_dates jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The queue runs one session's reasoning at a time per peer, oldest messages first: a claim reads
-- the authors and times of each pending session's unreasoned messages.
CREATE INDEX IF NOT EXISTS messages_unreasoned_peer_idx ON messages (session_id, peer_id, created_at)
  WHERE reasoned_at IS NULL;
