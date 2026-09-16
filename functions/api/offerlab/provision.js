/**
 * Cloudflare Pages Function: provision a brand the demo environment has not seen.
 * Never called from the browser — the demo endpoint is unauthenticated on QA hosts, so the
 * caller's token is checked for developer access here first (OL-3986).
 */
import { DEFAULT_OFFERLAB_HOST, provisionBrand } from '../../../shared/offerlab.js';
import { json, preflight, readJson } from './_shared.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'Missing bearer token' }, 401);

  const body = await readJson(request);
  if (!body?.domain) return json({ error: 'Missing domain' }, 400);

  try {
    const { status, data } = await provisionBrand({
      token,
      domain: body.domain,
      externalIds: body.external_ids || [],
      host: env.OFFERLAB_HOST || DEFAULT_OFFERLAB_HOST
    });
    return json(data, status);
  } catch (err) {
    console.error('[OfferLab] provision error:', err);
    return json({ error: 'Could not reach OfferLab to provision that brand' }, 502);
  }
}
