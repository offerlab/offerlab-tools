/**
 * Cloudflare Pages Function: the Showcase's bundles, live. shared/library.js lays the store's
 * newest bundles over the committed snapshot; the snapshot and the curation list are read back
 * from the deployed site itself.
 */
import { handleLibraryRequest } from '../../shared/library.js';

async function asset(env, request, path) {
  const response = await env.ASSETS.fetch(new URL(path, request.url).toString());
  return response.ok ? response.json() : null;
}

export async function onRequest({ request, env }) {
  const [snapshot, curation] = await Promise.all([
    asset(env, request, '/library/snapshot.json'),
    asset(env, request, '/library/curation.json')
  ]);
  const { status, body } = await handleLibraryRequest({
    method: request.method,
    snapshot,
    curation: curation || { pin: [], exclude: [] },
    db: env.DB || null,
    apiKey: env.GEMINI_API_KEY,
    log: message => console.warn(`[Library] ${message}`)
  });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
