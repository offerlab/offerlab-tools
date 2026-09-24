/**
 * The finder's search: analyse the brand, ask Gemini for complementary brands, then attach each
 * one's public catalog and social accounts, with Google Shopping for the few without a catalog.
 *
 * Runtime-neutral, so the browser and the server run the same search. Every outside call goes
 * through `api`, which `httpApi` builds over the finder's own /api/* proxies: the browser passes
 * no base, the server passes its own origin. Each call is then one subrequest, whichever
 * provider sits behind it, which keeps a server-side search inside the Workers limit.
 */
import { mergeSocial } from './socials.js';
import { jsonrepair } from './vendor/jsonrepair/regular/jsonrepair.js';

export const SEARCH_DEFAULTS = {
  catalogConcurrency: 6,
  serpFallbackBrands: 5
};

// One Gemini attempt may run this long before it is given up and retried. The grounded
// recommendations call answers in 25-100s on a normal day; a connection Gemini never answers on
// used to hold the search (and the person's screen) open indefinitely.
export const GEMINI_ATTEMPT_TIMEOUT_MS = 150_000;

/**
 * The /api/* proxies as the search calls them. Every method answers with a fetch Response.
 * `signal` cancels every call the api makes, so a search abandoned in the browser stops here.
 */
export function httpApi(base = '', fetchImpl = (...args) => fetch(...args), { signal } = {}) {
  const at = (path) => `${base}${path}`;
  const get = (path) => fetchImpl(at(path), signal ? { signal } : undefined);
  return {
    gemini: (body, model) => fetchWithRetry(at(`/api/gemini${model ? `?model=${encodeURIComponent(model)}` : ''}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    }, 3, fetchImpl, { timeoutMs: GEMINI_ATTEMPT_TIMEOUT_MS }),
    serp: (params) => get(`/api/serpapi?${params}`),
    // `refresh` crawls the storefront now rather than serving the stored catalog (a day old at most).
    catalog: (domain, { refresh = false } = {}) => get(`/api/catalog?domain=${encodeURIComponent(domain)}${refresh ? '&refresh=1' : ''}`),
    socials: (domain) => get(`/api/socials?domain=${encodeURIComponent(domain)}`),
    opengraph: (url) => get(`/api/opengraph?url=${encodeURIComponent(url)}`)
  };
}

/** "https://www.Graza.co/x" -> "graza.co"; "" when it is not a URL. */
export function brandDomain(url) {
  if (url == null || typeof url !== 'string' || !url.trim()) return '';
  const text = url.trim();
  try {
    return new URL(text.startsWith('http') ? text : `https://${text}`).hostname.replace(/^www\./, '');
  } catch {
    return text.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
  }
}

function buildFeedbackContext(feedback) {
  if (!feedback?.length) return '';

  const positive = feedback.filter(f => f.rating === 'positive');
  const negative = feedback.filter(f => f.rating === 'negative');

  let context = '\n\nHISTORICAL FEEDBACK (use to improve relevance):\n';

  if (positive.length > 0) {
    const positiveBrands = positive.flatMap(f => f.results.map(r => r.name)).slice(-20);
    context += `Users responded positively to brands like: ${positiveBrands.join(', ')}\n`;
  }

  if (negative.length > 0) {
    const negativeBrands = negative.flatMap(f => f.results.map(r => r.name)).slice(-10);
    context += `Users responded negatively to brands like: ${negativeBrands.join(', ')}\n`;
  }

  context += 'Optimize for brands similar to positive examples.\n';

  return context;
}

// Brands whose own search recommended this one. The pairing already made sense from their side,
// so the recommender weighs it from this one, and each search grows the next one's starting graph.
function buildKnownPartnersContext(partners) {
  if (!partners?.length) return '';
  const lines = partners.map(p => {
    const idea = p.bundleIdea ? ` Bundle idea then: ${p.bundleIdea}` : '';
    return `- ${p.name} (${p.url}).${idea}`;
  });
  return `\n\nKNOWN PARTNERS FROM PAST SEARCHES (each of these brands was matched with this one when it was searched):\n${lines.join('\n')}\nInclude the ones that still fit this brand, after verifying they are active; they count toward the 12-15. Leave out any that do not fit.\n`;
}

/**
 * Runs one search. `feedback` and `knownPartners` are what the store holds for it; the caller
 * loads them, the browser through store.js and the server from D1.
 *
 * Callbacks: onProgress(step) with step 0-5, onBrandsReady({ searchedBrand, brands }) as soon
 * as the recommendations are in, onCatalog(brand) as each brand's catalog resolves.
 */
export async function discoverComplementaryBrands(url, {
  api, feedback = [], knownPartners = [],
  onProgress, onBrandsReady, onCatalog, config = {}
}) {
  const settings = { ...SEARCH_DEFAULTS, ...config };
  const domain = brandDomain(url);
  const brandName = extractBrandName(domain);
  const updateProgress = (step) => { if (typeof onProgress === 'function') onProgress(step); };

  console.log(`[Discovery] Starting for: ${domain} (brand: ${brandName})`);

  updateProgress(0);
  const brandProfile = await analyzeBrand(api, domain, await brandFacts(api, domain));
  const resolvedBrandProfile = brandProfile.brandProfile || brandProfile;
  updateProgress(1);

  updateProgress(2);
  const context = buildFeedbackContext(feedback) + buildKnownPartnersContext(knownPartners);
  const recommendations = await getRecommendations(api, resolvedBrandProfile, brandName, domain, context);
  const augmentedResults = augmentWithGroundingMetadata(recommendations, null);
  const brands = (augmentedResults.brands || []).map(ensureHttps);

  const searchedBrand = ensureHttps(resolvedBrandProfile);
  if (!searchedBrand.imageUrl && searchedBrand.url) {
    searchedBrand.imageUrl = await fetchOgImageUrl(api, searchedBrand.url);
  }
  const searchedBrandData = {
    name: searchedBrand.name,
    url: searchedBrand.url,
    imageUrl: searchedBrand.imageUrl,
    description: searchedBrand.description,
    brandDNA: searchedBrand.brandDNA,
    targetCustomer: searchedBrand.targetCustomer
  };

  console.log(`[Discovery] Brands ready: ${brands.length} brands found`);
  if (typeof onBrandsReady === 'function') onBrandsReady({ searchedBrand: searchedBrandData, brands });

  // Public catalogs for the searched brand and every recommendation
  await attachCatalogs(api, [searchedBrandData, ...brands], { onCatalog, concurrency: settings.catalogConcurrency });

  // Google Shopping only for brands without a public catalog (paid, 1 search per brand). A brand
  // whose Google Shopping catalog the store served fresh is not searched again; a stale one is,
  // and one whose products staff hid never is.
  const fallbackBrands = brands.filter(b => !b.catalog?.hidden && !hasCatalog(b.catalog)).slice(0, settings.serpFallbackBrands);
  let serpApiOutOfCredits = false;
  if (fallbackBrands.length > 0) {
    console.log(`[Discovery] SERP fallback for ${fallbackBrands.length} brands without a catalog`);
    const serpResult = await fetchProductsFromBrands(api, fallbackBrands);
    if (serpResult && serpResult.outOfCredits) {
      serpApiOutOfCredits = true;
    } else if (Array.isArray(serpResult)) {
      fallbackBrands.forEach(brand => {
        const products = serpResult
          .filter(p => p.brandName === brand.name)
          .map(p => ({ id: p.url, title: p.productName, url: p.url, image: p.imageUrl, price: typeof p.price === 'number' ? p.price : null }));
        if (products.length === 0) return;
        brand.catalog = { ...brand.catalog, status: 'serp', count: products.length, products };
        if (onCatalog) onCatalog(brand);
      });
    }
  }

  console.log(`[Discovery] Complete. ${brands.length} brands, ${brands.filter(b => b.catalog?.products?.length).length} with products`);
  return { searchedBrand: searchedBrandData, brands, serpApiOutOfCredits };
}

/* -------------------------------------------------------------------------- */
/* Catalogs and socials                                                        */
/* -------------------------------------------------------------------------- */

export async function fetchCatalog(api, domain, options = {}) {
  try {
    const response = await api.catalog(domain, options);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    console.warn(`[Catalog] ${domain}: ${err.message}`);
    return { status: 'error', domain, count: 0, products: [] };
  }
}

export async function fetchSocials(api, domain) {
  try {
    const response = await api.socials(domain);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data.socials || {};
  } catch (err) {
    console.warn(`[Socials] ${domain}: ${err.message}`);
    return {};
  }
}

// Sets brand.catalog on each brand as its fetch resolves, a few at a time.
async function attachCatalogs(api, brands, { onCatalog, concurrency }) {
  const queue = [...brands];
  const worker = async () => {
    while (queue.length) {
      const brand = queue.shift();
      const domain = brandDomain(brand.url || '');
      const [catalog, scrapedSocial] = domain
        ? await Promise.all([fetchCatalog(api, domain), fetchSocials(api, domain)])
        : [{ status: 'none', domain: '', count: 0, products: [] }, {}];
      brand.catalog = catalog;
      brand.social = mergeSocial(scrapedSocial, brand.social);
      if (onCatalog) onCatalog(brand);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, brands.length) }, worker));
}

/** A catalog that needs no Google Shopping search: Shopify, or a fresh SERP result from the store. */
export function hasCatalog(catalog) {
  if (!catalog) return false;
  if (catalog.status === 'shopify') return true;
  return catalog.status === 'serp' && (catalog.products?.length || 0) > 0 && !catalog.stale;
}

// A Shopify catalog is already in the store from the crawl that fetched it, so only what the
// search assembled itself (the Google Shopping fallback) travels with the search. The store
// trims what it hands back per brand; the picker fetches the rest.
export function catalogForStore(brand) {
  if (!brand?.catalog || brand.catalog.status !== 'shopify') return brand;
  const { products, ...rest } = brand.catalog;
  return { ...brand, catalog: { ...rest, products: [] } };
}

/**
 * The record the store keeps for a finished search. `keepCatalogs` sends every catalog along, so
 * the store writes them itself instead of relying on the catalog proxy's deferred write; the
 * server does, since it expands a search straight from the store.
 */
export function searchRecord(results, searchId, { keepCatalogs = false } = {}) {
  if (!results.brands?.length) return { type: 'empty', searchId };
  const forStore = keepCatalogs ? (brand) => brand : catalogForStore;
  return {
    type: 'results',
    brands: results.brands.map(forStore),
    searchedBrand: forStore(results.searchedBrand),
    serpApiOutOfCredits: results.serpApiOutOfCredits || false,
    searchId
  };
}

/* -------------------------------------------------------------------------- */
/* Gemini, SerpAPI and OpenGraph                                               */
/* -------------------------------------------------------------------------- */

// ============================================
// PHASE 1: Brand Analysis
// ============================================

const FACTS_PRODUCTS = 15;

/**
 * What the brand's own site says about itself: its title, description and name, and what it
 * sells. Web search for a short domain lands on whichever company owns the name in the news
 * (built.com is a protein bar; "Built" in search is a construction-finance platform), and the
 * analysis has to describe the site that was typed.
 */
export async function brandFacts(api, domain) {
  const [site, catalog] = await Promise.all([
    fetchOpenGraphData(api, `https://${domain}`).catch(() => ({})),
    fetchCatalog(api, domain).catch(() => ({ products: [] }))
  ]);
  const products = (catalog?.products || []).slice(0, FACTS_PRODUCTS);
  return {
    title: site?.title || null,
    description: site?.description || null,
    siteName: site?.siteName || null,
    vendor: products.map(p => p.vendor).find(Boolean) || null,
    productTypes: [...new Set(products.map(p => p.productType).filter(Boolean))].slice(0, 6),
    products: products.map(p => p.title).filter(Boolean)
  };
}

/** The facts as the prompt states them; empty when nothing was read. */
export function factsBlock(facts) {
  if (!facts) return '';
  const lines = [];
  if (facts.siteName || facts.title) lines.push(`Site title: ${[facts.siteName, facts.title].filter(Boolean).join(' | ')}`);
  if (facts.description) lines.push(`Site description: ${facts.description}`);
  if (facts.vendor) lines.push(`Vendor named in the catalog: ${facts.vendor}`);
  if (facts.productTypes?.length) lines.push(`Product types: ${facts.productTypes.join(', ')}`);
  if (facts.products?.length) lines.push(`Products on sale: ${facts.products.join('; ')}`);
  if (!lines.length) return '';
  return `
VERIFIED FACTS FROM THE BRAND'S OWN WEBSITE (read directly from the site and its public catalog):
${lines.map(line => `- ${line}`).join('\n')}

The brand is the company that owns this website and sells these products. Your analysis must describe that business. Search results about a different company that shares the name (another business at another domain) are not this brand: ignore them.
`;
}

async function analyzeBrand(api, domain, facts = null) {
  const prompt = `You are a brand strategist with deep expertise in DTC e-commerce, CPG, and lifestyle brands.

TASK: Perform a comprehensive analysis of this brand before we identify collaboration partners.

INPUT URL: ${domain}
${factsBlock(facts)}
Use web search to research this brand thoroughly. Visit their website, look up press coverage, social media presence, and any available information.

Return your analysis as JSON:

{
  "brandProfile": {
    "name": "Brand Name",
    "url": "https://full-url.com",
    "tagline": "Their tagline or positioning statement if available",
    
    "productAnalysis": {
      "primaryCategory": "e.g., Specialty Foods, Skincare, Home Goods",
      "subcategories": ["specific product types they sell"],
      "heroProducts": ["their 2-3 most popular/signature items"],
      "priceRange": {
        "tier": "budget|mid-market|premium|luxury",
        "typicalPrice": "$XX-$XX range"
      }
    },
    
    "brandDNA": {
      "aesthetic": "2-3 words describing visual style (e.g., 'minimalist California', 'rustic artisanal', 'bold maximalist')",
      "personality": "2-3 words describing brand voice (e.g., 'playful irreverent', 'sophisticated educational', 'warm approachable')",
      "coreValues": ["sustainability", "craftsmanship", "innovation", etc.],
      "originStory": "1 sentence on founding story or brand ethos if known"
    },
    
    "targetCustomer": {
      "persona": "Specific description (e.g., 'health-conscious millennials who cook at home', 'design-forward homeowners')",
      "lifestyle": "What broader lifestyle does this customer lead?",
      "occasions": ["when/why they buy these products"],
      "adjacentInterests": ["what else this customer likely cares about"]
    },
    
    "marketPosition": {
      "competitors": ["2-3 direct competitors"],
      "differentiator": "What makes them unique vs competitors",
      "brandStage": "emerging|growing|established|iconic"
    },
    
    "description": "Exactly 3 sentences: (1) What they sell and their unique approach, (2) Who their customer is, (3) What makes the brand special or noteworthy."
  }
}

Be specific and insightful. This analysis will drive high-quality collaboration recommendations.`;

  const response = await api.gemini({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: {
        parts: [{ text: 'You are a brand analyst. Use web search to research thoroughly. Return only valid JSON.' }]
      },
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.3,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingBudget: 0 }
      }
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`Brand analysis failed: ${response.status} - ${errorData.error || 'Unknown error'}`);
  }

  const data = await response.json();
  const text = extractText(data);
  return parseJsonResponse(text);
}

// ============================================
// PHASE 2: Get Recommendations (Gemini - Brands get URLs)
// ============================================
async function getRecommendations(api, brandProfile, brandName, domain, feedbackContext) {
  const prompt = `You are a world-class brand collaboration curator—part trend forecaster, part matchmaker, part cultural observer.

Your mission: Identify brands that would create EXCEPTIONAL, UNEXPECTED, and COMMERCIALLY VIABLE collaboration opportunities.

=== THE BRAND SEEKING COLLABORATORS ===
${JSON.stringify(brandProfile, null, 2)}

=== YOUR COLLABORATION PHILOSOPHY ===

Great brand collaborations share these traits:
1. **Complementary, not competitive** - Products that enhance each other's use
2. **Audience overlap with discovery** - Shared customer values, but introduces something new
3. **Story synergy** - The "why" of the partnership is immediately obvious and compelling
4. **Elevation** - Both brands benefit; neither feels like they're "trading down"
5. **Bundle logic** - You can envision the actual product bundle or campaign

=== RECOMMENDATION DIMENSIONS ===

For each brand, classify using ONE of these collaboration angles:
- **"same-moment"**: Products used in the same occasion/ritual
- **"same-aesthetic"**: Brands that share visual/design language across different categories
- **"same-values"**: Aligned on mission but different products
- **"gift-pairing"**: Products that make sense as a gift set together
- **"lifestyle-stack"**: Part of the same customer's broader lifestyle/identity
- **"unexpected-delight"**: Non-obvious pairing that tells a story

=== DIVERSITY REQUIREMENTS ===

Your 12-15 brand recommendations MUST include:
- At least 5 **emerging brands** (founded 2020+, under $10M revenue)
- At least 4 **established brands** (well-known, proven track record)
- At least 1 **non-obvious category** (digital product, subscription, experience)
- Mix of price points that make sense for the input brand's customer
- NO direct competitors to the input brand

=== ANTI-PATTERNS TO AVOID ===

DO NOT recommend:
- **ANY products from ${brandName} or ${domain}** - We are finding EXTERNAL collaboration partners
- Generic/obvious choices (e.g., any food brand gets "Whole Foods" or "Williams Sonoma")
- Amazon private label or mass-market brands unless there's a compelling story
- Brands with no distinct identity or commodity products
- The same brands you'd recommend for any brand in this category
- Made-up or fictional products - only recommend REAL products you can verify exist

=== RESEARCH INSTRUCTIONS ===

${feedbackContext}

For EACH brand you recommend:
1. Use web search to verify the brand exists and is active
2. Find their actual website URL from search results
3. Search for their social media handles
4. Find 2-4 specific products from that brand

CRITICAL - For brand URLs: Search for the brand and use their ACTUAL homepage URL from search results. Never guess URLs.

=== OUTPUT FORMAT ===

Return valid JSON only:

{
  "brands": [
    {
      "name": "Brand Name",
      "url": "https://actualbrandwebsite.com",
      "category": "same-moment|same-aesthetic|same-values|gift-pairing|lifestyle-stack|unexpected-delight",
      "brandStage": "emerging|growing|established",
      "reasons": ["3 short bullets on why this collab works with ${brandName}. Each is its own angle: the shared customer moment, the aesthetic or values overlap, and what the pairing unlocks commercially. Under 12 words each, playful and concrete, naming real products or details rather than generic praise. No em dashes, no restating the brand's tagline."],
      "bundleIdea": "One sentence describing a specific product bundle or campaign concept",
      "social": {
        "tiktok": "handle or null",
        "instagram": "handle or null",
        "facebook": "handle or null"
      }
    }
  ],
  "products": [
    {
      "productName": "EXACT Product Name as it appears on the brand's website",
      "brandName": "Brand Name (MUST be different from ${brandName})",
      "brandDomain": "brandname.com",
      "whyThisProduct": "1 sentence on why this specific product pairs well",
      "suggestedBundle": "What ${brandName} product would this pair with?",
      "estimatedPrice": "$XX",
      "social": {
        "tiktok": "handle or null",
        "instagram": "handle or null",
        "facebook": "handle or null"
      }
    }
  ]
}

Requirements:
- 12-15 brands with diversity requirements met
- 20-25 products total
- At least 2 products per recommended brand
- ZERO products from ${brandName} - this is critical
- Specific, REAL product names that can be found via search
- Brand URLs must be real homepage URLs from search results`;

  const systemInstruction = `You are an expert brand collaboration curator. Your recommendations should be specific, creative, and commercially viable.

CRITICAL INSTRUCTIONS:
1. Always use Google Search to research brands and verify information
2. Return ONLY valid JSON—no markdown, no explanations outside the JSON
3. Brand URLs MUST come from search results—never construct or guess URLs
4. Be specific in your reasoning—generic explanations indicate lazy thinking
5. Do NOT recommend any products from ${brandName}`;

  const response = await api.gemini({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: systemInstruction }] },
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.85,
        topK: 50,
        topP: 0.97,
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingBudget: 0 }
      }
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`Recommendations failed: ${response.status} - ${errorData.error || 'Unknown error'}`);
  }

  const data = await response.json();
  const text = extractText(data);
  
  // Store grounding metadata for later use
  const results = parseJsonResponse(text);
  results._groundingMetadata = data.candidates?.[0]?.groundingMetadata;
  
  return results;
}

// ============================================
// AUGMENT BRANDS WITH GROUNDING METADATA
// ============================================
function augmentWithGroundingMetadata(results, responseData) {
  const groundingMetadata = results._groundingMetadata || responseData?.candidates?.[0]?.groundingMetadata;
  const groundingChunks = groundingMetadata?.groundingChunks || [];
  const groundedUrisByTitle = new Map();

  for (const chunk of groundingChunks) {
    const web = chunk.web;
    if (web?.uri && web?.title && !web.uri.includes('google.com/')) {
      groundedUrisByTitle.set(web.title.toLowerCase(), web.uri.trim());
    }
  }

  // Augment brand URLs from grounding if available
  if (groundedUrisByTitle.size > 0 && results.brands?.length) {
    results.brands = results.brands.map((brand) => {
      // If brand already has a valid-looking URL, keep it
      if (brand.url && brand.url.startsWith('http') && !brand.url.includes('google.com')) {
        return brand;
      }
      
      const name = (brand.name || '').toLowerCase();
      for (const [title, uri] of groundedUrisByTitle) {
        if (title.includes(name) || name.includes(title.split(' ')[0])) {
          try {
            const parsed = new URL(uri);
            if (parsed.pathname === '/' || parsed.pathname.length < 10) {
              return { ...brand, url: uri };
            }
          } catch {
            // Skip invalid URLs
          }
        }
      }
      return brand;
    });
  }

  // Clean up internal metadata
  delete results._groundingMetadata;
  
  return results;
}


// ============================================
// FETCH PRODUCTS FROM RECOMMENDED BRANDS (OPTIMIZED)
// Instead of 4 searches per product, we do 1 search per brand
// This reduces SERP API usage by ~87%
// ============================================
async function fetchProductsFromBrands(api, brands) {
  console.log(`[Products] Fetching top products from ${brands.length} brands (optimized: 1 search per brand)`);
  
  const allProducts = [];
  let outOfCredits = false;
  
  // Limit to top 5 brands to further optimize
  const brandsToSearch = brands.slice(0, 5);
  console.log(`[Products] Will search these brands:`, brandsToSearch.map(b => b.name));
  
  for (const brand of brandsToSearch) {
    if (outOfCredits) break;
    
    try {
      const brandProducts = await fetchBrandTopProducts(api, brand);
      
      if (brandProducts && brandProducts.outOfCredits) {
        outOfCredits = true;
        break;
      }
      
      if (Array.isArray(brandProducts)) {
        allProducts.push(...brandProducts);
      }
    } catch (err) {
      if (err.message === 'SERP_API_OUT_OF_CREDITS') {
        outOfCredits = true;
        break;
      }
      console.warn(`[Products] Failed to fetch products for ${brand.name}:`, err.message);
    }
    
    // Small delay between brand searches
    await sleep(100);
  }
  
  if (outOfCredits) {
    return { outOfCredits: true, products: [] };
  }
  
  console.log(`[Products] Total products from all brands: ${allProducts.length}`);
  return allProducts;
}

// ============================================
// FETCH TOP PRODUCTS FOR A SINGLE BRAND
// Uses Google Shopping to get real, purchasable products
// ============================================
async function fetchBrandTopProducts(api, brand) {
  const brandName = brand.name;
  const storeDomain = brandDomain(brand.url || '');
  
  console.log(`[Products] Searching Google Shopping for: ${brandName} (domain: ${storeDomain})`);
  
  try {
    // Single search: brand name on Google Shopping
    const searchResult = await serpApiSearch(api, `${brandName}`, 'google_shopping');
    
    if (!searchResult || !searchResult.shopping_results || searchResult.shopping_results.length === 0) {
      console.log(`[Products] No shopping results for ${brandName}`);
      return [];
    }
    
    console.log(`[Products] Got ${searchResult.shopping_results.length} raw shopping results for ${brandName}`);
    
    // Filter and score results to find products actually from this brand
    const brandLower = brandName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const domainLower = storeDomain.toLowerCase().replace(/[^a-z0-9.]/g, '');
    
    // Also create word-based matching for multi-word brands
    const brandWords = brandName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    
    console.log(`[Products] Brand matching: normalized="${brandLower}", domain="${domainLower}", words=${JSON.stringify(brandWords)}`);
    
    const brandProducts = searchResult.shopping_results
      .filter(result => {
        const title = (result.title || '').toLowerCase();
        const source = (result.source || '').toLowerCase();
        // product_link is a google.com search URL carrying the query, so it names the brand on
        // every result; only the merchant's own link says anything about who sells it.
        const merchantLink = (result.link || '').toLowerCase();
        
        // Normalize title and source the same way we normalize brand name (remove spaces/special chars)
        const titleNormalized = title.replace(/[^a-z0-9]/g, '');
        const sourceNormalized = source.replace(/[^a-z0-9]/g, '');
        
        // Must be from this brand (in title, source, or the merchant link)
        // Check both normalized and raw versions for flexibility
        const isBrandMatch = 
          title.includes(brandLower) ||
          titleNormalized.includes(brandLower) ||
          source.includes(brandLower) ||
          sourceNormalized.includes(brandLower) ||
          (domainLower && merchantLink.includes(domainLower)) ||
          // Also match if ALL significant brand words appear in title/source
          (brandWords.length > 1 && brandWords.every(w => title.includes(w) || source.includes(w)));
        
        const hasRequiredFields = result.thumbnail && (result.product_link || result.link);
        
        // Log first few results for debugging
        if (searchResult.shopping_results.indexOf(result) < 3) {
          console.log(`[Products] Result check for "${brandName}": title="${title.substring(0, 50)}", source="${source}", match=${isBrandMatch}, hasFields=${hasRequiredFields}`);
        }
        
        return isBrandMatch && hasRequiredFields;
      })
      .slice(0, 4) // Take top 4 products per brand
      .map(result => ({
        productName: result.title || 'Unknown Product',
        brandName: brandName,
        brandDomain: storeDomain,
        url: result.product_link || result.link,
        imageUrl: result.thumbnail,
        price: result.extracted_price || result.price,
        source: result.source,
        verified: true,
        searchSource: 'google_shopping_brand'
      }));
    
    console.log(`[Products] Found ${brandProducts.length} products for ${brandName} (filtered from ${searchResult.shopping_results.length})`);
    return brandProducts;
    
  } catch (err) {
    if (err.message === 'SERP_API_OUT_OF_CREDITS') {
      throw err;
    }
    console.warn(`[Products] Error fetching products for ${brandName}:`, err.message);
    return [];
  }
}






// ============================================
// SERPAPI: Core Search Function (via server proxy to avoid CORS)
// ============================================
async function serpApiSearch(api, query, engine = 'google') {
  console.log(`[SerpAPI] Query: "${query}" Engine: ${engine}`);
  
  const params = new URLSearchParams({
    q: query,
    engine: engine
  });

  const response = await api.serp(params);

  if (!response.ok) {
    console.error(`[SerpAPI] Request failed: ${response.status}`);
    throw new Error(`SerpAPI request failed: ${response.status}`);
  }

  const data = await response.json();
  
  // Check for out of credits error
  if (data.error && data.error.includes('run out of searches')) {
    console.error(`[SerpAPI] Out of credits!`);
    throw new Error('SERP_API_OUT_OF_CREDITS');
  }
  
  console.log(`[SerpAPI] Results - Shopping: ${data.shopping_results?.length || 0}, Organic: ${data.organic_results?.length || 0}`);
  return data;
}




// ============================================
// Fetch OG Image from URL (uses OpenGraph proxy to avoid CORS)
// Falls back to high-res favicon if OG image not available
// ============================================
async function fetchOgImageUrl(api, url) {
  try {
    // Use the OpenGraph proxy which properly fetches OG data server-side
    const ogData = await fetchOpenGraphData(api, url);
    if (ogData?.imageUrl) {
      console.log(`[fetchOgImageUrl] Got OG image for ${url}: ${ogData.imageUrl}`);
      return ogData.imageUrl;
    }
    // No favicon stand-in: a favicon blown up to a cover is worse than the catalog's first
    // product, which the card takes once the catalog is in, or no cover at all.
    console.warn(`[fetchOgImageUrl] No image found for ${url}`);
    return null;
  } catch (err) {
    console.warn(`[fetchOgImageUrl] Failed for ${url}:`, err.message);
    return null;
  }
}

// ============================================
// UTILITY: Extract Brand Name from Domain
// ============================================
function extractBrandName(domain) {
  return domain
    .replace(/^(https?:\/\/)?(www\.)?/, '')
    .replace(/\.(com|co|io|shop|store|net|org|us|uk|ca).*$/, '')
    .replace(/[^a-zA-Z0-9]/g, ' ')
    .trim();
}




// ============================================
// UTILITY: Sleep
// ============================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// UTILITY: Fetch with Retry (for rate limiting)
// ============================================
// Responses worth another attempt: rate limiting, and the proxy or Gemini failing outright.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * A signal for one attempt: aborts when the caller's `signal` does, or after `timeoutMs`.
 * `release` drops the timer and listener once the attempt is over.
 */
function attemptSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = timeoutMs
    ? setTimeout(() => controller.abort(new DOMException(`Timed out after ${Math.round(timeoutMs / 1000)}s`, 'TimeoutError')), timeoutMs)
    : null;
  return {
    signal: controller.signal,
    release() {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  };
}

function isTimeout(err) {
  return err?.name === 'TimeoutError';
}

/**
 * fetch with retries. Retries a network failure, a per-attempt timeout (`timeoutMs`) and a
 * retryable status (429 and 5xx), with backoff; a cancellation through `options.signal` is
 * never retried. After the last attempt the last response comes back, or the last error is
 * thrown, so callers see what went wrong.
 */
export async function fetchWithRetry(url, options = {}, maxRetries = 3, fetchImpl = fetch, { timeoutMs = 0 } = {}) {
  const { signal, ...rest } = options || {};
  let lastError;
  let lastResponse;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Request cancelled', 'AbortError');
    const attemptAbort = attemptSignal(signal, timeoutMs);
    try {
      const response = await fetchImpl(url, { ...rest, signal: attemptAbort.signal });

      if (RETRYABLE_STATUS.has(response.status)) {
        lastResponse = response;
        if (attempt < maxRetries - 1) {
          const waitTime = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
          console.log(`[API] HTTP ${response.status}, waiting ${waitTime / 1000}s before retry ${attempt + 1}/${maxRetries}...`);
          await sleep(waitTime);
        }
        continue;
      }

      return response;
    } catch (err) {
      // The caller gave up: stop here, whatever the attempt was doing.
      if (signal?.aborted) throw err;
      lastError = err;
      console.warn(`[API] Request ${isTimeout(err) ? 'timed out' : 'failed'} (attempt ${attempt + 1}/${maxRetries}):`, err.message);

      if (attempt < maxRetries - 1) {
        const waitTime = Math.pow(2, attempt) * 1000;
        await sleep(waitTime);
      }
    } finally {
      attemptAbort.release();
    }
  }

  if (lastResponse) return lastResponse;
  if (isTimeout(lastError)) {
    throw new Error(`The request timed out ${maxRetries} times (${Math.round(timeoutMs / 1000)}s each). Please try again in a moment.`);
  }
  throw lastError || new Error('Request failed after retries');
}

// ============================================
// UTILITY: Extract text from Gemini response
// Concatenates all non-thought text parts — Gemini 2.5 sometimes splits
// long outputs across multiple parts (especially with google_search grounding).
// ============================================
export function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter(p => p && typeof p.text === 'string' && !p.thought)
    .map(p => p.text)
    .join('');
}

// ============================================
// UTILITY: Parse JSON Response from AI
// ============================================
export function parseJsonResponse(text) {
  if (!text) throw new Error('No response from AI');

  let jsonStr = text;

  // Handle markdown code blocks
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1];
  }

  try {
    return JSON.parse(jsonStr.trim());
  } catch (parseErr) {
    // Try to repair common JSON issues
    try {
      const cleaned = jsonStr
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']')
        .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
        .trim();
      return JSON.parse(cleaned);
    } catch (repairErr) {
      // jsonrepair also salvages a reply cut off mid-object, fence and all
      try {
        return JSON.parse(jsonrepair(jsonStr));
      } catch {
        // Fall through
      }

      const isTruncated = parseErr.message?.includes('Unexpected end') ||
                          parseErr.message?.includes('Unterminated string');
      throw new Error(isTruncated
        ? 'Response was cut off. Please try again.'
        : `Could not parse results: ${parseErr.message}`);
    }
  }
}

// ============================================
// UTILITY: Ensure HTTPS prefix
// ============================================
export function ensureHttps(item) {
  if (!item) return item;
  const url = (item.url || '').trim();
  if (!url) return item;
  const fullUrl = url.startsWith('http') ? url : 'https://' + url.replace(/^\/+/, '');
  return { ...item, url: fullUrl };
}

/**
 * Fetch Open Graph metadata (image, favicon, etc.) from OpenGraph.io API via proxy.
 * @param {string} url - Page URL to fetch
 * @returns {Promise<{imageUrl?: string, faviconUrl?: string}>}
 */
async function fetchOpenGraphData(api, url) {
  try {
    if (url == null || typeof url !== 'string' || !url.trim()) {
      console.warn('[OpenGraph] Invalid URL provided:', url);
      return { imageUrl: null, faviconUrl: null };
    }
    
    const fullUrl = url.trim().startsWith('http') ? url.trim() : `https://${url.trim()}`;
    const res = await api.opengraph(fullUrl);
    
    if (!res.ok) {
      const errorText = await res.text().catch(() => 'Unknown error');
      console.warn(`[OpenGraph] API error ${res.status} for ${fullUrl}: ${errorText}`);
      return { imageUrl: null, faviconUrl: null };
    }
    
    const data = await res.json();
    
    // Log raw response for debugging
    console.log(`[OpenGraph] Raw response for ${fullUrl}:`, JSON.stringify(data));
    
    const text = key => (typeof data?.[key] === 'string' && data[key].trim() ? data[key].trim() : null);
    const result = {
      imageUrl: data?.imageUrl && typeof data.imageUrl === 'string' ? data.imageUrl : null,
      faviconUrl: data?.faviconUrl && typeof data.faviconUrl === 'string' ? data.faviconUrl : null,
      title: text('title'),
      description: text('description'),
      siteName: text('siteName')
    };
    
    if (result.imageUrl) {
      console.log(`[OpenGraph] ✓ Image found: ${result.imageUrl}`);
    } else {
      console.warn(`[OpenGraph] ✗ No image in response for: ${fullUrl}`);
    }
    
    return result;
  } catch (err) {
    console.error('[OpenGraph] Network error:', err.message || err);
    return { imageUrl: null, faviconUrl: null };
  }
}
