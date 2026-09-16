/** Shape every OfferLab proxy function shares: same-origin only, JSON in, JSON out. */

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
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
