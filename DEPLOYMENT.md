# Deployment

The finder is one Cloudflare Worker: a SvelteKit app built with `@sveltejs/adapter-cloudflare`,
its static assets served by Workers Static Assets, the D1 database `offerlab-tools`, and a cron
that drives the crawl. `wrangler.jsonc` is the whole configuration; secrets are never in the repo.

## Layout

- `src/routes/+page.svelte` is the app; `src/lib/components/` its views (Omnibar, BrandCard,
  Results, Picker, PitchModal, Showcase, Lightbox, ...); `src/lib/client/` the browser-side state
  (`*.svelte.js`, Svelte 5 runes), the OfferLab OAuth client, the store client and the `use:`
  actions that hold the motion and touch handling.
- `src/routes/api/**/+server.js` are the API routes, one per URL the browser calls
  (`/api/gemini`, `/api/serpapi`, `/api/opengraph`, `/api/catalog`, `/api/socials`,
  `/api/library`, `/api/data/*`, `/api/crawl/*`, `/api/moderation`, `/api/offerlab/*`). Each is a
  thin wrapper around `src/lib/server/` (db, data-api, crawl, moderation, library: server only)
  and `src/lib/shared/` (search, catalog, socials, jev, offerlab, library-snapshot: the same code
  the browser or the build scripts run).
- `src/worker.js` is the Worker entry: SvelteKit's fetch handler plus the `scheduled()` cron.
- `src/lib/styles/styles.css` is the design system, global and unchanged; `tailwind.css` is the
  Tailwind v4 entry with the finder's theme tokens.
- `static/` holds the fonts, logos, brand tiles and the Showcase snapshot; `_headers` the cache
  rules for them.

## Local development

```
cp .dev.vars.example .dev.vars        # keys, or UPSTREAM_API_ORIGIN (see below)
npm install
npm run db:migrate:local              # the schema into wrangler's local D1
npm run dev                           # vite dev with the D1 binding emulated from wrangler.jsonc
```

`vite dev` gets `platform.env` (the `DB` binding and `.dev.vars`) from wrangler's platform
proxy, persisted under `.wrangler/state`, the same database `wrangler dev` and the migrations use.

Without API keys, set `UPSTREAM_API_ORIGIN=https://collabfinder.offerlab.com` in `.dev.vars`: the
Gemini, SerpAPI and OpenGraph proxies forward to that deployment's `/api/*` whenever their own key
is missing, so a real search runs locally against production's keys. Catalogs, socials, the store
and the crawl stay local. Never set it in production.

To run the built Worker as production will: `npm run preview` (`vite build` then `wrangler dev`).
`wrangler dev --test-scheduled` adds `GET /cdn-cgi/local/scheduled` to fire the cron by hand.

## Production

Secrets, set once with `wrangler secret put <NAME>`: `GEMINI_API_KEY`, `SERP_API_KEY`,
`OPENGRAPH_API_KEY`, `TYPESAFE_API_KEY`, `CRAWL_SECRET`, and `OFFERLAB_HOST` if it is not the
default (`src/lib/shared/offerlab.js`). Optional vars: `CRAWL_MAX_DEPTH`, `CRAWL_EXPAND_PER_SEARCH`,
`CRAWL_DAILY_LIMIT`.

Deploy: `npm run deploy` (`vite build` then `wrangler deploy`). Migrations are applied by hand,
before the deploy that needs them: `npm run db:migrate` (`wrangler d1 migrations apply
offerlab-tools --remote`). The D1 database is the same one the Pages deployment used; nothing
moves.

The custom domain (`collabfinder.offerlab.com`) is attached to the Worker under Settings →
Domains & Routes, after it is removed from the Pages project.

## Data store (Cloudflare D1)

Everything the finder remembers lives in D1, not the browser: each search (the searched brand and
its recommendations), the catalogs and social accounts crawled for every domain, the shared search
history, feedback on results, the draft bundles built on OfferLab, the crawl queue and staff
moderation. The browser talks to it through `/api/data/*` (`src/lib/server/data-api.js`); the
catalog and socials proxies read through it, so a domain is crawled once and served from the store
until the stored copy ages out (`?refresh=1` forces a crawl). Without a binding the data routes
answer 503, the store module in the browser logs once, and the session is simply not persisted.

OAuth state for the OfferLab connection stays in the browser: the grant in `localStorage` (so a
sign-in outlives the tab), the PKCE verifier and return address in `sessionStorage`.

## Server-side crawl

The finder's search runs on the server too (`src/lib/shared/search.js` is the one search both
sides run), so a domain can be searched ahead of time with no browser, and each search can grow
the graph.

- **Queue:** `crawl_queue` in D1. Each domain takes two steps, each its own request so it stays
  inside the Workers subrequest limit: a search (or a stored one, reused), then an expansion.
- **Expansion:** Jev (TypeSafe's System One model, `src/lib/shared/jev.js`) answers three
  questions about each recommended brand that has a catalog and has not been searched; the ones
  that clear the thresholds are queued one level deeper, best first. Turned-down candidates stay
  as `skipped` rows with Jev's answers.
- **Caps:** seeds expand once and what they queue does not (`CRAWL_MAX_DEPTH`, default 1); one
  search queues at most `CRAWL_EXPAND_PER_SEARCH` (5); at most `CRAWL_DAILY_LIMIT` (150) searches
  start in any 24 hours. A search that finds fewer than 5 partners fails and is not expanded. A
  step retries once, then fails.
- **Routes:** `GET /api/crawl` (queue counts, recent rows), `POST /api/crawl {domains, refresh}`,
  `POST /api/crawl/next` (one step). All need `Authorization: Bearer $CRAWL_SECRET`.
- **Scheduler:** the Worker's own cron (`triggers.crons` in `wrangler.jsonc`, `scheduled()` in
  `src/worker.js`) posts `/api/crawl/next` to the app's fetch handler in-process every minute
  until one search has run, the queue is idle, or the daily cap is reached. The step's own
  `/api/*` calls go through SvelteKit's fetch, which answers same-app routes without a network
  hop. There is no separate scheduler Worker any more.
- **Seeding:** `CRAWL_SECRET=... npm run crawl -- domains.txt` queues a list against production
  (`CRAWL_ORIGIN` for another deployment); `--status` shows the queue.

## Showcase

The Showcase reads `/api/library`. D1 holds every bundle (`library_bundles`,
`migrations/0004_library.sql` and `0005_library_listing.sql`), seeded from the committed snapshot
(`static/library/snapshot.json`, built by `npm run build:library`) the first time the route is
read. Each read then syncs the table with the demo store's public listing: a bundle published from
OfferLab reaches that listing the moment it is put on the Online Store channel; a new bundle is
classified once (Gemini) and kept, a changed one is classified again, and one the store stops
listing is dated unlisted and left out until it is listed again. Without a database, or when the
store cannot be read, the snapshot and what is stored still go out. While the Showcase is open the
browser re-reads every 45 seconds and when the tab comes back into view, and deals the board
again only when the set of bundles changed. If the route fails, the snapshot file stands in.

## Moderation

OfferLab developers, signed in to the finder, get two actions in each result card's "⋯" menu:

- **Wrong products** hides the brand's products everywhere: its stored catalog is cleared, served
  empty from then on, and never searched for again.
- **Remove from results** drops the brand from that one search; the search leaves it out if it
  runs again.

Both go through `POST /api/moderation`, which asks OfferLab which tools the caller's token grants
and refuses anyone who is not a developer. `{ action: 'show-products', domain }` undoes a hide.

## Tests

- `npm test`: vitest, the shared and server modules against a local D1 (Miniflare).
- `npm run test:e2e`: Playwright smoke tests at phone and desktop sizes against `vite dev`.
- `.github/workflows/ci.yml` runs both on every pull request.
