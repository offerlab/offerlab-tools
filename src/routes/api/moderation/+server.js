/**
 * Staff corrections to the finder's results. moderation-api.js checks the caller is an OfferLab
 * developer and applies the change. Same-origin only: no CORS headers go out.
 */
import { handleModerationRequest } from '$lib/server/moderation-api.js';
import { json, readJson, db, env } from '$lib/server/api.js';

async function handle(event) {
  const body = event.request.method === 'POST' ? await readJson(event.request) : null;
  const { status, body: payload } = await handleModerationRequest({
    method: event.request.method,
    authorization: event.request.headers.get('authorization'),
    body,
    db: db(event.platform),
    host: env(event.platform).OFFERLAB_HOST || undefined
  });
  return json(payload, { status, cache: 'no-store', cors: false });
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
