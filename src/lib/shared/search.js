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
import { GRADE_QUESTIONS, gradeState, readGrade } from './jev.js';
import { jsonrepair } from './vendor/jsonrepair/regular/jsonrepair.js';
import { isStorefrontCatalog } from './catalog.js';
import { needsStandIns, gatherStandIns } from './standins.js';

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
    // `keepalive`: the proxy streams a pulse while Gemini works, for a call that can outlast the
    // edge's patience (src/routes/api/gemini/+server.js); a failure then arrives in the body.
    gemini: (body, model, { keepalive = false } = {}) => fetchWithRetry(at(`/api/gemini${geminiQuery(model, keepalive)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    }, 3, fetchImpl, { timeoutMs: GEMINI_ATTEMPT_TIMEOUT_MS }),
    serp: (params) => get(`/api/serpapi?${params}`),
    // `refresh` crawls the storefront now rather than serving the stored catalog (a day old at most).
    catalog: (domain, { refresh = false } = {}) => get(`/api/catalog?domain=${encodeURIComponent(domain)}${refresh ? '&refresh=1' : ''}`),
    socials: (domain) => get(`/api/socials?domain=${encodeURIComponent(domain)}`),
    opengraph: (url) => get(`/api/opengraph?url=${encodeURIComponent(url)}`),
    // One page read for its products and product pictures (shared/page.js).
    page: (url) => get(`/api/page?url=${encodeURIComponent(url)}`),
    // Jev grades one candidate against the searched brand (src/lib/shared/jev.js).
    jev: (body) => fetchImpl(at('/api/jev'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) })
  };
}

function geminiQuery(model, keepalive) {
  const params = new URLSearchParams();
  if (model) params.set('model', model);
  if (keepalive) params.set('keepalive', '1');
  const query = params.toString();
  return query ? `?${query}` : '';
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

const ANGLES = new Set(['same-moment', 'same-aesthetic', 'same-values', 'gift-pairing', 'lifestyle-stack', 'unexpected-delight']);
const LANES = new Set(['same-shelf', 'adjacent-function', 'lifestyle', 'parallel-premium', 'unexpected']);
// The angle a lane reads as when the model wrote something else, and the other way round.
const LANE_ANGLE = { 'same-shelf': 'same-moment', 'adjacent-function': 'same-moment', lifestyle: 'lifestyle-stack', 'parallel-premium': 'same-aesthetic', unexpected: 'unexpected-delight' };
const ANGLE_LANE = { 'same-moment': 'same-shelf', 'same-aesthetic': 'parallel-premium', 'same-values': 'adjacent-function', 'gift-pairing': 'parallel-premium', 'lifestyle-stack': 'lifestyle', 'unexpected-delight': 'unexpected' };

/** Every brand carries one of the six angles and one of the five lanes, whatever the model wrote. */
export function normalizeRecommendations(brands) {
  return brands.map(brand => {
    const lane = LANES.has(brand.lane) ? brand.lane : (ANGLE_LANE[brand.lane] || ANGLE_LANE[brand.category] || 'lifestyle');
    const category = ANGLES.has(brand.category) ? brand.category : (LANE_ANGLE[lane] || 'same-moment');
    return { ...brand, lane, category };
  });
}

/** How many well-trodden brands a list may carry; a kitchen brand's list came back with seven. */
export const WELL_TRODDEN_MAX = 2;
const WELL_TRODDEN_FLOOR = 10;

/**
 * Keeps the first two well-trodden picks and drops the rest, while the list stays long enough to
 * be a list. The prompt asks for this; a hard prior does not always listen.
 */
export function capWellTrodden(brands, frequentBrands, { max = WELL_TRODDEN_MAX, floor = WELL_TRODDEN_FLOOR } = {}) {
  const trodden = new Set((frequentBrands || []).map(b => (b.name || b.domain || '').trim().toLowerCase()).filter(Boolean));
  if (!trodden.size) return brands;
  let kept = 0;
  let count = brands.length;
  return brands.filter(brand => {
    if (!trodden.has((brand.name || '').trim().toLowerCase())) return true;
    if (kept < max || count <= floor) { kept++; return true; }
    count--;
    return false;
  });
}

/**
 * The brands the finder recommends most across recent searches. Left to itself the model reaches
 * for the same famous DTC names for every brand (Brightland in 53 of the last 97 searches); told
 * which those are, it reaches past them.
 */
export function buildFrequentContext(brands) {
  const names = (brands || []).map(b => (b.name || b.domain || '').trim()).filter(Boolean);
  if (!names.length) return '';
  return `\n\nALREADY WELL-TRODDEN (recommended many times across other brands' searches): ${names.join(', ')}.\nDo not reach for these by habit. Include one only if it is clearly the single best fit in its lane, and at most 2 of them in total; otherwise find a brand beyond this list.\n`;
}

/**
 * Runs one search. `feedback`, `knownPartners` and `frequentBrands` are what the store holds
 * for it; the caller loads them, the browser through store.js and the server from D1.
 *
 * Callbacks: onProgress(step) with step 0-5, onBrandsReady({ searchedBrand, brands }) as soon
 * as the recommendations are in, onCatalog(brand) as each brand's catalog resolves.
 */
export async function discoverComplementaryBrands(url, {
  api, feedback = [], knownPartners = [], frequentBrands = [],
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
  const context = buildFeedbackContext(feedback) + buildKnownPartnersContext(knownPartners) + buildFrequentContext(frequentBrands);
  // The unexpected lane is ideated beside the main call: it needs only the profile, and the
  // stronger model takes its time.
  const unexpectedPending = unexpectedCollabs(api, { brandProfile: resolvedBrandProfile, brandName, domain, frequentBrands });
  const recommendations = await getRecommendations(api, resolvedBrandProfile, brandName, domain, context);
  const augmentedResults = augmentWithGroundingMetadata(recommendations, null);
  const capped = capWellTrodden(normalizeRecommendations(augmentedResults.brands || []).map(ensureHttps), frequentBrands);
  const merged = mergeUnexpected(capped, await unexpectedPending);
  const composed = composeGraded(merged, await gradeCandidates(api, resolvedBrandProfile, merged), frequentBrands);
  // The emerging count is read after grading, since Jev's stages are the ones that stand; what
  // the top-up adds is graded the same way.
  const toppedUp = await topUpEmerging(api, { brandProfile: resolvedBrandProfile, brandName, domain, brands: composed, frequentBrands });
  const brands = toppedUp === composed ? composed : composeGraded(toppedUp, await gradeCandidates(api, resolvedBrandProfile, toppedUp), frequentBrands);

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
    targetCustomer: searchedBrand.targetCustomer,
    // What it sells and at what price, which is what its stand-in products are made from.
    productAnalysis: searchedBrand.productAnalysis
  };

  console.log(`[Discovery] Brands ready: ${brands.length} brands found`);
  if (typeof onBrandsReady === 'function') onBrandsReady({ searchedBrand: searchedBrandData, brands });

  // Public catalogs for the searched brand and every recommendation
  await attachCatalogs(api, [searchedBrandData, ...brands], { onCatalog, concurrency: settings.catalogConcurrency });

  // The searched brand with no catalog gets stand-in products instead, so the picker can still
  // lead with it. Kept with the search, beside the catalog rather than as one.
  const standInsPending = needsStandIns(searchedBrandData)
    ? gatherStandIns(api, searchedBrandData).catch(err => { console.warn(`[Stand-ins] ${err.message}`); return null; })
    : null;
  const serpApiOutOfCredits = await attachSerpFallback(api, brands, { limit: settings.serpFallbackBrands, onCatalog });

  const standIns = await standInsPending;
  if (standIns) searchedBrandData.standIns = standIns;

  console.log(`[Discovery] Complete. ${brands.length} brands, ${brands.filter(b => b.catalog?.products?.length).length} with products`);
  return { searchedBrand: searchedBrandData, brands, serpApiOutOfCredits };
}

/**
 * Google Shopping only for brands without a public catalog (paid, 1 search per brand). A brand
 * whose Google Shopping catalog the store served fresh is not searched again; a stale one is, and
 * one whose products staff hid never is. True when the SERP account is out of credits.
 */
async function attachSerpFallback(api, brands, { limit, onCatalog }) {
  const fallbackBrands = brands.filter(b => !b.catalog?.hidden && !hasCatalog(b.catalog)).slice(0, limit);
  if (fallbackBrands.length === 0) return false;
  console.log(`[Discovery] SERP fallback for ${fallbackBrands.length} brands without a catalog`);
  const serpResult = await fetchProductsFromBrands(api, fallbackBrands);
  if (serpResult && serpResult.outOfCredits) return true;
  if (Array.isArray(serpResult)) {
    fallbackBrands.forEach(brand => {
      const products = serpResult
        .filter(p => p.brandName === brand.name)
        .map(p => ({ id: p.url, title: p.productName, url: p.url, image: p.imageUrl, price: typeof p.price === 'number' ? p.price : null }));
      if (products.length === 0) return;
      brand.catalog = { ...brand.catalog, status: 'serp', count: products.length, products };
      if (onCatalog) onCatalog(brand);
    });
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Follow-ups: a note, more like these, surprise me                            */
/* -------------------------------------------------------------------------- */

/** How many brands a note or "More like these" adds; "Surprise me" adds UNEXPECTED_COUNT. */
export const EXTEND_COUNT = 6;

export const TURN_KINDS = ['note', 'more', 'surprise'];

/** What the divider says for a follow-up that carries no note of its own. */
export const TURN_LABELS = { more: 'More like these', surprise: 'Surprise me' };

const MORE_BRIEF = 'More in the same spirit as the list so far: the same customer and the same tier, fresh names rather than the famous ones, and favor whichever lanes are thinnest so far.';

/**
 * One more round for a list already on screen: a note from the person, "more like these", or
 * "surprise me". Answers with the brands to append, graded and with catalogs attached, or []
 * when nothing new came back. Nothing in `brands` comes back again.
 *
 * Callbacks: onProgress(step) with step 0-2 (reading, finding, catalogs).
 */
export async function extendRecommendations(api, {
  brandProfile, brands, kind = 'note', brief = '', frequentBrands = [], onProgress, onCatalog, config = {}
}) {
  const settings = { ...SEARCH_DEFAULTS, ...config };
  const domain = brandDomain(brandProfile?.url || '');
  const brandName = brandProfile?.name || extractBrandName(domain);
  const progress = (step) => { if (typeof onProgress === 'function') onProgress(step); };

  progress(0);
  const candidates = kind === 'surprise'
    ? await unexpectedCollabs(api, { brandProfile, brandName, domain, frequentBrands, listed: brands })
    : await moreRecommendations(api, { brandProfile, brandName, domain, brands, brief: kind === 'more' ? MORE_BRIEF : brief, frequentBrands });
  progress(1);

  const fresh = withoutListed(candidates, brands);
  const gated = fresh.length ? gateGraded(fresh, await gradeCandidates(api, brandProfile, fresh)) : [];
  const added = gated.slice(0, kind === 'surprise' ? UNEXPECTED_COUNT : EXTEND_COUNT);
  console.log(`[Discovery] Follow-up (${kind}): ${added.length} of ${candidates.length} candidates kept`);
  if (!added.length) return [];

  progress(2);
  await attachCatalogs(api, added, { onCatalog, concurrency: settings.catalogConcurrency });
  await attachSerpFallback(api, added, { limit: settings.serpFallbackBrands, onCatalog });
  return added;
}

/** The candidates not already on the list, by name or site, each once. */
function withoutListed(candidates, brands) {
  const seen = new Set(brands.flatMap(b => [b.name?.toLowerCase(), brandDomain(b.url || '')]).filter(Boolean));
  return candidates.filter(brand => {
    const keys = [brand.name?.toLowerCase(), brandDomain(brand.url || '')].filter(Boolean);
    if (!keys.length || keys.some(key => seen.has(key))) return false;
    keys.forEach(key => seen.add(key));
    return true;
  });
}

/**
 * The grounded call again, told what is already listed and what the reader asked for. The ask
 * decides the category, tier, tone and lane of every brand; the rest of the rules stand.
 */
async function moreRecommendations(api, { brandProfile, brandName, domain, brands, brief, frequentBrands }) {
  const listed = brands.map(b => (b.lane ? `${b.name} (${b.lane})` : b.name)).filter(Boolean);
  const trodden = (frequentBrands || []).map(b => b.name || b.domain).filter(Boolean);
  const ask = String(brief || '').trim() || MORE_BRIEF;

  const prompt = `You are a world-class brand collaboration curator. You already recommended collaboration partners for the brand below, and the person reading the list has asked for more.

=== THE BRAND SEEKING COLLABORATORS ===
${JSON.stringify(brandProfile, null, 2)}

=== ALREADY ON THE LIST (never repeat these) ===
${listed.join(', ') || 'nothing yet'}

=== THE ASK ===
"${ask}"

Answer the ask directly. It is the reader's steer: let it decide the category, the tier, the tone and the lane of every brand you add. If it names a brand, treat that brand as the reference point (add it only if it is not already listed and fits; otherwise find brands in its spirit). If it rules something out, rule it out. If it is open-ended, reach past the list for what the reader has not seen yet.

Add ${EXTEND_COUNT + 2} brands. Every one:
- Real, active, and selling its own products. Verify each with web search and use its ACTUAL homepage URL from the results; never guess a URL.
- Not ${brandName} (${domain}), not a direct competitor, and not already on the list above.
- Not one of these, recommended everywhere: ${trodden.join(', ') || 'none'}.
- The strongest fit for THIS ask and THIS customer, not the most famous name you can think of.
- Complementary, with a bundle you can picture.

Return valid JSON only:
{
  "brands": [
    {
      "name": "Brand Name",
      "url": "https://actualbrandwebsite.com",
      "category": "same-moment|same-aesthetic|same-values|gift-pairing|lifestyle-stack|unexpected-delight",
      "lane": "same-shelf|adjacent-function|lifestyle|parallel-premium|unexpected",
      "brandStage": "emerging|growing|established",
      "reasons": ["3 short bullets on why this collab works with ${brandName} and answers the ask. Under 12 words each, playful and concrete, naming real products. No em dashes."],
      "bundleIdea": "One sentence describing a specific product bundle or campaign concept",
      "social": { "tiktok": "handle or null", "instagram": "handle or null", "facebook": "handle or null" }
    }
  ]
}`;

  const { parsed } = await geminiJson(api, 'Follow-up', {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: `You are an expert brand collaboration curator. Use Google Search to verify every brand and take its URL from the results. Return ONLY valid JSON. Do NOT recommend ${brandName} or a direct competitor of it.` }] },
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.9, topK: 50, topP: 0.97, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } }
  }, { parse: text => { const r = parseJsonResponse(text); if (!Array.isArray(r?.brands)) throw new Error('No brands in the answer'); return r; } });
  return normalizeRecommendations(parsed.brands).map(ensureHttps);
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

/** A catalog that needs no Google Shopping search: the brand's storefront, or a fresh SERP result from the store. */
export function hasCatalog(catalog) {
  if (!catalog) return false;
  if (isStorefrontCatalog(catalog)) return true;
  return catalog.status === 'serp' && (catalog.products?.length || 0) > 0 && !catalog.stale;
}

// A storefront catalog is already in the store from the crawl that fetched it, so only what the
// search assembled itself (the Google Shopping fallback) travels with the search. The store
// trims what it hands back per brand; the picker fetches the rest.
export function catalogForStore(brand) {
  if (!isStorefrontCatalog(brand?.catalog)) return brand;
  const { products, ...rest } = brand.catalog;
  return { ...brand, catalog: { ...rest, products: [] } };
}

/**
 * The record the store keeps for a finished search. `keepCatalogs` sends every catalog along, so
 * the store writes them itself instead of relying on the catalog proxy's deferred write; the
 * server does, since it expands a search straight from the store.
 */
/**
 * A stored list read back as its thread: the first search's brands, then each follow-up in the
 * order it was made with the brands it added. A brand names its follow-up in `turn`.
 */
export function threadOf(brands) {
  const base = [];
  const turns = [];
  const byId = new Map();
  for (const brand of brands || []) {
    const turn = brand?.turn;
    if (!turn?.id) { base.push(brand); continue; }
    if (!byId.has(turn.id)) {
      const entry = { turn: { id: turn.id, kind: turn.kind || 'note', text: turn.text || '' }, brands: [] };
      byId.set(turn.id, entry);
      turns.push(entry);
    }
    byId.get(turn.id).brands.push(brand);
  }
  return { base, turns };
}

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

  const { parsed } = await geminiJson(api, 'Brand analysis', {
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
  }, { parse: text => { const r = parseJsonResponse(text); if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('No profile in the answer'); return r; } });
  return parsed;
}

/**
 * A grounded Gemini call, kept alive by the proxy, read as JSON. A failure the proxy reports in
 * the body (its own 504, Gemini's 5xx) is tried once more, and so is an answer that is not the
 * JSON asked for (a grounded call now and then answers in prose); anything else is thrown as it
 * is. Returns { data, parsed } when `parse` is given, else the data alone.
 */
export async function geminiJson(api, label, body, { attempts = 2, model = undefined, parse = null } = {}) {
  let failure = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await api.gemini(body, model, { keepalive: true });
    const data = await response.json().catch(() => ({}));
    if (response.ok && !data.error) {
      if (!parse) return data;
      try {
        return { data, parsed: parse(extractText(data)) };
      } catch (err) {
        failure = new Error(`${label} failed: ${err.message}`);
        console.warn(`[API] ${label}: ${err.message.slice(0, 80)}, trying once more`);
        continue;
      }
    }
    const status = data.status || response.status;
    failure = new Error(`${label} failed: ${status} - ${data.error || 'Unknown error'}`);
    if (!(status >= 500)) break;
    console.warn(`[API] ${label}: ${status}, trying once more`);
  }
  throw failure;
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

=== BREADTH: COVER THESE LANES ===

Spread the 14-16 brands across ALL five lanes, at least 2 in each and no more than 4, chosen for THIS brand's customer. In every lane pick the STRONGEST fit, not the most famous brand you can think of.
1. **"same-shelf"**: products used alongside this brand's own, on the same shelf or in the same routine (never a direct competitor).
2. **"adjacent-function"**: the next need this customer has around the product: for food and drink that is hydration, supplements, recovery or sleep; for beauty it is tools, skin health or wellness; for home it is care, storage or the rituals the product serves; for apparel it is gear, footwear or recovery.
3. **"lifestyle"**: the apparel, equipment, spaces or services this customer's day runs on.
4. **"parallel-premium"**: a category this customer already buys in at the same tier that is NOT this brand's own: beauty and personal care, home, kitchen, or wellness, whichever is furthest from this brand while still obviously the same person.
5. **"unexpected"**: a pairing that tells a story only these two brands could tell, and that a buyer would still say yes to.

=== DIVERSITY REQUIREMENTS ===

Your 14-16 brand recommendations MUST also include:
- At least 4 **emerging brands** (founded 2020+, under $10M revenue)
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

CRITICAL - For brand URLs: Search for the brand and use their ACTUAL homepage URL from search results. Never guess URLs.

=== OUTPUT FORMAT ===

Return valid JSON only:

{
  "brands": [
    {
      "name": "Brand Name",
      "url": "https://actualbrandwebsite.com",
      "category": "same-moment|same-aesthetic|same-values|gift-pairing|lifestyle-stack|unexpected-delight",
      "lane": "same-shelf|adjacent-function|lifestyle|parallel-premium|unexpected",
      "brandStage": "emerging|growing|established",
      "reasons": ["3 short bullets on why this collab works with ${brandName}. Each is its own angle: the shared customer moment, the aesthetic or values overlap, and what the pairing unlocks commercially. Under 12 words each, playful and concrete, naming real products or details rather than generic praise. No em dashes, no restating the brand's tagline."],
      "bundleIdea": "One sentence describing a specific product bundle or campaign concept",
      "social": {
        "tiktok": "handle or null",
        "instagram": "handle or null",
        "facebook": "handle or null"
      }
    }
  ]
}

Requirements:
- 14-16 brands
- EVERY one of the five lanes has at least 2 brands and no lane has more than 4. If a lane seems hard for this brand, that is the lane that makes the list worth reading: fill it with the strongest real fit rather than skipping it
- At least 4 emerging brands (founded 2020+, under $10M revenue)
- At most 2 brands from the ALREADY WELL-TRODDEN list, if one was given. The reader has seen those; the rest of the list must reach beyond them
- "category" is one of the six collaboration angles exactly as written above; "lane" is one of the five lanes
- Brand URLs must be real homepage URLs from search results`;

  const systemInstruction = `You are an expert brand collaboration curator. Your recommendations should be specific, creative, and commercially viable.

CRITICAL INSTRUCTIONS:
1. Always use Google Search to research brands and verify information
2. Return ONLY valid JSON—no markdown, no explanations outside the JSON
3. Brand URLs MUST come from search results—never construct or guess URLs
4. Be specific in your reasoning—generic explanations indicate lazy thinking
5. Do NOT recommend any products from ${brandName}`;

  const { data, parsed: results } = await geminiJson(api, 'Recommendations', {
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
  }, { parse: text => { const r = parseJsonResponse(text); if (!Array.isArray(r?.brands)) throw new Error('No brands in the answer'); return r; } });
  // Store grounding metadata for later use
  results._groundingMetadata = data.candidates?.[0]?.groundingMetadata;
  return results;
}

// ============================================
// PHASE 2b: Emerging top-up
// ============================================

/** How many emerging brands a list should carry; the main call honours its own quota unevenly. */
export const EMERGING_MIN = 4;
const RECOMMENDATIONS_MAX = 15;

// Room is made from the end of the list, never from an emerging brand or a pairing that was
// ideated for the unexpected lane (those sit at the end, and are the point).
function withoutLastEstablished(brands, count) {
  const out = [...brands];
  for (let i = out.length - 1; i >= 0 && count > 0; i--) {
    if (out[i].brandStage === 'emerging' || out[i].hook || out[i].lane === 'unexpected') continue;
    out.splice(i, 1);
    count--;
  }
  return out;
}

/**
 * Brings the list up to EMERGING_MIN emerging brands with one more, smaller grounded call, aimed
 * at the lanes with the fewest brands. Nothing already listed or well-trodden; a failure leaves
 * the list as it was.
 */
export async function topUpEmerging(api, { brandProfile, brandName, domain, brands, frequentBrands = [] }) {
  const have = brands.filter(b => b.brandStage === 'emerging').length;
  const need = EMERGING_MIN - have;
  if (need <= 0) return brands;

  const counts = Object.fromEntries([...LANES].map(lane => [lane, brands.filter(b => b.lane === lane).length]));
  const thinLanes = Object.entries(counts).sort((a, b) => a[1] - b[1]).slice(0, 2).map(([lane]) => lane);
  const listed = brands.map(b => b.name).filter(Boolean);
  const trodden = (frequentBrands || []).map(b => b.name || b.domain).filter(Boolean);

  const prompt = `You are a brand collaboration curator. For the brand below you already recommended: ${listed.join(', ')}.

=== THE BRAND ===
${JSON.stringify({ name: brandProfile.name, url: brandProfile.url, productAnalysis: brandProfile.productAnalysis, targetCustomer: brandProfile.targetCustomer }, null, 2)}

TASK: Add ${need + 1} EMERGING brands: founded 2020 or later, under $10M revenue, real and active (verify each with web search and use its actual homepage URL). Aim for these lanes, which are thinnest: ${thinLanes.join(' and ')}.
- None of the brands already recommended, and no direct competitor of ${brandName}.
- None of these, which are recommended everywhere: ${trodden.join(', ') || 'none'}.
- The strongest fit for THIS customer, not the best-known name you can think of.

Return valid JSON only:
{
  "brands": [
    {
      "name": "Brand Name",
      "url": "https://actualbrandwebsite.com",
      "category": "same-moment|same-aesthetic|same-values|gift-pairing|lifestyle-stack|unexpected-delight",
      "lane": "${thinLanes.join('|')}",
      "brandStage": "emerging",
      "reasons": ["3 short bullets, under 12 words each, concrete, naming real products"],
      "bundleIdea": "One sentence describing a specific product bundle or campaign concept",
      "social": { "tiktok": "handle or null", "instagram": "handle or null", "facebook": "handle or null" }
    }
  ]
}`;

  try {
    const data = await geminiJson(api, 'Emerging top-up', {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: 'You are an expert brand collaboration curator. Use Google Search to verify every brand. Return ONLY valid JSON.' }] },
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.8, topK: 50, topP: 0.97, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } }
    });
    const seen = new Set(brands.flatMap(b => [b.name?.toLowerCase(), brandDomain(b.url || '')]).filter(Boolean));
    const troddenSet = new Set(trodden.map(t => t.toLowerCase()));
    const added = normalizeRecommendations(parseJsonResponse(extractText(data)).brands || [])
      .map(b => ({ ...b, brandStage: 'emerging' }))
      .map(ensureHttps)
      .filter(b => b.name && !seen.has(b.name.toLowerCase()) && !seen.has(brandDomain(b.url || '')) && !troddenSet.has(b.name.toLowerCase()))
      .slice(0, Math.max(need, 0) + 1);
    // A full list makes room by letting go of its last established picks, never an emerging one.
    const overflow = brands.length + added.length - RECOMMENDATIONS_MAX;
    const kept = overflow > 0 ? withoutLastEstablished(brands, overflow) : brands;
    console.log(`[Discovery] Emerging top-up: had ${have}, added ${added.length}, list ${kept.length + added.length}`);
    return [...kept, ...added];
  } catch (err) {
    console.warn(`[Discovery] Emerging top-up skipped: ${err.message}`);
    return brands;
  }
}

// ============================================
// PHASE 2c: The unexpected lane, on its own
// ============================================

/** How many unexpected pairings a list carries; the main call's own picks fill in below this. */
export const UNEXPECTED_COUNT = 3;

// Hosts a search for a brand name lands on that are never the brand's own site.
const NOT_THE_BRAND = new Set(['amazon', 'instagram', 'facebook', 'tiktok', 'youtube', 'wikipedia', 'reddit', 'linkedin', 'pinterest', 'twitter', 'x', 'walmart', 'target', 'etsy', 'ebay', 'google', 'apple', 'crunchbase', 'bloomberg', 'yelp', 'trustpilot', 'threads', 'shopify']);
const secondLevel = host => host.split('.').slice(-2, -1)[0] || host;
const IDEAS = 12;
const IDEATION_MODEL = 'gemini-2.5-pro';

/**
 * The brand's own homepage, from a web search for its name: the result whose domain carries the
 * name, else the first that is not a marketplace or a social network. Null when nothing does.
 */
export async function resolveHomepage(api, name) {
  try {
    const response = await api.serp(new URLSearchParams({ q: `${name} official site`, engine: 'google' }).toString());
    if (!response.ok) return null;
    const data = await response.json();
    const hosts = (data.organic_results || []).map(r => brandDomain(r.link || '')).filter(h => h && !NOT_THE_BRAND.has(secondLevel(h)));
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const host = hosts.find(h => key && secondLevel(h).replace(/[^a-z0-9]/g, '').includes(key.slice(0, Math.max(4, key.length)))) || hosts[0] || null;
    return host ? `https://${host}` : null;
  } catch {
    return null;
  }
}

/**
 * The unexpected lane in three cheap steps, none of them a grounded call. Grounded search pulls
 * the model toward what is already written about a brand, and "verify every brand" is the enemy
 * of a leap: one grounded call at a high temperature still answered Olipop and Therabody for a
 * protein bar. So: an ungrounded ideation call at a high temperature, starting from what happens
 * after, before and around the product and working back to the brand that owns that moment;
 * Jev picking the most surprising ideas that still hold a bundle; a web search for each pick's
 * real homepage. A brand with no findable site is dropped.
 */
export async function unexpectedCollabs(api, { brandProfile, brandName, domain, frequentBrands = [], listed = [] }) {
  const trodden = (frequentBrands || []).map(b => b.name || b.domain).filter(Boolean);
  const onScreen = (listed || []).map(b => b.name).filter(Boolean);
  const prompt = `You are the creative director of a brand collaboration studio, famous for one thing: pairings nobody saw coming that everyone immediately gets.

=== THE BRAND ===
${JSON.stringify({ name: brandProfile.name, url: brandProfile.url, tagline: brandProfile.tagline, productAnalysis: brandProfile.productAnalysis, brandDNA: brandProfile.brandDNA, targetCustomer: brandProfile.targetCustomer }, null, 2)}

=== THE PATTERN ===
Every iconic collaboration has the same two parts: TENSION, the two brands seem to belong to different worlds, and a SHARED TRUTH, one thing that is true of both and that the pairing makes everyone see at once. Sensible pairings have the truth without the tension; gimmicks have the tension without the truth. You want both.
- Fly By Jing (Sichuan chili crisp) released a holiday advent calendar. The pairing: Who Gives A Crap, the toilet paper brand, a holiday bundle about what 24 days of very spicy food does to you. Dude Wipes would have landed the same way. Tension: condiment and bathroom. Truth: the aftermath.
- Crocs and KFC: a clog with a fried-chicken charm. Tension: footwear and fast food. Truth: both are proudly unglamorous comfort.
- Liquid Death and e.l.f.: a corpse-paint makeup kit. Tension: canned water and cosmetics. Truth: the same irreverent fan.
- Heinz and Absolut: a vodka pasta sauce. Tension: ketchup and vodka. Truth: a recipe the internet had already made famous.
- Bombas and a dating app would be a gimmick; Bombas and a marathon's finish line is the same pattern done right: the truth is the moment.
Some of the best are not funny at all: two rituals, two moments, or two feelings that belong together and nobody had put side by side. Funny is allowed; forced is not.

=== HOW TO FIND ONE ===
Start from the product, never from a category. Work each angle and keep only what clicks:
1. The aftermath: what happens to the person after using ${brandName}'s product, and who owns that moment.
2. The lead-up: what has to happen right before, or what makes the product possible, and who owns that.
3. The ritual: the exact time and place the product lives in, and the unlikely object sitting right there.
4. The same feeling in a category this customer never connects with it.
5. A name, a shape, a color, a number or a pun only these two brands can share.
6. A season or a cultural moment where the two belong on the same shelf for six weeks.
7. The opposite: the brand whose product is the exact counterweight to this one, so the pair is a whole.

RULES: real brands that sell their own products (you know them; do not invent any). Not a direct competitor of ${brandName}. Not one of these, recommended everywhere: ${trodden.join(', ') || 'none'}.${onScreen.length ? ` Not one already on the reader's list: ${onScreen.join(', ')}.` : ''} Not the safe adjacent category everyone would suggest, and not the obvious wellness or gear pairing. Name the exact product on each side and say the tension and the truth in the hook. If it is funny it must also be a bundle the buyer wants.

Return valid JSON only, ${IDEAS} ideas, strongest first:
{
  "ideas": [
    {
      "brand": "Brand Name",
      "hook": "The one line that makes the pairing click, under 15 words",
      "their_product": "the specific product of theirs",
      "our_product": "the specific ${brandName} product",
      "why_yes": "One sentence on why a buyer says yes",
      "bundle_name": "A name for the bundle or campaign",
      "brandStage": "emerging|growing|established"
    }
  ]
}`;

  try {
    const data = await geminiJson(api, 'Unexpected collabs', {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: 'You are a brand collaboration creative director. Think first, then return ONLY valid JSON.' }] },
      generationConfig: { temperature: 1.2, topK: 64, topP: 0.98, maxOutputTokens: 8192 }
    }, { model: IDEATION_MODEL });
    const seen = new Set([...trodden, ...onScreen].map(n => n.toLowerCase()));
    const ideas = (parseJsonResponse(extractText(data)).ideas || [])
      .filter(idea => idea?.brand && !seen.has(String(idea.brand).toLowerCase()))
      .map(idea => ({
        name: String(idea.brand).trim(),
        hook: idea.hook || null,
        reasons: [idea.hook, `${idea.their_product || 'their product'} with ${idea.our_product || `${brandName}'s`}`, idea.why_yes].filter(Boolean).map(String),
        bundleIdea: [idea.bundle_name, idea.why_yes].filter(Boolean).join(': '),
        brandStage: ['emerging', 'growing', 'established'].includes(idea.brandStage) ? idea.brandStage : 'growing',
        category: 'unexpected-delight',
        lane: 'unexpected',
        social: {}
      }));

    // Jev: the most surprising ideas that are real brands, not competitors, and still a bundle.
    const grades = await gradeCandidates(api, brandProfile, ideas);
    const ranked = ideas
      .map((idea, i) => ({ idea, grade: grades[i] }))
      .filter(({ grade }) => !grade || (grade.brand >= GRADE_THRESHOLDS.brand && grade.competitor <= GRADE_THRESHOLDS.competitor && grade.fit >= 1.3))
      .sort((a, b) => (b.grade?.surprise ?? 0) - (a.grade?.surprise ?? 0))
      .slice(0, UNEXPECTED_COUNT + 2);

    const picks = [];
    for (const { idea, grade } of ranked) {
      if (picks.length >= UNEXPECTED_COUNT) break;
      const url = await resolveHomepage(api, idea.name);
      if (!url) continue;
      picks.push({ ...idea, url, brandStage: grade?.stage || idea.brandStage });
    }
    console.log(`[Discovery] Unexpected collabs: ${picks.map(b => `${b.name} (${b.hook || 'no hook'})`).join('; ') || 'none'} from ${ideas.length} ideas`);
    return picks;
  } catch (err) {
    console.warn(`[Discovery] Unexpected collabs skipped: ${err.message}`);
    return [];
  }
}

/**
 * The hotter call's pairings take the unexpected lane. The main call's own unexpected picks stay
 * only to fill the lane when the hotter call brought fewer than it holds; the list stays at
 * most 15 by letting go of its last established picks in the other lanes.
 */
export function mergeUnexpected(brands, picks) {
  if (!picks.length) return brands;
  const listed = new Set(brands.flatMap(b => [b.name?.toLowerCase(), brandDomain(b.url || '')]).filter(Boolean));
  picks = picks.filter(b => !listed.has(b.name?.toLowerCase()) && !listed.has(brandDomain(b.url || '')));
  if (!picks.length) return brands;
  const others = brands.filter(b => b.lane !== 'unexpected');
  const own = brands.filter(b => b.lane === 'unexpected').slice(0, Math.max(0, UNEXPECTED_COUNT - picks.length));
  const lane = [...picks, ...own];
  const overflow = others.length + lane.length - RECOMMENDATIONS_MAX;
  const kept = overflow > 0 ? withoutLastEstablished(others, overflow) : others;
  return [...kept, ...lane];
}

// ============================================
// PHASE 2d: Jev grades every candidate; code composes the list
// ============================================

/** A candidate below any of these is out. Lanes come from Jev when it is at least this sure. */
export const GRADE_THRESHOLDS = { brand: 0.5, competitor: 0.5, fit: 1.2, surprise: 2.2 };
const LANE_MIN = 2;

/**
 * Jev's answers for every candidate, in parallel (half a second for a list). A candidate Jev
 * could not grade gets null and is kept as the model labelled it; with no proxy at all (no key,
 * a dev server without one) nothing is graded and the list stands as it was.
 */
export async function gradeCandidates(api, searchedBrand, brands) {
  if (typeof api.jev !== 'function' || !brands.length) return brands.map(b => b.grade || null);
  return Promise.all(brands.map(async brand => {
    if (brand.grade) return brand.grade;
    try {
      const response = await api.jev({ state: gradeState(searchedBrand, brand), questions: GRADE_QUESTIONS });
      if (!response.ok) return null;
      return readGrade(await response.json());
    } catch {
      return null;
    }
  }));
}

/**
 * The brands Jev lets through, each carrying its grade: no retailers, services or media, no direct
 * competitor, nothing without a believable bundle. Ungraded brands are kept as they were.
 */
export function gateGraded(brands, grades, thresholds = GRADE_THRESHOLDS) {
  return brands.map((brand, i) => ({ brand, grade: grades[i] })).filter(({ brand, grade }) => {
    if (!grade) return true;
    if (grade.brand < thresholds.brand) { console.log(`[Discovery] Dropped ${brand.name}: ${grade.kind || 'not a brand'}`); return false; }
    if (grade.competitor > thresholds.competitor) { console.log(`[Discovery] Dropped ${brand.name}: competitor (${grade.competitor})`); return false; }
    if (grade.fit < thresholds.fit) { console.log(`[Discovery] Dropped ${brand.name}: no believable bundle (${grade.fit})`); return false; }
    return true;
  }).map(({ brand, grade }) => (grade ? { ...brand, grade } : brand));
}

/**
 * The list as the grades say it should be: no retailers, services or media, no direct competitor,
 * nothing without a believable bundle; the unexpected lane held by the most surprising pairings;
 * every lane kept to at least two where the candidates allow; the well-trodden cap kept. The
 * lanes and stages stay the model's own: Jev's lane rubric reads too literally (electrolytes as
 * "a parallel premium category"), and its stages skew to "growing", which had the emerging top-up
 * padding lists with filler. Ungraded brands are kept as they were.
 */
export function composeGraded(brands, grades, frequentBrands = [], thresholds = GRADE_THRESHOLDS) {
  if (!grades.some(Boolean)) return brands;
  const kept = gateGraded(brands, grades, thresholds);

  // The unexpected lane: the ideated pairings (they carry a hook), then the most surprising of
  // the rest that still hold a bundle, whatever their relation. Never filled by fit.
  const pinned = kept.filter(b => b.hook);
  const bySurprise = kept.filter(b => !b.hook && b.grade && b.grade.surprise >= thresholds.surprise).sort((a, b) => b.grade.surprise - a.grade.surprise);
  const unexpectedNames = new Set([...pinned, ...bySurprise].slice(0, UNEXPECTED_COUNT).map(b => b.name));
  // A pick the model itself called unexpected that did not make the lane keeps its angle and
  // joins the relation lane its angle maps to.
  const composed = kept.map(b => (unexpectedNames.has(b.name)
    ? { ...b, lane: 'unexpected', category: 'unexpected-delight' }
    : (b.lane === 'unexpected' ? { ...b, lane: ANGLE_LANE[b.category] === 'unexpected' ? 'parallel-premium' : (ANGLE_LANE[b.category] || 'parallel-premium') } : b)));

  // Coverage of the relation lanes: a lane below two takes the best fit from an over-full one.
  const counts = () => Object.fromEntries([...LANES].map(l => [l, composed.filter(b => b.lane === l).length]));
  for (const lane of LANES) {
    if (lane === 'unexpected') continue;
    while (counts()[lane] < LANE_MIN) {
      const donor = composed
        .filter(b => b.lane !== lane && b.lane !== 'unexpected' && counts()[b.lane] > LANE_MIN && b.grade)
        .sort((a, b) => b.grade.fit - a.grade.fit)[0];
      if (!donor) break;
      donor.lane = lane;
    }
  }
  return capWellTrodden(composed.slice(0, RECOMMENDATIONS_MAX), frequentBrands);
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
export async function fetchBrandTopProducts(api, brand) {
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

  // Handle markdown code blocks: a closed fence anywhere, else an opening fence with no close,
  // which is what a reply cut off mid-object looks like and what jsonrepair salvages below.
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1];
  } else {
    jsonStr = text.replace(/^\s*```(?:json)?\s*/, '');
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
