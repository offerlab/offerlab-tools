/**
 * Cloudflare Pages Function: OAuth code exchange and refresh.
 * The grant comes from the caller; nothing about the token is kept here.
 */
import { DEFAULT_OFFERLAB_HOST, exchangeToken } from '../../../shared/offerlab.js';
import { json, preflight, readJson } from './_shared.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const body = await readJson(request);
  if (!body?.grant_type) return json({ error: 'Missing grant_type' }, 400);

  try {
    const { status, data } = await exchangeToken({
      params: body,
      host: env.OFFERLAB_HOST || DEFAULT_OFFERLAB_HOST
    });
    return json(data, status);
  } catch (err) {
    console.error('[OfferLab] token error:', err);
    return json({ error: 'Could not reach OfferLab to exchange the code' }, 502);
  }
}
