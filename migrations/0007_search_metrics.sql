-- Migration number: 0007 	 2026-09-26
-- What each search took and what it cost, written with the search (putSearch in
-- src/lib/server/db.js) from the meter it ran under (src/lib/shared/metrics.js). Additive: the
-- running Worker never names these columns, and a search stored without a reading keeps the
-- last one. A follow-up on the list (a note, "more like these") is not metered.

ALTER TABLE searches ADD COLUMN duration_ms INTEGER;          -- start to stored, ms
ALTER TABLE searches ADD COLUMN brands_ready_ms INTEGER;      -- start to the brands on screen, ms
ALTER TABLE searches ADD COLUMN gemini_calls INTEGER;
ALTER TABLE searches ADD COLUMN grounded_prompts INTEGER;     -- Gemini calls grounded with Google Search
ALTER TABLE searches ADD COLUMN grounded_queries INTEGER;     -- the web searches those calls ran
ALTER TABLE searches ADD COLUMN gemini_input_tokens INTEGER;  -- prompt and tool-use tokens
ALTER TABLE searches ADD COLUMN gemini_output_tokens INTEGER; -- answer and thinking tokens
ALTER TABLE searches ADD COLUMN serp_calls INTEGER;
ALTER TABLE searches ADD COLUMN jev_calls INTEGER;
ALTER TABLE searches ADD COLUMN cost_usd REAL;                -- estimated at list prices
ALTER TABLE searches ADD COLUMN metrics TEXT;                 -- JSON: the whole reading, steps and each Gemini call
