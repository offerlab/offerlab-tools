/**
 * Public storefront catalog reader (Shopify's products.json, WooCommerce's Store API), shared by
 * the Express dev server and the Cloudflare Pages function. Runtime-neutral: only uses global fetch.
 */

export const CATALOG_LIMIT = 250;
const FETCH_TIMEOUT_MS = 10000;
// The Store API serves at most 100 products a page.
const WOO_PAGE_SIZE = 100;

/** A catalog read from the brand's own storefront, as opposed to one assembled from Google Shopping. */
export function isStorefrontCatalog(catalog) {
  return catalog?.status === 'shopify' || catalog?.status === 'woocommerce';
}

// A hostname as a store key: letters, digits, dots, hyphens (and the odd underscore). The URL
// parser lets through characters no real domain has, a double quote among them, and a stored
// domain is written into the page.
const HOSTNAME = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;

/** "https://www.Graza.co/pages/x" -> "www.graza.co"; "" when it is not a domain. */
export function normalizeDomain(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    return HOSTNAME.test(url.hostname) ? url.hostname : '';
  } catch {
    return '';
  }
}

// The domain as given, its www. twin, and, for a subdomain like us.brand.com, the apex too.
export function hostCandidates(domain) {
  const bare = domain.replace(/^www\./, '');
  const candidates = [bare, `www.${bare}`];
  const parts = bare.split('.');
  if (parts.length > 2) {
    const apex = parts.slice(-2).join('.');
    candidates.push(apex, `www.${apex}`);
  }
  return domain.startsWith('www.') ? [domain, ...candidates.filter(c => c !== domain)] : candidates;
}

async function fetchJson(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; OfferLabCollabFinder/1.0)' }
    });
    if (!response.ok) return { ok: false, status: response.status };
    const text = await response.text();
    try {
      return { ok: true, url: response.url, data: JSON.parse(text) };
    } catch {
      return { ok: false, status: response.status, notJson: true };
    }
  } finally {
    clearTimeout(timer);
  }
}

function toNumber(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

const DESCRIPTION_LIMIT = 200;

const NAMED_ENTITIES = { nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

// WordPress escapes names too, so a title can arrive as "Alfajor &#8211; Box x 4".
function decodeEntities(text) {
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code[0] !== '#') return NAMED_ENTITIES[code.toLowerCase()] ?? entity;
    const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

// body_html is the merchant's own copy about what a product is for, which is the signal a
// recommender needs; it arrives as markup and is often padded with care instructions.
function plainDescription(html) {
  const text = decodeEntities(String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= DESCRIPTION_LIMIT) return text;
  const cut = text.slice(0, DESCRIPTION_LIMIT);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trim()}...`;
}

function normalizeProduct(product, storeUrl) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  if (variants.length === 0) return null;

  // A $0 price is a placeholder, not a free product: OfferLab refuses to take one live, so a
  // bundle built with it fails. Only a real price counts, and a product with none is left out.
  const prices = variants.map(v => toNumber(v.price)).filter(p => p !== null && p > 0);
  if (prices.length === 0) return null;
  const compareAt = variants.map(v => toNumber(v.compare_at_price)).filter(p => p !== null);
  const image = product.images?.[0]?.src || variants.find(v => v.featured_image?.src)?.featured_image?.src || null;
  // A live storefront photographs what it sells. An entry with no image at all is almost always a
  // wholesale or bulk listing the merchant is not really merchandising, so the catalog never
  // carries one and no read site has to filter for it.
  if (!image) return null;

  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    url: `${storeUrl}/products/${product.handle}`,
    image,
    price: Math.min(...prices),
    compareAtPrice: compareAt.length ? Math.max(...compareAt) : null,
    available: variants.some(v => v.available),
    vendor: product.vendor || '',
    productType: product.product_type || '',
    description: plainDescription(product.body_html),
    tags: Array.isArray(product.tags) ? product.tags.map(String) : [],
    variantCount: variants.length
  };
}

// Store API prices are strings in the currency's minor unit: "3199" with a minor unit of 2 is 31.99.
function wooAmount(value, minorUnit) {
  const n = toNumber(value);
  return n === null ? null : n / 10 ** minorUnit;
}

function normalizeWooProduct(product) {
  // Woo's own word that the product cannot be bought here: an external (affiliate) listing, or one
  // without a price.
  if (!product?.is_purchasable) return null;
  const prices = product.prices || {};
  const minorUnit = Number.isInteger(prices.currency_minor_unit) ? prices.currency_minor_unit : 2;
  // A variable product's price is its cheapest variation's, which the range states outright.
  const price = wooAmount(prices.price_range?.min_amount ?? prices.price, minorUnit);
  if (price === null || price <= 0) return null;
  const image = product.images?.[0]?.src || null;
  if (!image) return null;
  const regular = product.on_sale ? wooAmount(prices.regular_price, minorUnit) : null;
  const variations = Array.isArray(product.variations) ? product.variations : [];

  return {
    id: product.id,
    handle: product.slug,
    title: decodeEntities(product.name),
    url: product.permalink,
    image,
    price,
    compareAtPrice: regular !== null && regular > price ? regular : null,
    available: Boolean(product.is_in_stock),
    vendor: decodeEntities(product.brands?.[0]?.name),
    productType: decodeEntities(product.categories?.[0]?.name),
    description: plainDescription(product.description || product.short_description),
    tags: Array.isArray(product.tags) ? product.tags.map(tag => decodeEntities(tag?.name)).filter(Boolean) : [],
    variantCount: variations.length || 1
  };
}

/**
 * A host's Store API products, page by page up to CATALOG_LIMIT, or null when the host has none.
 * A failure past the first page keeps what came before it.
 */
async function fetchWooProducts(host, fetchImpl) {
  let origin = null;
  const products = [];
  for (let page = 1; products.length < CATALOG_LIMIT; page++) {
    const url = `https://${host}/wp-json/wc/store/v1/products?per_page=${WOO_PAGE_SIZE}&page=${page}`;
    let result;
    try {
      result = await fetchJson(url, fetchImpl);
    } catch (err) {
      if (page === 1) throw err;
      break;
    }
    // Another WordPress route, or a plugin's, can answer an array too; a Store API product has prices.
    const isProducts = result.ok && Array.isArray(result.data) && result.data.every(p => p?.prices);
    if (!isProducts) {
      if (page === 1) return null;
      break;
    }
    origin ??= new URL(result.url).origin;
    products.push(...result.data);
    if (result.data.length < WOO_PAGE_SIZE) break;
  }
  return { origin, products: products.slice(0, CATALOG_LIMIT) };
}

/**
 * Resolves a domain's public catalog: Shopify's products.json on any host, then WooCommerce's Store
 * API on the hosts that answered.
 * status: "shopify" or "woocommerce" (catalog found), "none" (no public catalog), "error" (every
 * attempt failed to connect).
 */
export async function fetchStorefrontCatalog(input, { fetchImpl = fetch } = {}) {
  const domain = normalizeDomain(input);
  if (!domain) return { status: 'none', domain: '', storeUrl: null, count: 0, products: [] };

  let sawError = false;
  const reached = [];
  for (const host of hostCandidates(domain)) {
    let result;
    try {
      result = await fetchJson(`https://${host}/products.json?limit=${CATALOG_LIMIT}`, fetchImpl);
    } catch {
      sawError = true;
      continue;
    }
    reached.push(host);
    if (!result.ok || !Array.isArray(result.data?.products)) continue;

    const storeUrl = new URL(result.url).origin;
    const products = result.data.products.map(p => normalizeProduct(p, storeUrl)).filter(Boolean);
    return { status: 'shopify', domain: new URL(storeUrl).hostname, storeUrl, count: products.length, products };
  }

  for (const host of reached) {
    let woo;
    try {
      woo = await fetchWooProducts(host, fetchImpl);
    } catch {
      continue;
    }
    if (!woo) continue;

    const products = woo.products.map(normalizeWooProduct).filter(Boolean);
    return { status: 'woocommerce', domain: new URL(woo.origin).hostname, storeUrl: woo.origin, count: products.length, products };
  }

  return { status: sawError ? 'error' : 'none', domain, storeUrl: null, count: 0, products: [] };
}
