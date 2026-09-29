ALTER TABLE links ADD COLUMN deleted_at TIMESTAMPTZ;
CREATE INDEX links_active_created_at_code_idx ON links (created_at DESC, code DESC)
  WHERE deleted_at IS NULL;
-- Tombstones permanently reserve aliases, so delayed analytics cannot affect a reused code.
