-- Migration number: 0005 	 2026-09-23
-- library_bundles holds every Showcase bundle, not only the ones classified since the snapshot
-- (shared/library.js). A bundle the store stops listing is kept and dated, not deleted.

ALTER TABLE library_bundles ADD COLUMN unlisted_at INTEGER;
