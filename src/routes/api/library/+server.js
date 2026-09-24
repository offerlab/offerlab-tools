/**
 * The Showcase's bundles, live. library.js lays the store's newest bundles over the committed
 * snapshot; the snapshot and the curation list are read back from the deployed assets (the ASSETS
 * binding on the Worker; the dev server's static files under `vite dev`).
 */
import { handleLibraryRequest } from '$lib/server/library.js';
import { env } from '$lib/server/api.js';

async function asset(event, path) {
  const url = new URL(path, event.url);
  const assets = env(event.platform).ASSETS;
  const response = assets ? await assets.fetch(url.toString()) : await event.fetch(url);
  return response.ok ? response.json() : null;
}

export async function GET(event) {
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
    log: message => console.warn(`[Library] ${message}`)
  });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
