/**
 * Temporary: hands the API keys to the SvelteKit Worker that replaces this Pages project, since
 * Cloudflare never shows a stored secret. Behind CRAWL_SECRET; removed once the keys are moved.
 */
export async function onRequest({ request, env }) {
  if (!env.CRAWL_SECRET || request.headers.get('authorization') !== `Bearer ${env.CRAWL_SECRET}`) {
    return new Response('Not found', { status: 404 });
  }
  const keys = { GEMINI_API_KEY: env.GEMINI_API_KEY, SERP_API_KEY: env.SERP_API_KEY, OPENGRAPH_API_KEY: env.OPENGRAPH_API_KEY };
  return new Response(JSON.stringify(keys), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
