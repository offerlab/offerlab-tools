-- Migration number: 0003 	 2026-09-23
-- Corrections staff make to what the finder shows (shared/moderation.js). Two kinds:
--   products        the brand's products are wrong (a Google Shopping search that matched another
--                   brand); its catalog is served empty and never searched for again
--   recommendation  a brand does not belong in one search's results; it is dropped from that search
--                   and left out if the search runs again

CREATE TABLE IF NOT EXISTS moderation (
  kind          TEXT NOT NULL,                  -- products | recommendation
  search_domain TEXT NOT NULL DEFAULT '',       -- the search it applies to; '' for products
  domain        TEXT NOT NULL,                  -- the brand, canonical
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (kind, search_domain, domain)
);
CREATE INDEX IF NOT EXISTS moderation_domain ON moderation(domain);
