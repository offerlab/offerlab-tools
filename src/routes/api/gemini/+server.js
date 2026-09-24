/**
 * Gemini proxy: the key stays on the server. The model is a query parameter.
 *
 * `?keepalive=1` answers at once and streams: a space every few seconds while Gemini works, then
 * the JSON. A grounded recommendation call can run past the 100 seconds Cloudflare allows an
 * origin to stay silent, and the edge answered 524 for it; a body that has started is not
 * silent. JSON.parse reads past the leading spaces, so a caller reads it as before, except that a
 * Gemini failure arrives as a 200 whose body carries { error, status }.
 */
import { json, preflight, readJson, env, forwardUpstream, CORS } from '$lib/server/api.js';
import { foldStream } from '$lib/server/gemini-stream.js';

// How long one Gemini call may take before the proxy answers 504 instead. The browser gives up
// on an attempt sooner (GEMINI_ATTEMPT_TIMEOUT_MS in src/lib/shared/search.js) and retries; this
// keeps a Gemini connection that never answers from holding the Worker open behind it.
const UPSTREAM_TIMEOUT_MS = 180_000;
const KEEPALIVE_EVERY_MS = 10_000;

// The kept-alive path streams from Google too, or the Worker's own fetch is the silent leg.
async function askGemini(endpoint, body, { stream = false } = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });
  if (!response.ok) {
    const errorText = await response.text();
    console.error('[Gemini Proxy] API error:', response.status, errorText);
    return { ok: false, status: response.status, body: { error: 'Gemini API request failed', details: errorText, status: response.status } };
  }
  const answer = stream ? await foldStream(response) : await response.json();
  if (answer?.error) return { ok: false, status: answer.status || 502, body: { error: answer.error, status: answer.status || 502 } };
  return { ok: true, status: 200, body: answer };
}

function failure(err) {
  if (err?.name === 'TimeoutError') {
    console.error(`[Gemini Proxy] No answer from Gemini within ${UPSTREAM_TIMEOUT_MS / 1000}s`);
    return { status: 504, body: { error: 'Gemini did not answer in time', status: 504 } };
  }
  console.error('[Gemini Proxy] Error:', err);
  return { status: 500, body: { error: 'Failed to process Gemini request', status: 500 } };
}

function streamed(endpoint, body) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  (async () => {
    const pulse = setInterval(() => writer.write(encoder.encode(' ')).catch(() => {}), KEEPALIVE_EVERY_MS);
    try {
      const answer = await askGemini(endpoint, body, { stream: true }).catch(failure);
      await writer.write(encoder.encode(JSON.stringify(answer.body)));
    } finally {
      clearInterval(pulse);
      await writer.close().catch(() => {});
    }
  })();
  return new Response(readable, {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export function OPTIONS() {
  return preflight();
}

export async function POST(event) {
  const forwarded = await forwardUpstream(event, 'GEMINI_API_KEY');
  if (forwarded) return forwarded;

  const apiKey = env(event.platform).GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set in environment');
    return json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  const body = await readJson(event.request);
  const model = event.url.searchParams.get('model') || 'gemini-2.5-flash';
  const base = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`;
  if (event.url.searchParams.get('keepalive') === '1') return streamed(`${base}:streamGenerateContent?alt=sse&key=${apiKey}`, body);
  const endpoint = `${base}:generateContent?key=${apiKey}`;

  try {
    const answer = await askGemini(endpoint, body);
    return json(answer.body, { status: answer.status });
  } catch (err) {
    const { status, body: payload } = failure(err);
    return json(payload, { status });
  }
}
