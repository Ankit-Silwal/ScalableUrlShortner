CREATE TABLE links (
  code VARCHAR(32) PRIMARY KEY CHECK (code ~ '^[a-zA-Z0-9_-]{4,32}$'),
  original_url VARCHAR(2048) NOT NULL,
  expires_at TIMESTAMPTZ,
  clicks BIGINT NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  last_clicked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX links_created_at_code_idx ON links (created_at DESC, code DESC);
-- Expired records remain reserved and queryable until explicitly deleted.
