-- Migration number: 0001 	 2026-09-22
-- Everything the finder used to keep in the browser's localStorage: searches and their
-- recommendations, the catalogs and socials crawled for each domain, the operators' search
-- history, feedback on results, and the draft bundles built on OfferLab.
--
-- Domains are the key everywhere. They are stored canonical: lowercase, no scheme, no path,
-- no leading www. (see canonicalDomain in shared/db.js).

-- One row per searched domain: the searched brand's profile and how the search ended.
CREATE TABLE IF NOT EXISTS searches (
  domain              TEXT PRIMARY KEY,
  search_id           TEXT NOT NULL,
  status              TEXT NOT NULL,            -- results | empty | error
  error_message       TEXT,
  searched_brand      TEXT,                     -- JSON brand profile, without its catalog
  serp_out_of_credits INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,         -- ms since epoch
  updated_at          INTEGER NOT NULL
);

-- The recommended partners of a search, in the order the recommender gave them.
CREATE TABLE IF NOT EXISTS search_brands (
  search_domain TEXT NOT NULL REFERENCES searches(domain) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  domain        TEXT NOT NULL,
  brand         TEXT NOT NULL,                  -- JSON recommendation, without its catalog
  PRIMARY KEY (search_domain, position)
);
CREATE INDEX IF NOT EXISTS search_brands_domain ON search_brands(domain);

-- The products crawled for a domain: a Shopify products.json, or Google Shopping when the
-- store has no public catalog. Shared by every search that lists the brand.
CREATE TABLE IF NOT EXISTS catalogs (
  domain     TEXT PRIMARY KEY,
  status     TEXT NOT NULL,                     -- shopify | serp | none
  count      INTEGER NOT NULL DEFAULT 0,
  payload    TEXT NOT NULL,                     -- JSON: the whole catalog record, products included
  fetched_at INTEGER NOT NULL
);

-- Social accounts linked from a storefront's homepage.
CREATE TABLE IF NOT EXISTS socials (
  domain     TEXT PRIMARY KEY,
  status     TEXT NOT NULL,                     -- found | none
  payload    TEXT NOT NULL,                     -- JSON: { status, domain, socials }
  fetched_at INTEGER NOT NULL
);

-- Recent searches, newest first in the omnibar dropdown.
CREATE TABLE IF NOT EXISTS search_history (
  domain      TEXT PRIMARY KEY,
  searched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS search_history_recent ON search_history(searched_at DESC);

-- Thumbs up or down on a set of results; the recommender reads the recent corpus back.
CREATE TABLE IF NOT EXISTS feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id     TEXT,
  search_domain TEXT,
  rating        TEXT NOT NULL,                  -- positive | negative
  results       TEXT NOT NULL,                  -- JSON [{ name, url }]
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_recent ON feedback(created_at DESC);

-- Draft bundles created on OfferLab, keyed by the brand the pitch is for.
CREATE TABLE IF NOT EXISTS drafts (
  stack_id        TEXT PRIMARY KEY,
  searched_domain TEXT NOT NULL,
  draft           TEXT NOT NULL,                -- JSON: the draft as createDraftBundle returned it
  published_url   TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS drafts_by_brand ON drafts(searched_domain, created_at DESC);
