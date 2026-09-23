-- Migration number: 0004 	 2026-09-23
-- Showcase bundles the store lists that the committed snapshot (library/snapshot.json) does not
-- know yet, classified once (shared/library.js). The store's listing says which are shown.

CREATE TABLE IF NOT EXISTS library_bundles (
  id            TEXT PRIMARY KEY,               -- store/handle
  store         TEXT NOT NULL,
  handle        TEXT NOT NULL,
  hash          TEXT NOT NULL,                  -- of the copy the classification was made from
  record        TEXT NOT NULL,                  -- the classified record, JSON
  published_at  TEXT,
  classified_at INTEGER NOT NULL
);
