/**
 * The finder's data store, on D1. Every /api/data/* route lands here; data-api.js says which is
 * which. Same-origin only, like every route: these routes write a store the whole team reads, so
 * no allow-origin header goes out and another site's browser cannot send them anything but a
 * preflight-free request, which the handler refuses.
 */
import { handleDataRequest } from '$lib/server/data-api.js';
import { readJson, db, env } from '$lib/server/api.js';

export function OPTIONS() {
  return new Response(null, { status: 204 });
}

async function handle({ request, url, params, platform }) {
  const segments = String(params.path || '').split('/').filter(Boolean);
  const body = ['GET', 'HEAD', 'DELETE'].includes(request.method) ? null : await readJson(request);

  const { status, body: payload } = await handleDataRequest({
    method: request.method,
    segments,
    query: Object.fromEntries(url.searchParams),
    contentType: request.headers.get('content-type') || '',
    body,
    db: db(platform),
    authorization: request.headers.get('authorization'),
    vars: env(platform),
    host: env(platform).OFFERLAB_HOST || undefined
  });

  if (status === 204 || payload === undefined) return new Response(null, { status });
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
