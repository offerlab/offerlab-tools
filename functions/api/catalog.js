/**
 * Cloudflare Pages Function: Shopify public catalog proxy.
 * Storefronts send no CORS headers on /products.json, so the browser cannot read it directly.
 */
import { fetchShopifyCatalog } from '../../shared/catalog.js';

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const domain = url.searchParams.get('domain');

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (!domain || !domain.trim()) {
    return new Response(
      JSON.stringify({ error: 'Missing or invalid domain parameter' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const catalog = await fetchShopifyCatalog(domain);
    return new Response(JSON.stringify(catalog), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
    });
  } catch (err) {
    console.error('[Catalog Proxy] Error:', err);
    return new Response(
      JSON.stringify({ error: 'Failed to fetch catalog' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}
