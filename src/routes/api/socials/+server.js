/**
 * Social accounts linked from a storefront homepage. Every crawl is written to D1, and a fresh
 * enough stored result is served instead of crawling again; `?refresh=1` forces the crawl.
 */
import { fetchSocials } from '$lib/shared/socials.js';
import { readThrough, getSocials, putSocials, SOCIALS_TTL_MS } from '$lib/server/db.js';
import { json, preflight, db, defer } from '$lib/server/api.js';

export function OPTIONS() {
  return preflight();
}

export async function GET({ url, platform }) {
  const domain = url.searchParams.get('domain');
  const refresh = url.searchParams.get('refresh') === '1';
  if (!domain || !domain.trim()) return json({ error: 'Missing or invalid domain parameter' }, { status: 400, cache: 'no-store' });

  try {
    const result = await readThrough({
      db: db(platform), domain, refresh,
      get: getSocials, put: putSocials, ttl: SOCIALS_TTL_MS,
      crawl: fetchSocials,
      defer: defer(platform)
    });
    return json(result, { cache: refresh ? 'no-store' : 'public, max-age=3600' });
  } catch (err) {
    console.error('[Socials Proxy] Error:', err);
    return json({ error: 'Failed to fetch socials' }, { status: 500, cache: 'no-store' });
  }
}
