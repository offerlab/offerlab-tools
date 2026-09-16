/**
 * Cloudflare Pages Function: dynamic client registration against OfferLab.
 * Proxied rather than called from the browser so every OfferLab call shares one path and one host.
 */
import { DEFAULT_OFFERLAB_HOST, registerClient } from '../../../shared/offerlab.js';
import { json, preflight, readJson } from './_shared.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const body = await readJson(request);
  if (!body?.redirect_uri) return json({ error: 'Missing redirect_uri' }, 400);

  try {
    const { status, data } = await registerClient({
      redirectUri: body.redirect_uri,
      clientName: body.client_name,
      host: env.OFFERLAB_HOST || DEFAULT_OFFERLAB_HOST
    });
    return json(data, status);
  } catch (err) {
    console.error('[OfferLab] register error:', err);
    return json({ error: 'Could not reach OfferLab to register' }, 502);
  }
}
