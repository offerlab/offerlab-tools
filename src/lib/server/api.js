/**
 * What every /api route shares: JSON responses, the env behind platform, and the local-dev
 * fallback that forwards a keyed proxy call to another deployment.
 *
 * No route sends an allow-origin header: the finder's page is the only caller a browser may make
 * for it, and the gate (src/lib/server/gate.js) keeps everyone else out.
 */

export function json(body, { status = 200, cache = null } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cache) headers['Cache-Control'] = cache;
  return new Response(JSON.stringify(body), { status, headers });
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
 * service binding where there is one), so a real search runs against production's Gemini, SerpAPI
 * and OpenGraph proxies. That origin's gate lets the call in on UPSTREAM_API_TOKEN, its
 * CRAWL_SECRET; without the token it answers 401. Never on in production, where the keys are set.
 * Returns null when the route should handle the request itself.
 */
export async function forwardUpstream(event, keyName) {
  const vars = env(event.platform);
  if (vars[keyName] || !vars.UPSTREAM_API_ORIGIN) return null;
  const upstream = new URL(event.url.pathname + event.url.search, vars.UPSTREAM_API_ORIGIN);
  const headers = { 'Content-Type': event.request.headers.get('content-type') || 'application/json' };
  if (vars.UPSTREAM_API_TOKEN) headers.Authorization = `Bearer ${vars.UPSTREAM_API_TOKEN}`;
  const init = { method: event.request.method, headers };
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') init.body = await event.request.text();
  // A branch preview is a version of this same Worker, and a Worker's fetch of its own route skips
  // the Worker for the origin behind it, which answers 522. Previews bind the live Worker as
  // UPSTREAM (wrangler.jsonc) and call it directly; local dev has no binding and fetches.
  const response = vars.UPSTREAM?.fetch ? await vars.UPSTREAM.fetch(upstream, init) : await fetch(upstream, init);
  return new Response(response.body, {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('content-type') || 'application/json', 'X-Forwarded-Upstream': upstream.origin }
  });
}
