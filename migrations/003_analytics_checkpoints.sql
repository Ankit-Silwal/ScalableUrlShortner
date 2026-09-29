CREATE TABLE analytics_checkpoints (
  stream TEXT PRIMARY KEY,
  last_id TEXT NOT NULL DEFAULT '0-0',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
