/**
 * Cloudflare Pages Function: Gemini API Proxy
 * Keeps the API key secure on the server side
 */

// How long one Gemini call may take before the proxy answers 504 instead. The browser gives up
// on an attempt sooner (GEMINI_ATTEMPT_TIMEOUT_MS in shared/search.js) and retries; this keeps
// a Gemini connection that never answers from holding the function open behind it.
const UPSTREAM_TIMEOUT_MS = 180_000;

export async function onRequest(context) {
  const { request, env } = context;

  // CORS headers for the response
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // Handle preflight requests
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set in environment');
    return new Response(
      JSON.stringify({ error: 'Server misconfiguration' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const body = await request.json();
    const url = new URL(request.url);
    const model = url.searchParams.get('model') || 'gemini-2.5-flash';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Gemini Proxy] API error:', response.status, errorText);
      return new Response(
        JSON.stringify({ error: 'Gemini API request failed', details: errorText }),
        { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const data = await response.json();
    
    return new Response(
      JSON.stringify(data),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    if (err?.name === 'TimeoutError') {
      console.error(`[Gemini Proxy] No answer from Gemini within ${UPSTREAM_TIMEOUT_MS / 1000}s`);
      return new Response(
        JSON.stringify({ error: 'Gemini did not answer in time' }),
        { status: 504, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    console.error('[Gemini Proxy] Error:', err);
    return new Response(
      JSON.stringify({ error: 'Failed to process Gemini request' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}
