/**
 * Drives the finder's crawl queue (shared/crawl.js). Pages has no cron, so this Worker's does:
 * each minute it asks the finder for steps until one search has run, the queue is idle, or the
 * daily cap is reached. A search takes about two minutes, so ticks overlap and a couple of
 * searches run at once; the queue's claim keeps them on different domains.
 */
const STEPS_PER_TICK = 10;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(drain(env));
  }
};

async function drain(env) {
  for (let step = 0; step < STEPS_PER_TICK; step++) {
    const response = await fetch(`${env.FINDER_ORIGIN}/api/crawl/next`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CRAWL_SECRET}` }
    });
    const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    console.log(JSON.stringify({ status: response.status, ...result }));
    if (!response.ok || result.idle || result.capped || result.step === 'search') return;
  }
}
