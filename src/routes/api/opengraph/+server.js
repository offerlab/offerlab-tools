/** OpenGraph.io proxy: the key stays on the server; the answer is a cover image and a favicon. */
import { json, preflight, env, forwardUpstream } from '$lib/server/api.js';
import { usableCover } from '$lib/server/opengraph.js';

function imageOf(graph) {
  const img = graph?.image;
  if (!img) return null;
  return typeof img === 'string' ? img : img?.url || null;
}

export function OPTIONS() {
  return preflight();
}

export async function GET(event) {
  const targetUrl = event.url.searchParams.get('url');
  if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.trim()) {
    return json({ error: 'Missing or invalid url parameter' }, { status: 400 });
  }

  const forwarded = await forwardUpstream(event, 'OPENGRAPH_API_KEY');
  if (forwarded) return forwarded;

  const apiKey = env(event.platform).OPENGRAPH_API_KEY;
  if (!apiKey) {
    console.error('OPENGRAPH_API_KEY not set in environment');
    return json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  const fullUrl = targetUrl.trim().startsWith('http') ? targetUrl.trim() : `https://${targetUrl.trim()}`;
  const apiUrl = `https://opengraph.io/api/1.1/site/${encodeURIComponent(fullUrl)}?app_id=${apiKey}`;

  try {
    const response = await fetch(apiUrl);
    if (!response.ok) return json({ error: 'OpenGraph fetch failed' }, { status: response.status });
    const data = await response.json();

    const imageUrl = imageOf(data?.hybridGraph) || imageOf(data?.openGraph) || imageOf(data?.htmlInferred) || imageOf(data);
    const faviconUrl = data?.hybridGraph?.favicon || data?.htmlInferred?.favicon || null;

    return json({
      imageUrl: usableCover(imageUrl, faviconUrl),
      faviconUrl: faviconUrl && typeof faviconUrl === 'string' ? faviconUrl : null
    });
  } catch (err) {
    console.error('[OpenGraph Proxy] Error:', err);
    return json({ error: 'Failed to fetch OpenGraph data' }, { status: 500 });
  }
}
