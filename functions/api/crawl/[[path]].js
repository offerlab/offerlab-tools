/**
 * Cloudflare Pages Function: the server-side crawl. Every /api/crawl route lands here;
 * shared/crawl-api.js says which is which. Same-origin only and behind CRAWL_SECRET.
 */
import { handleCrawlRequest } from '../../../shared/crawl-api.js';

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const path = (Array.isArray(params.path) ? params.path : String(params.path || '').split('/')).filter(Boolean).join('/');
  const body = request.method === 'POST' ? await request.json().catch(() => null) : null;

  const { status, body: payload } = await handleCrawlRequest({
    method: request.method,
    path,
    authorization: request.headers.get('authorization'),
    body,
    db: env.DB || null,
    env,
    origin: url.origin
  });

  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
