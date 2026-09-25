/** Dynamic client registration against OfferLab, proxied so every OfferLab call shares one host. */
import { DEFAULT_OFFERLAB_HOST, registerClient } from '$lib/shared/offerlab.js';
import { json, readJson, env } from '$lib/server/api.js';

export async function POST({ request, platform }) {
  const body = await readJson(request);
  if (!body?.redirect_uri) return json({ error: 'Missing redirect_uri' }, { status: 400 });

  try {
    const { status, data } = await registerClient({
      redirectUri: body.redirect_uri,
      clientName: body.client_name,
      host: env(platform).OFFERLAB_HOST || DEFAULT_OFFERLAB_HOST
    });
    return json(data, { status });
  } catch (err) {
    console.error('[OfferLab] register error:', err);
    return json({ error: 'Could not reach OfferLab to register' }, { status: 502 });
  }
}
