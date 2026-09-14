/**
 * Cloudflare Pages Function: SerpAPI Proxy
 * Keeps the API key secure on the server side
 */

const SERPAPI_TIMEOUT_MS = 15000;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const query = url.searchParams.get('q');
  const engine = url.searchParams.get('engine') || 'google';

  // CORS headers for the response
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // Handle preflight requests
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (!query || typeof query !== 'string' || !query.trim()) {
    return new Response(
      JSON.stringify({ error: 'Missing or invalid q parameter' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const apiKey = env.SERP_API_KEY;
  if (!apiKey) {
    console.error('SERP_API_KEY not set in environment');
    return new Response(
      JSON.stringify({ error: 'Server misconfiguration' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const params = new URLSearchParams({
    api_key: apiKey,
    q: query.trim(),
    engine: engine,
    hl: 'en',
    gl: 'us',
    num: '10'
  });

  if (engine === 'google_shopping') {
    params.set('google_domain', 'google.com');
  }

  const apiUrl = `https://serpapi.com/search.json?${params}`;

  try {
    const response = await fetch(apiUrl, { signal: AbortSignal.timeout(SERPAPI_TIMEOUT_MS) });
    
    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: 'SerpAPI request failed' }),
        { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    const data = await response.json();
    
    return new Response(
      JSON.stringify(data),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[SerpAPI Proxy] Error:', err);
    return new Response(
      JSON.stringify({ error: 'Failed to fetch from SerpAPI' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}
