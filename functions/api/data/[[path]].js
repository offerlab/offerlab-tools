/**
 * Cloudflare Pages Function: the finder's data store, on D1.
 * Every /api/data/* route lands here; shared/data-api.js says which is which.
 */
import { handleDataRequest } from '../../../shared/data-api.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  const { request, env, params } = context;
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

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
    body,
    db: env.DB || null
  });

  if (status === 204 || payload === undefined) return new Response(null, { status, headers: CORS });
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
