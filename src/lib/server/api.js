/**
 * What every /api route shares: JSON responses, the CORS headers the read proxies send, the env
 * behind platform, and the local-dev fallback that forwards a keyed proxy call to another deployment.
 */

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export function json(body, { status = 200, cache = null, cors = true } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(cors ? CORS : {}) };
  if (cache) headers['Cache-Control'] = cache;
  return new Response(JSON.stringify(body), { status, headers });
}

export function preflight() {
  return new Response(null, { headers: CORS });
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** The Worker's bindings and vars. In `vite dev` the adapter emulates them from wrangler.jsonc and .dev.vars. */
export function env(platform) {
  return platform?.env || {};
}

export function db(platform) {
  return env(platform).DB || null;
}

/** Runs work past the response, where the runtime allows it (Workers' waitUntil). */
export function defer(platform) {
  return promise => {
    if (platform?.context?.waitUntil) platform.context.waitUntil(promise);
    else promise.catch(() => {});
  };
}

/**
 * Local development without keys: with UPSTREAM_API_ORIGIN set (in .dev.vars) and the proxy's own
 * key missing, the request is forwarded as-is to that origin's /api route (through the UPSTREAM
 * service binding where there is one), so a real search runs
 * against production's Gemini, SerpAPI and OpenGraph proxies. Never on in production, where the
 * keys are set. Returns null when the route should handle the request itself.
 */
export async function forwardUpstream(event, keyName) {
  const vars = env(event.platform);
  if (vars[keyName] || !vars.UPSTREAM_API_ORIGIN) return null;
  const upstream = new URL(event.url.pathname + event.url.search, vars.UPSTREAM_API_ORIGIN);
  const init = { method: event.request.method, headers: { 'Content-Type': event.request.headers.get('content-type') || 'application/json' } };
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') init.body = await event.request.text();
  // A branch preview is a version of this same Worker, and a Worker's fetch of its own route skips
  // the Worker for the origin behind it, which answers 522. Previews bind the live Worker as
  // UPSTREAM (wrangler.jsonc) and call it directly; local dev has no binding and fetches.
  const response = vars.UPSTREAM?.fetch ? await vars.UPSTREAM.fetch(upstream, init) : await fetch(upstream, init);
  return new Response(response.body, {
    status: response.status,
    headers: { ...CORS, 'Content-Type': response.headers.get('content-type') || 'application/json', 'X-Forwarded-Upstream': upstream.origin }
  });
}
