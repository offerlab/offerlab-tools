/**
 * The MCP endpoint. OfferLab's /api/mcp answers a preflight with no allow-origin header, so the
 * browser cannot reach it from the finder's origin. The caller's bearer token is forwarded as
 * given and never stored.
 */
import { DEFAULT_OFFERLAB_HOST, callMcp } from '$lib/shared/offerlab.js';
import { json, preflight, readJson, env } from '$lib/server/api.js';

export function OPTIONS() {
  return preflight();
}

export async function POST({ request, platform }) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'Missing bearer token' }, { status: 401 });

  const payload = await readJson(request);
  if (!payload) return json({ error: 'Invalid JSON body' }, { status: 400 });

  try {
    const { status, data } = await callMcp({ token, payload, host: env(platform).OFFERLAB_HOST || DEFAULT_OFFERLAB_HOST });
    return json(data, { status });
  } catch (err) {
    console.error('[OfferLab] mcp error:', err);
    return json({ error: 'Could not reach OfferLab' }, { status: 502 });
  }
}
