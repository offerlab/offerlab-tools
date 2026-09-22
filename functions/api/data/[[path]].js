/**
 * Cloudflare Pages Function: the finder's data store, on D1.
 * Every /api/data/* route lands here; shared/data-api.js says which is which.
 *
 * Same-origin only, unlike the read proxies: these routes write a store the whole team reads, so
 * no allow-origin header goes out and another site's browser cannot send them anything but a
 * preflight-free request, which the handler refuses.
 */
import { handleDataRequest } from '../../../shared/data-api.js';

export async function onRequest(context) {
  const { request, env, params } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

  const url = new URL(request.url);
  const segments = Array.isArray(params.path) ? params.path : String(params.path || '').split('/').filter(Boolean);
  let body = null;
  if (!['GET', 'HEAD', 'DELETE'].includes(request.method)) {
    body = await request.json().catch(() => null);
  }

  const { status, body: payload } = await handleDataRequest({
    method: request.method,
    segments,
    query: Object.fromEntries(url.searchParams),
    contentType: request.headers.get('content-type') || '',
    body,
    db: env.DB || null
  });

  if (status === 204 || payload === undefined) return new Response(null, { status });
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
