/** OAuth code exchange and refresh. The grant comes from the caller; nothing about the token is kept here. */
import { DEFAULT_OFFERLAB_HOST, exchangeToken } from '$lib/shared/offerlab.js';
import { json, preflight, readJson, env } from '$lib/server/api.js';

export function OPTIONS() {
  return preflight();
}

export async function POST({ request, platform }) {
  const body = await readJson(request);
  if (!body?.grant_type) return json({ error: 'Missing grant_type' }, { status: 400 });

  try {
    const { status, data } = await exchangeToken({ params: body, host: env(platform).OFFERLAB_HOST || DEFAULT_OFFERLAB_HOST });
    return json(data, { status });
  } catch (err) {
    console.error('[OfferLab] token error:', err);
    return json({ error: 'Could not reach OfferLab to exchange the code' }, { status: 502 });
  }
}
