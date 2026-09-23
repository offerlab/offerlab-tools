// Builds library/snapshot.json: every published bundle on the demo stores, read from their public
// catalogs and classified once. The library reads that file and nothing else, so a guest at a
// booth needs no OfferLab account and the deployed finder holds no key (OL-4032).
//   npm run build:library
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { config } from 'dotenv';

config();

const root = new URL('..', import.meta.url).pathname;
const STORES = JSON.parse(readFileSync(join(root, 'static/library/stores.json'), 'utf8'));
const CURATION = JSON.parse(readFileSync(join(root, 'static/library/curation.json'), 'utf8'));
const OUT = join(root, 'static/library/snapshot.json');

const MODEL = 'gemini-2.5-flash';
// Bumped when the fields written per bundle change, so every bundle is classified again once.
const SNAPSHOT_SHAPE = 2;
const CLASSIFY_BATCH = 20;
const PAGE_SIZE = 250;
const PRODUCT_SHOTS = 6;

// A closed list, so the filter is a list of chips and not whatever the model felt like writing.
export const CATEGORIES = [
  'food-and-drink', 'coffee-and-tea', 'alcohol', 'snacks', 'supplements-and-wellness', 'beauty-and-skincare',
  'personal-care', 'home-and-kitchen', 'pets', 'apparel-and-accessories', 'fitness-and-outdoors', 'baby-and-kids',
  'other'
];

const JUNK_HANDLE = /-copy(-\d+)?$|(^|-)qa(-|$)|(^|-)test(-|$)/;
const JUNK_TITLE = /\b(qa|test)\b/i;
const JUNK_VENDORS = new Set(['Villa Test Shop']);

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY is not set. Refusing to write an unclassified snapshot.');
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Reading the stores                                                          */
/* -------------------------------------------------------------------------- */

async function fetchCatalog(store) {
  const products = [];
  for (let page = 1; page <= 20; page++) {
    const url = `https://${store}/products.json?limit=${PAGE_SIZE}&page=${page}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'offerlab-collab-finder/1.0' } });
    if (!response.ok) throw new Error(`${store} page ${page}: ${response.status}`);
    const batch = (await response.json()).products || [];
    products.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return products;
}

const isBundle = product =>
  product.product_type === 'OfferLab Bundle' || (product.tags || []).includes('offerlab-bundle');

function isJunk(product) {
  return JUNK_HANDLE.test(product.handle) || JUNK_TITLE.test(product.title) || JUNK_VENDORS.has(product.vendor);
}

// Exclude beats pin beats the junk rule.
function kept(product) {
  if (CURATION.exclude.includes(product.handle)) return false;
  if (CURATION.pin.includes(product.handle)) return true;
  return !isJunk(product);
}

const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&lt;': '<', '&gt;': '>' };
function plainText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, m => ENTITIES[m] || ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cheap and stable: only used to notice that a bundle's copy changed since it was classified.
function hash(text) {
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

function toRecord(store, product) {
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

async function classifyBatch(records) {
  const prompt = [
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

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await fetch(endpoint, {
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
function dedupe(list) {
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
function applyClassification(record, result) {
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

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { bundles: [] };
const known = new Map(previous.bundles.map(bundle => [bundle.id, bundle]));

const report = { products: 0, bundles: 0, noCover: 0, junk: 0, kept: 0, reused: 0, classified: 0 };
const records = [];

// One unreachable store fails the run rather than writing a snapshot that quietly lost a store.
for (const store of STORES) {
  const products = await fetchCatalog(store);
  report.products += products.length;
  for (const product of products) {
    if (!isBundle(product)) continue;
    report.bundles++;
    if (!product.images?.length) { report.noCover++; continue; }
    if (!kept(product)) { report.junk++; continue; }
    report.kept++;
    records.push(toRecord(store, product));
  }
}

const pending = [];
const bundles = records.map(record => {
  const before = known.get(record.id);
  // Reuse keeps the model's answer; the teams are re-read from the tags, which are ours.
  if (before && before.hash === record.hash && before.category) {
    report.reused++;
    return {
      ...record,
      brands: before.brands,
      teams: dedupe([record.anchorBrand, ...record.partnerTags]),
      products: before.products,
      category: before.category
    };
  }
  pending.push(record);
  return record;
});

for (let i = 0; i < pending.length; i += CLASSIFY_BATCH) {
  const batch = pending.slice(i, i + CLASSIFY_BATCH);
  const results = await classifyBatch(batch);
  const byHandle = new Map((results || []).map(result => [result.handle, result]));
  for (const record of batch) {
    const index = bundles.findIndex(bundle => bundle.id === record.id);
    bundles[index] = applyClassification(record, byHandle.get(record.handle));
    report.classified++;
  }
  console.log(`classified ${Math.min(i + CLASSIFY_BATCH, pending.length)}/${pending.length}`);
}

bundles.sort((a, b) => a.store.localeCompare(b.store) || a.handle.localeCompare(b.handle));
bundles.forEach(bundle => { delete bundle.partnerTags; });

const snapshot = {
  generatedAt: new Date().toISOString(),
  stores: STORES,
  categories: CATEGORIES,
  bundles
};
writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');

console.log(`library/snapshot.json: ${bundles.length} bundles from ${STORES.length} store(s)`);
console.log(`  products seen ${report.products}, bundles ${report.bundles}, no cover ${report.noCover}, junk ${report.junk}`);
console.log(`  classified ${report.classified}, reused ${report.reused}`);
