/**
 * Cloudflare Pages Function: social accounts linked from a storefront homepage.
 *
 * Every crawl is written to D1, and a fresh enough stored result is served instead of crawling
 * again; `?refresh=1` forces the crawl. Without a DB binding it just proxies.
 */
import { fetchSocials } from '../../shared/socials.js';
import { readThrough, getSocials, putSocials, SOCIALS_TTL_MS } from '../../shared/db.js';

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
    const result = await readThrough({
      db: env.DB || null, domain, refresh,
      get: getSocials, put: putSocials, ttl: SOCIALS_TTL_MS,
      crawl: fetchSocials,
      defer: promise => context.waitUntil(promise)
    });
    return json(result, 200, refresh ? 'no-store' : 'public, max-age=3600');
  } catch (err) {
    console.error('[Socials Proxy] Error:', err);
    return json({ error: 'Failed to fetch socials' }, 500, 'no-store');
  }
}
