/**
 * Cloudflare Pages Function: staff corrections to the finder's results.
 * shared/moderation-api.js checks the caller is an OfferLab developer and applies the change.
 */
import { handleModerationRequest } from '../../shared/moderation-api.js';

export async function onRequest({ request, env }) {
  const body = request.method === 'POST' ? await request.json().catch(() => null) : null;
  const { status, body: payload } = await handleModerationRequest({
    method: request.method,
    authorization: request.headers.get('authorization'),
    body,
    db: env.DB || null,
    host: env.OFFERLAB_HOST || undefined
  });
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
