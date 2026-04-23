/**
 * Local dev server with OpenGraph API proxy
 * Keeps the API key in process.env (use .env file). Never expose it to the browser.
 */
import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from 'dotenv';

config(); // Load .env

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5500;

// OpenGraph proxy - API key stays server-side
app.get('/api/opengraph', async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'Missing or invalid url parameter' });
  }

  const apiKey = process.env.OPENGRAPH_API_KEY;
  if (!apiKey) {
    console.warn('OPENGRAPH_API_KEY not set in .env - OpenGraph images will fail');
    return res.status(500).json({ error: 'Server misconfiguration: OPENGRAPH_API_KEY required' });
  }

  const fullUrl = url.trim().startsWith('http') ? url.trim() : `https://${url.trim()}`;
  // Use proxy to bypass bot protection (full_render causes timeouts on some sites)
  const apiUrl = `https://opengraph.io/api/1.1/site/${encodeURIComponent(fullUrl)}?app_id=${apiKey}&use_proxy=true`;

  try {
    console.log(`[OpenGraph Proxy] Fetching: ${fullUrl}`);
    const response = await fetch(apiUrl);
    if (!response.ok) {
      console.warn(`[OpenGraph Proxy] API returned ${response.status} for: ${fullUrl}`);
      return res.status(response.status).json({ error: 'OpenGraph fetch failed' });
    }
    const data = await response.json();
    
    // Log the full response for debugging
    console.log(`[OpenGraph Proxy] Response for ${fullUrl}:`, JSON.stringify(data, null, 2).substring(0, 500));
    
    // Try multiple sources for the image in order of preference
    let imageUrl = null;
    
    // 1. hybridGraph.image (most reliable)
    if (data?.hybridGraph?.image) {
      const img = data.hybridGraph.image;
      imageUrl = typeof img === 'string' ? img : img?.url;
    }
    
    // 2. openGraph.image
    if (!imageUrl && data?.openGraph?.image) {
      const img = data.openGraph.image;
      imageUrl = typeof img === 'string' ? img : img?.url;
    }
    
    // 3. htmlInferred.image (fallback)
    if (!imageUrl && data?.htmlInferred?.image) {
      const img = data.htmlInferred.image;
      imageUrl = typeof img === 'string' ? img : img?.url;
    }
    
    // 4. Direct image field at root
    if (!imageUrl && data?.image) {
      const img = data.image;
      imageUrl = typeof img === 'string' ? img : img?.url;
    }
    
    // Get favicon from multiple sources
    let faviconUrl = null;
    if (data?.hybridGraph?.favicon) {
      faviconUrl = data.hybridGraph.favicon;
    } else if (data?.htmlInferred?.favicon) {
      faviconUrl = data.htmlInferred.favicon;
    }
    
    console.log(`[OpenGraph Proxy] Extracted - image: ${imageUrl ? imageUrl.substring(0, 80) + '...' : 'null'}, favicon: ${faviconUrl ? 'found' : 'null'}`);

    res.json({
      imageUrl: imageUrl && typeof imageUrl === 'string' ? imageUrl : null,
      faviconUrl: faviconUrl && typeof faviconUrl === 'string' ? faviconUrl : null
    });
  } catch (err) {
    console.error('[OpenGraph Proxy] Error:', err);
    res.status(500).json({ error: 'Failed to fetch OpenGraph data' });
  }
});

// SerpAPI proxy - API key stays server-side
app.get('/api/serpapi', async (req, res) => {
  const query = req.query.q;
  const engine = req.query.engine || 'google';
  
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'Missing or invalid q parameter' });
  }

  const apiKey = process.env.SERP_API_KEY;
  if (!apiKey) {
    console.warn('SERP_API_KEY not set in .env - SerpAPI requests will fail');
    return res.status(500).json({ error: 'Server misconfiguration: SERP_API_KEY required' });
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
    console.log(`[SerpAPI Proxy] Query: "${query.trim()}" Engine: ${engine}`);
    const response = await fetch(apiUrl);
    
    if (!response.ok) {
      console.warn(`[SerpAPI Proxy] API returned ${response.status}`);
      return res.status(response.status).json({ error: 'SerpAPI request failed' });
    }
    
    const data = await response.json();
    console.log(`[SerpAPI Proxy] Results - Shopping: ${data.shopping_results?.length || 0}, Organic: ${data.organic_results?.length || 0}`);
    
    res.json(data);
  } catch (err) {
    console.error('[SerpAPI Proxy] Error:', err);
    res.status(500).json({ error: 'Failed to fetch from SerpAPI' });
  }
});

// Gemini API proxy - API key stays server-side
app.post('/api/gemini', express.json(), async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('GEMINI_API_KEY not set in .env - Gemini requests will fail');
    return res.status(500).json({ error: 'Server misconfiguration: GEMINI_API_KEY required' });
  }

  // Support dynamic model selection via query param (default: gemini-2.5-flash)
  const model = req.query.model || 'gemini-2.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  try {
    console.log(`[Gemini Proxy] Processing request with model: ${model}`);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[Gemini Proxy] API returned ${response.status}: ${errorText.substring(0, 200)}`);
      return res.status(response.status).json({ error: 'Gemini API request failed', details: errorText });
    }

    const data = await response.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    console.log(`[Gemini Proxy] Success - ${parts.length} parts, keys: ${parts.map(p => Object.keys(p).join('+')).join(', ')}`);
    res.json(data);
  } catch (err) {
    console.error('[Gemini Proxy] Error:', err);
    res.status(500).json({ error: 'Failed to process Gemini request' });
  }
});

// Static files
app.use(express.static(join(__dirname)));

const server = createServer(app);
server.listen(PORT, () => {
  console.log(`Brand Collab Finder running at http://localhost:${PORT}`);
  if (!process.env.OPENGRAPH_API_KEY) {
    console.warn('  ⚠️  Set OPENGRAPH_API_KEY in .env for OpenGraph images');
  }
});
