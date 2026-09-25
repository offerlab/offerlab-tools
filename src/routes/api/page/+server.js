/**
 * Reads one web page for its products and product pictures (shared/page.js). Pages send no CORS
 * headers, so the browser asks here. A page the site will not serve comes back as
 * `{ status: 'blocked' }` with a 200: that is an answer the caller works around, not a failure.
 */
import { fetchPage, pageUrl } from '$lib/shared/page.js';
import { json, preflight } from '$lib/server/api.js';

export function OPTIONS() {
  return preflight();
}

export async function GET({ url }) {
  const target = pageUrl(url.searchParams.get('url'));
  if (!target) return json({ error: 'Missing or invalid url parameter' }, { status: 400, cache: 'no-store' });

  try {
    const page = await fetchPage(target);
    return json(page, { cache: page.status === 'ok' ? 'public, max-age=3600' : 'no-store' });
  } catch (err) {
    console.error('[Page Proxy] Error:', err);
    return json({ error: 'Failed to read the page' }, { status: 500, cache: 'no-store' });
  }
}
