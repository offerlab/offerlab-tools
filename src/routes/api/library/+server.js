/**
 * The Showcase's bundles. A plain GET is the table (fast, cacheable for a short while, with an
 * ETag so the browser's revalidation costs nothing); `?sync=1` first brings the table up to the
 * store's listing, which is what the open Showcase polls and what the cron does each minute
 * (src/worker.js). The snapshot and the curation list are read back from the deployed assets
 * (the ASSETS binding on the Worker; the dev server's static files under `vite dev`).
 */
import { handleLibraryRequest, libraryTag } from '$lib/server/library.js';
import { env } from '$lib/server/api.js';

// A read may be reused for this long before the browser asks again; a sync is never reused.
const READ_CACHE = 'public, max-age=30, stale-while-revalidate=300';

async function asset(event, path) {
  const url = new URL(path, event.url);
  const assets = env(event.platform).ASSETS;
  const response = assets ? await assets.fetch(url.toString()) : await event.fetch(url);
  return response.ok ? response.json() : null;
}

export async function GET(event) {
  const sync = event.url.searchParams.get('sync') === '1';
  const [snapshot, curation] = await Promise.all([
    asset(event, '/library/snapshot.json'),
    asset(event, '/library/curation.json')
  ]);
  const { status, body } = await handleLibraryRequest({
    method: event.request.method,
    snapshot,
    curation: curation || { pin: [], exclude: [] },
    db: env(event.platform).DB || null,
    apiKey: env(event.platform).GEMINI_API_KEY,
    log: message => console.warn(`[Library] ${message}`),
    sync
  });
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': sync ? 'no-store' : READ_CACHE };
  if (status === 200 && Array.isArray(body.bundles)) {
    const tag = libraryTag(body);
    if (event.request.headers.get('if-none-match') === tag) return new Response(null, { status: 304, headers });
    headers.ETag = tag;
  }
  return new Response(JSON.stringify(body), { status, headers });
}
