/**
 * Stand-in products for a brand with no public catalog, so the brand that was searched can still
 * try a bundle of its own (a headless storefront like Balsam Hill has no products.json to read).
 *
 * The pictures come from the brand's own homepage where it lets a server read it, and from
 * Google Shopping; Gemini names and prices a handful of products from them and from the brand
 * analysis. None of it is a real catalog: in the picker the operator renames, reprices, swaps
 * the picture or adds their own, by hand or from a product link. Runtime-neutral, so the
 * search (browser or crawl) and the picker share it.
 */
import { mainProduct, toPrice } from './page.js';
import { geminiJson, parseJsonResponse, fetchBrandTopProducts } from './search.js';

export const STAND_IN_MODEL = 'gemini-2.5-flash';
export const STAND_IN_COUNT = 6;
// With this many pictured suggestions, the ones without a picture are left out: a tile with no
// picture is a poor stand-in, and only worth showing when pictures are scarce.
export const STAND_IN_PICTURED_MIN = 3;
const PICTURE_LIMIT = 16;

/** A brand the picker cannot build from as it is, and that staff have not hidden, gets stand-ins. */
export function needsStandIns(brand) {
  return Boolean(brand?.url) && !brand.catalog?.hidden && !(brand.catalog?.products?.length);
}

/**
 * `{ images: [{ src, alt }], products: [{ id, title, image, price, available, standIn }] }` for
 * one brand, or null when nothing at all could be found or suggested. `shopping: false` skips
 * Google Shopping, which is a paid search.
 */
export async function gatherStandIns(api, brand, { shopping = true } = {}) {
  const [page, shopped] = await Promise.all([
    readPage(api, brand.url),
    shopping ? fetchBrandTopProducts(api, brand).catch(() => []) : []
  ]);
  const pictures = picturesFrom(page, Array.isArray(shopped) ? shopped : []);

  let suggested = [];
  try {
    suggested = await suggestProducts(api, brand, pictures);
  } catch (err) {
    console.warn(`[Stand-ins] ${brand.name}: ${err.message}`);
  }
  // Without Gemini, the pictures that came with a name and a price are products already, and
  // failing those, the brand analysis named its hero products and what they typically cost.
  if (!suggested.length) {
    suggested = pictures.filter(p => p.name && p.price).map(p => ({ name: p.name, price: p.price, image: p.src }));
  }
  if (!suggested.length) suggested = heroProducts(brand);

  const pictured = suggested.filter(p => p.image);
  const shown = pictured.length >= STAND_IN_PICTURED_MIN ? pictured : [...pictured, ...suggested.filter(p => !p.image)];
  const products = shown.slice(0, STAND_IN_COUNT).map((p, i) => standIn({ ...p, id: `suggested-${i + 1}` }));
  const images = pictures.map(p => ({ src: p.src, alt: p.name || p.alt || '' }));
  if (!products.length && !images.length) return null;
  console.log(`[Stand-ins] ${brand.name}: ${images.length} pictures (site ${page?.status || 'unread'}), ${products.length} products`);
  return { images, products };
}

/** One stand-in as the picker holds it: shaped like a catalog product, and marked as not one. */
export function standIn({ id, name, title, price, image, url = null }) {
  return {
    id,
    title: String(title || name || '').trim(),
    image: image || null,
    price: toPrice(price),
    url,
    available: true,
    standIn: true
  };
}

/**
 * A product from its page: name, picture, price and address. When the site will not serve the
 * page, the name is read off the address itself and `blocked` says the rest is the operator's.
 */
export async function productFromLink(api, link) {
  const page = await readPage(api, link);
  const found = page?.status === 'ok' ? mainProduct(page) : null;
  if (found) return { ...found, price: toPrice(found.price), blocked: false };
  return { name: nameFromAddress(link), image: null, price: null, url: page?.url || link, blocked: true };
}

/** "…/p/classic-blue-spruce-tree-12345" -> "Classic Blue Spruce Tree". */
export function nameFromAddress(link) {
  let path;
  try {
    path = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`).pathname;
  } catch {
    return '';
  }
  // The last part of the path that still says something once ids and SKUs are dropped from it.
  const words = segment => {
    const list = safeDecode(segment)
      .replace(/\.(html?|php|aspx?)$/i, '')
      .split(/[-_+\s]+/)
      .filter(word => /[a-z]/i.test(word) && !/\d/.test(word));
    // Capitals in a lowercase slug are a product code, not a word.
    return list.some(word => /[a-z]/.test(word)) ? list.filter(word => !/^[A-Z]{3,}$/.test(word)) : list;
  };
  const named = path.split('/').filter(Boolean).reverse()
    .map(words)
    .find(list => list.length && !(list.length === 1 && /^(p|products?|shop|item|dp)$/i.test(list[0])));
  return named ? named.join(' ').replace(/\b\w/g, c => c.toUpperCase()) : '';
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The analysis's hero products at its typical price: "$150-$800" reads as the middle, $475. */
export function heroProducts(brand) {
  const analysis = brand?.productAnalysis || {};
  const names = (Array.isArray(analysis.heroProducts) ? analysis.heroProducts : [])
    .filter(name => typeof name === 'string' && name.trim());
  const bounds = String(analysis.priceRange?.typicalPrice || '').replace(/,(?=\d{3}\b)/g, '').match(/\d+(?:\.\d+)?/g) || [];
  const numbers = bounds.map(Number).filter(n => n > 0);
  const price = numbers.length ? Math.round(numbers.reduce((sum, n) => sum + n, 0) / numbers.length) : null;
  if (!price) return [];
  return names.map(name => ({ name: name.trim(), price, image: null }));
}

async function readPage(api, url) {
  if (!url) return null;
  try {
    const response = await api.page(url);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

// The site's own products first (they come named and often priced), then Google Shopping's, then
// the site's other pictures, its cover last: it is more often a banner than a product.
function picturesFrom(page, shopped) {
  const ok = page?.status === 'ok';
  const pictures = [
    ...(ok ? page.products : []).filter(p => p.image).map(p => ({ src: p.image, name: p.name, price: p.price, from: 'site' })),
    ...shopped.filter(p => p.imageUrl).map(p => ({ src: p.imageUrl, name: p.productName, price: toPrice(p.price), from: 'google' })),
    ...(ok ? page.images : []).map(i => ({ src: i.src, alt: i.alt, from: 'site' })),
    ...(ok && page.image ? [{ src: page.image, alt: page.title || '', from: 'site' }] : [])
  ];
  const seen = new Set();
  return pictures.filter(p => {
    if (seen.has(p.src)) return false;
    seen.add(p.src);
    return true;
  }).slice(0, PICTURE_LIMIT);
}

async function suggestProducts(api, brand, pictures) {
  const listed = pictures.map((p, i) => {
    const said = [p.name || p.alt || 'no caption', p.price ? `$${p.price}` : null, p.from === 'google' ? 'Google Shopping' : 'their site'];
    return `${i + 1} | ${said.filter(Boolean).join(' | ')}`;
  }).join('\n');

  const prompt = `We are showing ${brand.name} what a product bundle with another brand could look like. Their store has no public catalog we can read, so we need a few stand-in products that feel like theirs.

=== THE BRAND ===
${JSON.stringify({ name: brand.name, url: brand.url, description: brand.description, productAnalysis: brand.productAnalysis || undefined }, null, 2)}

=== PICTURES FOUND FOR THIS BRAND (number | caption | price | where) ===
${listed || 'none'}

TASK: Suggest ${STAND_IN_COUNT} products ${brand.name} actually sells, the kind a customer would buy in a bundle.
- Name each the way the brand would title it on its own product page, without the brand's name in front.
- Price each in US dollars at what ${brand.name} charges for it. A picture's own price stands when it has one.
- Give each the number of the picture that shows it, or null when none does. Use a picture once at most, and only when its caption shows it is that product.
- Prefer products a picture shows, then the brand's best-known products.

Return valid JSON only:
{ "products": [ { "name": "Product name", "price": 99, "picture": 1 } ] }`;

  const { parsed } = await geminiJson(api, 'Stand-in products', {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: 'You are a merchandiser who knows this brand\'s range. Return ONLY valid JSON.' }] },
    generationConfig: { temperature: 0.4, maxOutputTokens: 2048, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } }
  }, {
    model: STAND_IN_MODEL,
    parse: text => {
      const products = parseJsonResponse(text)?.products;
      if (!Array.isArray(products)) throw new Error('No products in the answer');
      return products;
    }
  });

  const used = new Set();
  return parsed
    .filter(p => p && typeof p.name === 'string' && p.name.trim() && toPrice(p.price))
    .map(p => {
      const index = Number(p.picture) - 1;
      const picture = Number.isInteger(index) && pictures[index] && !used.has(index) ? pictures[index] : null;
      if (picture) used.add(index);
      return { name: p.name.trim(), price: toPrice(p.price), image: picture?.src || null };
    });
}

