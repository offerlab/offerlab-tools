/**
 * Gemini proxy: the key stays on the server. The model is a query parameter, one of the models
 * the finder uses; the body is capped at what a photo of a pack and a long prompt come to.
 *
 * `?keepalive=1` answers at once and streams: a space every few seconds while Gemini works, then
 * the JSON. A grounded recommendation call can run past the 100 seconds Cloudflare allows an
 * origin to stay silent, and the edge answered 524 for it; a body that has started is not
 * silent. JSON.parse reads past the leading spaces, so a caller reads it as before, except that a
 * Gemini failure arrives as a 200 whose body carries { error, status }.
 */
import { json, env, forwardUpstream } from '$lib/server/api.js';
import { foldStream } from '$lib/server/gemini-stream.js';

// How long one Gemini call may take before the proxy answers 504 instead. The browser gives up
// on an attempt sooner (GEMINI_ATTEMPT_TIMEOUT_MS in src/lib/shared/search.js) and retries; this
// keeps a Gemini connection that never answers from holding the Worker open behind it.
const UPSTREAM_TIMEOUT_MS = 180_000;
const KEEPALIVE_EVERY_MS = 10_000;
// A grounded call that has not started answering by now is, about one time in three, one that
// never will for another minute or two; a fresh attempt usually answers in under a minute. The
// first attempt on the kept-alive path gets this long to start, then is asked again with the
// full budget. Gemini's answers are not billed until they are produced.
const FIRST_ANSWER_MS = 60_000;
// The models the finder asks for (search.js, pitch-api.js, photo.js, picker-prompt.js). Any other
// is a caller spending the key on something the finder never does.
const MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro'];
// A pack photo is a 1280px JPEG, under a megabyte as base64; a prompt is tens of kilobytes.
const MAX_BODY_CHARS = 4_000_000;

// The kept-alive path streams from Google too, or the Worker's own fetch is the silent leg.
async function askGemini(endpoint, body, { stream = false, timeoutMs = UPSTREAM_TIMEOUT_MS } = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
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
      const answer = await askGemini(endpoint, body, { stream: true, timeoutMs: FIRST_ANSWER_MS }).catch(err => {
        if (err?.name !== 'TimeoutError') return failure(err);
        console.warn(`[Gemini Proxy] No answer within ${FIRST_ANSWER_MS / 1000}s, asking again`);
        return askGemini(endpoint, body, { stream: true }).catch(failure);
      });
      await writer.write(encoder.encode(JSON.stringify(answer.body)));
    } finally {
      clearInterval(pulse);
      await writer.close().catch(() => {});
    }
  })();
  return new Response(readable, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function POST(event) {
  const forwarded = await forwardUpstream(event, 'GEMINI_API_KEY');
  if (forwarded) return forwarded;

  const apiKey = env(event.platform).GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set in environment');
    return json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  const model = event.url.searchParams.get('model') || 'gemini-2.5-flash';
  if (!MODELS.includes(model)) return json({ error: `Unsupported model: ${model}` }, { status: 400 });
  const text = await event.request.text();
  if (text.length > MAX_BODY_CHARS) return json({ error: 'Request too large' }, { status: 413 });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Expected a JSON body' }, { status: 400 });
  }
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
