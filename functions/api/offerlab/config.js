/**
 * Cloudflare Pages Function: what the browser needs to start the OAuth flow.
 * The host is configured in one place — here and in the dev server — because the authorize step
 * is a redirect the browser makes itself, so it cannot go through a proxy like everything else.
 */
import { DEFAULT_OFFERLAB_HOST, endpoints } from '../../../shared/offerlab.js';
import { json, preflight } from './_shared.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();
  const { host, authorize } = endpoints(env.OFFERLAB_HOST || DEFAULT_OFFERLAB_HOST);
  return json({ host, authorize });
}
