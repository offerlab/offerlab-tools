/** Gemini proxy: the key stays on the server. The model is a query parameter. */
import { json, preflight, readJson, env, forwardUpstream } from '$lib/server/api.js';

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
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Gemini Proxy] API error:', response.status, errorText);
      return json({ error: 'Gemini API request failed', details: errorText }, { status: response.status });
    }
    return json(await response.json());
  } catch (err) {
    console.error('[Gemini Proxy] Error:', err);
    return json({ error: 'Failed to process Gemini request' }, { status: 500 });
  }
}
