/**
 * Public storefront catalog proxy. Storefronts send no CORS headers on Shopify's /products.json or
 * WooCommerce's Store API, so the browser cannot read them directly. Every crawl is written to D1, and a fresh enough stored catalog is served
 * instead of crawling again; `?refresh=1` forces the crawl. Without a DB binding it just proxies.
 */
import { fetchStorefrontCatalog } from '$lib/shared/catalog.js';
import { readThrough, getCatalog, putCatalog, keepStoredSerp, CATALOG_TTL_MS } from '$lib/server/db.js';
import { json, preflight, db, defer } from '$lib/server/api.js';

export function OPTIONS() {
  return preflight();
}

export async function GET({ url, platform }) {
  const domain = url.searchParams.get('domain');
  const refresh = url.searchParams.get('refresh') === '1';
  if (!domain || !domain.trim()) return json({ error: 'Missing or invalid domain parameter' }, { status: 400, cache: 'no-store' });

  try {
    const catalog = await readThrough({
      db: db(platform), domain, refresh,
      get: getCatalog, put: putCatalog, ttl: CATALOG_TTL_MS, keep: keepStoredSerp,
      crawl: fetchStorefrontCatalog,
      defer: defer(platform)
    });
    return json(catalog, { cache: refresh ? 'no-store' : 'public, max-age=3600' });
  } catch (err) {
    console.error('[Catalog Proxy] Error:', err);
    return json({ error: 'Failed to fetch catalog' }, { status: 500, cache: 'no-store' });
  }
}
