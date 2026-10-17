-- Facts that stop holding on a known date ("on call until Friday"): past expires_at they count
-- as replaced, at once for reads and for good once the sweep closes them.
ALTER TABLE conclusions ADD COLUMN expires_at timestamptz;
CREATE INDEX conclusions_expiry_idx ON conclusions (expires_at)
  WHERE expires_at IS NOT NULL AND valid_to IS NULL AND deleted_at IS NULL;
