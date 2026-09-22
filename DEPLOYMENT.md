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
