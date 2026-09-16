/**
 * Cloudflare Pages Function: the MCP endpoint.
 * /api/mcp answers a preflight with no allow-origin header, so the browser cannot reach it from
 * the finder's origin. The caller's bearer token is forwarded as given and never stored.
 */
import { DEFAULT_OFFERLAB_HOST, callMcp } from '../../../shared/offerlab.js';
import { json, preflight, readJson } from './_shared.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'Missing bearer token' }, 401);

  const payload = await readJson(request);
  if (!payload) return json({ error: 'Invalid JSON body' }, 400);

  try {
    const { status, data } = await callMcp({
      token,
      payload,
      host: env.OFFERLAB_HOST || DEFAULT_OFFERLAB_HOST
    });
    return json(data, status);
  } catch (err) {
    console.error('[OfferLab] mcp error:', err);
    return json({ error: 'Could not reach OfferLab' }, 502);
  }
}
