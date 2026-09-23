/** Gemini proxy: the key stays on the server. The model is a query parameter. */
import { json, preflight, readJson, env, forwardUpstream } from '$lib/server/api.js';

// How long one Gemini call may take before the proxy answers 504 instead. The browser gives up
// on an attempt sooner (GEMINI_ATTEMPT_TIMEOUT_MS in src/lib/shared/search.js) and retries; this
// keeps a Gemini connection that never answers from holding the Worker open behind it.
const UPSTREAM_TIMEOUT_MS = 180_000;

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

  try {
    const body = await readJson(event.request);
    const model = event.url.searchParams.get('model') || 'gemini-2.5-flash';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Gemini Proxy] API error:', response.status, errorText);
      return json({ error: 'Gemini API request failed', details: errorText }, { status: response.status });
    }
    return json(await response.json());
  } catch (err) {
    if (err?.name === 'TimeoutError') {
      console.error(`[Gemini Proxy] No answer from Gemini within ${UPSTREAM_TIMEOUT_MS / 1000}s`);
      return json({ error: 'Gemini did not answer in time' }, { status: 504 });
    }
    console.error('[Gemini Proxy] Error:', err);
    return json({ error: 'Failed to process Gemini request' }, { status: 500 });
  }
}
