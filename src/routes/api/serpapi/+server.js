/** SerpAPI proxy: the key stays on the server. */
import { json, preflight, env, forwardUpstream } from '$lib/server/api.js';

const SERPAPI_TIMEOUT_MS = 15000;

export function OPTIONS() {
  return preflight();
}

export async function GET(event) {
  const query = event.url.searchParams.get('q');
  const engine = event.url.searchParams.get('engine') || 'google';
  if (!query || typeof query !== 'string' || !query.trim()) {
    return json({ error: 'Missing or invalid q parameter' }, { status: 400 });
  }

  const forwarded = await forwardUpstream(event, 'SERP_API_KEY');
  if (forwarded) return forwarded;

  const apiKey = env(event.platform).SERP_API_KEY;
  if (!apiKey) {
    console.error('SERP_API_KEY not set in environment');
    return json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  const params = new URLSearchParams({ api_key: apiKey, q: query.trim(), engine, hl: 'en', gl: 'us', num: '10' });
  if (engine === 'google_shopping') params.set('google_domain', 'google.com');

  try {
    const response = await fetch(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(SERPAPI_TIMEOUT_MS) });
    if (!response.ok) return json({ error: 'SerpAPI request failed' }, { status: response.status });
    return json(await response.json());
  } catch (err) {
    console.error('[SerpAPI Proxy] Error:', err);
    return json({ error: 'Failed to fetch from SerpAPI' }, { status: 500 });
  }
}
