/**
 * The Worker's entry point: SvelteKit's fetch handler plus the crawl cron, in one Worker.
 *
 * adapter-cloudflare writes SvelteKit's handler to wrangler's `main` (.svelte-kit/cloudflare/
 * _worker.js) on every build, so this file cannot be `main` itself. `npm run build` runs
 * scripts/wrap-worker.mjs after `vite build`, which renames the adapter's output to
 * kit-worker.js and copies this file in as _worker.js; that is why the import below is a sibling
 * that only exists in the build output.
 *
 * Each minute the cron asks the finder for crawl steps (src/lib/server/crawl.js) until one search
 * has run, the queue is idle, or the daily cap is reached. The request is dispatched to the app's
 * own fetch handler in-process, exactly as an HTTP call to /api/crawl/next would be, so the crawl
 * route stays the one implementation. A search takes about two minutes, so ticks overlap and a
 * couple of searches run at once; the queue's claim keeps them on different domains.
 */
import app from './kit-worker.js';

const STEPS_PER_TICK = 10;
// Any origin works: the request never leaves the process. The crawl step calls the finder's own
// /api/* proxies through SvelteKit's fetch, which handles same-app routes without a network hop.
const INTERNAL_ORIGIN = 'https://collab-finder.internal';

export default {
  fetch: app.fetch,

  async scheduled(event, env, ctx) {
    ctx.waitUntil(drain(env, ctx));
  }
};

async function drain(env, ctx) {
  if (!env.CRAWL_SECRET) {
    console.warn('[crawl] cron skipped: CRAWL_SECRET is not set');
    return;
  }
  for (let step = 0; step < STEPS_PER_TICK; step++) {
    const request = new Request(`${INTERNAL_ORIGIN}/api/crawl/next`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CRAWL_SECRET}` }
    });
    const response = await app.fetch(request, env, ctx);
    const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    console.log(JSON.stringify({ cron: 'crawl', status: response.status, ...result }));
    if (!response.ok || result.idle || result.capped || result.step === 'search') return;
  }
}
