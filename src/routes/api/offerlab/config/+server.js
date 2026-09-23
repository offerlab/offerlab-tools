/**
 * What the browser needs to start the OAuth flow. The host is configured here because the
 * authorize step is a redirect the browser makes itself, so it cannot go through a proxy.
 */
import { DEFAULT_OFFERLAB_HOST, endpoints } from '$lib/shared/offerlab.js';
import { json, preflight, env } from '$lib/server/api.js';

export function OPTIONS() {
  return preflight();
}

export function GET({ platform }) {
  const { host, authorize } = endpoints(env(platform).OFFERLAB_HOST || DEFAULT_OFFERLAB_HOST);
  return json({ host, authorize });
}
