# Deployment & API Key Security

The OpenGraph API key is **never** sent to the browser. All OpenGraph requests go through a server-side proxy.

## Local development

1. Copy `.env.example` to `.env` (or the `.env` file is already created with your key).
2. Set `OPENGRAPH_API_KEY` in `.env`.
3. Run `npm run dev` (uses the Express server with the proxy).

> **Note:** The plain `npx serve` script won't provide the OpenGraph proxy. Use `npm run dev` for full functionality, or `npm run serve` for static-only testing.

## Production deployment

### Vercel (recommended)

1. Deploy the project to Vercel.
2. In Project Settings → Environment Variables, add:
   - `OPENGRAPH_API_KEY` = your OpenGraph.io API key
3. The `api/opengraph.js` serverless function will handle requests automatically.

### Other hosts (Node.js)

1. Run `node server.js` with `OPENGRAPH_API_KEY` set in the environment.
2. Example: `OPENGRAPH_API_KEY=your_key node server.js`

### Static-only hosting

If you deploy only the static files (e.g. GitHub Pages) without the API proxy, OpenGraph images and favicons will not load. Use Vercel or a Node host for full functionality.

## Data store (Cloudflare D1)

Everything the finder remembers lives in a D1 database, not the browser: each search (the
searched brand and its recommendations), the catalogs and social accounts crawled for every
domain, the shared search history, feedback on results, and the draft bundles built on
OfferLab. The browser talks to it through `/api/data/*` (see `shared/data-api.js`); the
catalog and socials proxies read through it, so a domain is crawled once and served from the
store until the stored copy ages out (`?refresh=1` forces a crawl).

- **Schema:** `migrations/*.sql`, applied with `npm run db:migrate` (remote) or
  `npm run db:migrate:local` (wrangler's local D1).
- **Binding:** `wrangler.toml` binds the `offerlab-tools` database as `DB`. Pages reads that
  file on every deploy, so production and preview deployments share the one database.
- **Local development:** `npm run dev` keeps the same schema in `.data/collab-finder.sqlite`
  (created and migrated on start, git-ignored) through Node's built-in SQLite, so nothing else
  needs installing. `npm run dev:pages` runs the real Pages Functions against wrangler's local
  D1 instead.
- **Without a binding** the app still runs: the data routes answer 503, the store module in the
  browser logs once, and the session simply is not persisted.

OAuth state for the OfferLab connection (the registered client, the session token and the PKCE
verifier) stays in the browser's own storage; it is credentials, not data.

## Server-side crawl

The finder's search runs on the server too (`shared/search.js` is the one search both sides run),
so a domain can be searched ahead of time with no browser, and each search can grow the graph.

- **Queue:** `crawl_queue` in D1 (`migrations/0002_crawl_queue.sql`). Each domain takes two steps,
  each its own request so it stays inside the Workers subrequest limit: a search (or a stored one,
  reused), then an expansion.
- **Expansion:** Jev (TypeSafe's System One model, `shared/jev.js`) answers three questions about
  each recommended brand that has a catalog and has not been searched: is it a consumer brand or a
  store, service or media; are its sample products its own; how well would it bundle with the
  searched brand. The ones that clear the thresholds are queued one level deeper, best first.
  Turned-down candidates stay as `skipped` rows with Jev's answers, so a verdict can be checked.
- **Caps:** seeds expand once and what they queue does not (`CRAWL_MAX_DEPTH`, default 1); one
  search queues at most `CRAWL_EXPAND_PER_SEARCH` (5); at most `CRAWL_DAILY_LIMIT` (150) searches
  start in any 24 hours. A search that finds fewer than 5 partners fails and is not expanded. A
  step retries once, then fails.
- **Thresholds:** measured on 41 recommendations from three stored searches (Stacked Farm, Liquid
  Death, Little Spoon). Services, venues and retailers such as Thrive Market and Grove fall out on
  the first question; the own-products question is noisy (Yoto scored 0.39), so its floor is 0.3
  and only drops catalogs of other sellers' listings.
- **Routes:** `GET /api/crawl` (queue counts, recent rows), `POST /api/crawl {domains, refresh}`,
  `POST /api/crawl/next` (one step). All need `Authorization: Bearer $CRAWL_SECRET`.
- **Scheduler:** Pages has no cron, so `workers/crawl-scheduler` is a Worker whose cron calls
  `/api/crawl/next` every minute.
- **Seeding:** `npm run crawl -- domains.txt` queues a list; `npm run crawl -- --status` shows it.

Setup, once:

1. `npm run db:migrate` applies the queue table.
2. In the Pages project, set `CRAWL_SECRET` (any long random string) and `TYPESAFE_API_KEY`.
3. `cd workers/crawl-scheduler && npx wrangler deploy && npx wrangler secret put CRAWL_SECRET`.

## Moderation

OfferLab developers, signed in to the finder, get two actions in each result card's "⋯" menu:

- **Wrong products** hides the brand's products everywhere: its stored catalog is cleared, served
  empty from then on, and never searched for again. For a Google Shopping search that matched
  another brand's products.
- **Remove from results** drops the brand from that one search; the search leaves it out if it
  runs again. Other searches keep it.

Both go through `POST /api/moderation`, which asks OfferLab which tools the caller's token grants
and refuses anyone who is not a developer. Corrections live in the `moderation` table
(`migrations/0003_moderation.sql`); `{ action: 'show-products', domain }` undoes a hide. Until the
migration is applied the finder reads as if nothing were moderated, and moderating fails.
