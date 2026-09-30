CREATE TABLE IF NOT EXISTS articles (
  title       TEXT PRIMARY KEY,
  cid         TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_articles_uploaded_at ON articles (uploaded_at);

CREATE TABLE IF NOT EXISTS upload_progress (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  last_title  TEXT    NOT NULL DEFAULT '',
  total_count INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'idle',
  started_at  TEXT,
  updated_at  TEXT
);

INSERT OR IGNORE INTO upload_progress (id, status) VALUES (1, 'idle');
