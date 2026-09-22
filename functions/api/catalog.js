/**
 * Cloudflare Pages Function: Shopify public catalog proxy.
 * Storefronts send no CORS headers on /products.json, so the browser cannot read it directly.
 *
 * Every crawl is written to D1, and a fresh enough stored catalog is served instead of crawling
 * again; `?refresh=1` forces the crawl. Without a DB binding it just proxies.
 */
import { fetchShopifyCatalog } from '../../shared/catalog.js';
import { readThrough, getCatalog, putCatalog, keepStoredSerp, CATALOG_TTL_MS } from '../../shared/db.js';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const domain = url.searchParams.get('domain');
  const refresh = url.searchParams.get('refresh') === '1';

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  const json = (body, status = 200, cache = 'public, max-age=3600') => new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': cache }
  });

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (!domain || !domain.trim()) {
    return json({ error: 'Missing or invalid domain parameter' }, 400, 'no-store');
  }

  try {
    const catalog = await readThrough({
      db: env.DB || null, domain, refresh,
      get: getCatalog, put: putCatalog, ttl: CATALOG_TTL_MS, keep: keepStoredSerp,
      crawl: fetchShopifyCatalog,
      defer: promise => context.waitUntil(promise)
    });
    return json(catalog, 200, refresh ? 'no-store' : 'public, max-age=3600');
  } catch (err) {
    console.error('[Catalog Proxy] Error:', err);
    return json({ error: 'Failed to fetch catalog' }, 500, 'no-store');
  }
}
