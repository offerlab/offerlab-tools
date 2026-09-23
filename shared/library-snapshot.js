/**
 * What a Showcase bundle is, read from a store's public product listing: the rules and the record
 * shape, shared by the committed snapshot build (scripts/build-library.mjs) and the live read
 * that adds bundles published since (shared/library.js). Runtime-neutral.
 */

// A closed list, so the filter is a list of chips and not whatever the model felt like writing.
export const CATEGORIES = [
  'food-and-drink', 'coffee-and-tea', 'alcohol', 'snacks', 'supplements-and-wellness', 'beauty-and-skincare',
  'personal-care', 'home-and-kitchen', 'pets', 'apparel-and-accessories', 'fitness-and-outdoors', 'baby-and-kids',
  'other'
];

// Bumped when the fields written per bundle change, so every bundle is classified again once.
export const SNAPSHOT_SHAPE = 2;
export const CLASSIFY_BATCH = 20;
export const PAGE_SIZE = 250;
const MAX_PAGES = 20;
const PRODUCT_SHOTS = 6;

const JUNK_HANDLE = /-copy(-\d+)?$|(^|-)qa(-|$)|(^|-)test(-|$)/;
const JUNK_TITLE = /\b(qa|test)\b/i;
const JUNK_VENDORS = new Set(['Villa Test Shop']);

/* -------------------------------------------------------------------------- */
/* Reading the store                                                           */
/* -------------------------------------------------------------------------- */

/** Every product the store lists publicly, which is every product on its Online Store channel. */
export async function fetchStoreProducts(store, { fetchImpl = fetch } = {}) {
  const products = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://${store}/products.json?limit=${PAGE_SIZE}&page=${page}`;
    const response = await fetchImpl(url, { headers: { 'User-Agent': 'offerlab-collab-finder/1.0' } });
    if (!response.ok) throw new Error(`${store} page ${page}: ${response.status}`);
    const batch = (await response.json()).products || [];
    products.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return products;
}

export const isBundle = product =>
  product.product_type === 'OfferLab Bundle' || (product.tags || []).includes('offerlab-bundle');

function isJunk(product) {
  return JUNK_HANDLE.test(product.handle) || JUNK_TITLE.test(product.title) || JUNK_VENDORS.has(product.vendor);
}

// Exclude beats pin beats the junk rule.
export function kept(product, curation = { pin: [], exclude: [] }) {
  if (curation.exclude.includes(product.handle)) return false;
  if (curation.pin.includes(product.handle)) return true;
  return !isJunk(product);
}

/** The store's bundles that belong in the Showcase, as records still to be classified. */
export function showcaseRecords(store, products, curation) {
  return products
    .filter(product => isBundle(product) && product.images?.length && kept(product, curation))
    .map(product => toRecord(store, product));
}

/* -------------------------------------------------------------------------- */
/* The record                                                                  */
/* -------------------------------------------------------------------------- */

const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&lt;': '<', '&gt;': '>' };
export function plainText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, m => ENTITIES[m] || ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cheap and stable: only used to notice that a bundle's copy changed since it was classified.
export function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// A slug, so it is title-cased on the way in or "graza" sits beside "Our Place".
function partnerTags(product) {
  return (product.tags || [])
    .filter(tag => tag.startsWith('ol-partner-'))
    .map(tag => tag.slice('ol-partner-'.length).split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
}

export function toRecord(store, product) {
  const description = plainText(product.body_html);
  const images = (product.images || []).map(image => image.src);
  return {
    id: `${store}/${product.handle}`,
    store,
    handle: product.handle,
    name: product.title,
    pdpUrl: `https://${store}/products/${product.handle}`,
    cover: images[0],
    images: images.slice(1, 1 + PRODUCT_SHOTS),
    anchorBrand: product.vendor,
    partnerTags: partnerTags(product),
    description,
    publishedAt: product.published_at,
    hash: hash(`${SNAPSHOT_SHAPE}\n${product.title}\n${product.vendor}\n${description}`)
  };
}

/* -------------------------------------------------------------------------- */
/* Classifying                                                                 */
/* -------------------------------------------------------------------------- */

export function classifyPrompt(records) {
  return [
    'These are product bundles that bring several brands together. For each, read the name and',
    'description, and return the brands involved, the individual products',
    'named, and one category from this list exactly:',
    CATEGORIES.join(', '),
    '',
    'Brands are the company names the copy itself names (e.g. "Graza", "Our Place"), never product',
    'names, and never a brand the copy does not mention. Products are the individual items named,',
    'short, without the brand prefix.',
    '',
    'Return a JSON array, one object per bundle, in the same order, shaped',
    '{"handle": string, "brands": string[], "products": string[], "category": string}.',
    '',
    JSON.stringify(records.map(r => ({
      handle: r.handle, name: r.name, description: r.description.slice(0, 900)
    })))
  ].join('\n');
}

/** Gemini's answer for a batch of records, as parsed JSON. Two tries: the model is flaky under load. */
export async function classifyBatch(records, { apiKey, model = 'gemini-2.5-flash', fetchImpl = fetch }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: classifyPrompt(records) }] }],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await fetchImpl(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!response.ok) {
      if (attempt === 2) throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 200)}`);
      continue;
    }
    const data = await response.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('');
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  }
}

// First spelling seen wins, which is why callers put the authoritative source first.
export function dedupe(list) {
  const seen = new Map();
  for (const raw of list) {
    const s = (raw || '').trim();
    if (s && !seen.has(s.toLowerCase())) seen.set(s.toLowerCase(), s);
  }
  return [...seen.values()];
}

/* Brands are the ones the bundle's own copy names, which is what a visitor sees on the PDP. The
   vendor and the ol-partner-* tags are OfferLab team names, which on the demo store do not line
   up with the products' brands; they are kept apart as teams, for search only. */
export function applyClassification(record, result) {
  const category = CATEGORIES.includes(result?.category) ? result.category : 'other';
  const brands = dedupe(result?.brands || []);
  return {
    ...record,
    brands: brands.length ? brands : [record.anchorBrand],
    teams: dedupe([record.anchorBrand, ...record.partnerTags]),
    products: dedupe(result?.products || []),
    category
  };
}

/** A classified record carried over: the model's answer kept, the teams re-read from the tags. */
export function carryClassification(record, before) {
  return {
    ...record,
    brands: before.brands,
    teams: dedupe([record.anchorBrand, ...record.partnerTags]),
    products: before.products,
    category: before.category
  };
}

/** The record as the Showcase reads it: the tags were folded into `teams`. */
export function finished(record) {
  const { partnerTags: _tags, ...bundle } = record;
  return bundle;
}
