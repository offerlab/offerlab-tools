/**
 * The server-side crawl. Every /api/crawl route lands here; crawl-api.js says which is which.
 * Same-origin only and behind CRAWL_SECRET. The cron in src/worker.js posts /api/crawl/next here
 * in-process, and the step's own /api/* calls go through SvelteKit's fetch, which answers same-app
 * routes without a network hop.
 */
import { handleCrawlRequest } from '$lib/server/crawl-api.js';
import { readJson, db, env } from '$lib/server/api.js';

async function handle(event) {
  const { request, url, params, platform } = event;
  const path = String(params.path || '').split('/').filter(Boolean).join('/');
  const body = request.method === 'POST' ? await readJson(request) : null;

  const { status, body: payload } = await handleCrawlRequest({
    method: request.method,
    path,
    authorization: request.headers.get('authorization'),
    body,
    db: db(platform),
    env: env(platform),
    origin: url.origin,
    fetchImpl: event.fetch
  });

  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export const GET = handle;
export const POST = handle;
