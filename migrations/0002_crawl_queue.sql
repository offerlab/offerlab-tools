-- Migration number: 0002 	 2026-09-22T23:10:39.281Z
-- Domains the server searches on its own, without a browser (shared/crawl.js). A row is queued,
-- searched, then expanded: Jev scores the brands its search recommended and the ones worth it
-- are queued one level deeper. Candidates Jev turned down stay as skipped rows with its answers.

CREATE TABLE IF NOT EXISTS crawl_queue (
  domain        TEXT PRIMARY KEY,               -- canonical, like every other table
  depth         INTEGER NOT NULL,               -- 0 for a domain someone asked for
  source_domain TEXT,                           -- the search that recommended it; null at depth 0
  status        TEXT NOT NULL,                  -- queued | searching | expand | expanding | done | skipped | failed
  priority      REAL NOT NULL DEFAULT 0,        -- Jev's score; seeds go first
  verdict       TEXT,                           -- JSON: why it was queued or skipped
  outcome       TEXT,                           -- JSON: what the search found and what it queued
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,               -- ms since epoch
  updated_at    INTEGER NOT NULL,
  started_at    INTEGER,                        -- when the current step was claimed
  searched_at   INTEGER                         -- when its search last started; the daily cap counts these
);
CREATE INDEX IF NOT EXISTS crawl_queue_next ON crawl_queue(status, depth, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS crawl_queue_searched ON crawl_queue(searched_at);
