-- Migration number: 0006 	 2026-09-25
-- The well-trodden brands (listFrequentBrands in src/lib/server/db.js) were counted on every
-- search, and the count read all of searches and all of search_brands each time: D1's daily read
-- allowance went on that one query. Now the count starts from the last searches by index, and its
-- answer is kept here and served until it is a few minutes old, so a search reads one row.

-- The last searches with results, newest first, without reading every search.
CREATE INDEX IF NOT EXISTS searches_recent ON searches(status, updated_at DESC);

-- One row per window: which searches are counted and how many a brand needs to be listed.
CREATE TABLE IF NOT EXISTS frequent_brands (
  id          TEXT PRIMARY KEY,                 -- '<searches>:<min>', e.g. '100:3'
  brands      TEXT NOT NULL,                    -- JSON [{ domain, name, searches }], most first
  computed_at INTEGER NOT NULL                  -- ms since epoch
);

-- The default window counted now, so the first search after the deploy reads the stored answer.
INSERT OR REPLACE INTO frequent_brands (id, brands, computed_at)
SELECT '100:3',
       json_group_array(json_object('domain', domain, 'name', name, 'searches', searches) ORDER BY searches DESC, domain),
       CAST(unixepoch('subsec') * 1000 AS INTEGER)
  FROM (SELECT sb.domain AS domain, COALESCE(NULLIF(MAX(json_extract(sb.brand, '$.name')), ''), sb.domain) AS name, COUNT(DISTINCT sb.search_domain) AS searches
          FROM (SELECT domain FROM searches WHERE status = 'results' ORDER BY updated_at DESC LIMIT 100) recent
         CROSS JOIN search_brands sb ON sb.search_domain = recent.domain
         GROUP BY sb.domain
        HAVING searches >= 3
         ORDER BY searches DESC, sb.domain
         LIMIT 100);
