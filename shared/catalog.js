/**
 * Shopify public catalog reader, shared by the Express dev server and the
 * Cloudflare Pages function. Runtime-neutral: only uses global fetch.
 */

export const CATALOG_LIMIT = 250;
const FETCH_TIMEOUT_MS = 10000;

/** "https://www.Graza.co/pages/x" -> "www.graza.co" */
export function normalizeDomain(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    return url.hostname;
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

// body_html is the merchant's own copy about what a product is for, which is the signal a
// recommender needs; it arrives as markup and is often padded with care instructions.
function plainDescription(html) {
  const text = String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
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

  const prices = variants.map(v => toNumber(v.price)).filter(p => p !== null);
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
    price: prices.length ? Math.min(...prices) : null,
    compareAtPrice: compareAt.length ? Math.max(...compareAt) : null,
    available: variants.some(v => v.available),
    vendor: product.vendor || '',
    productType: product.product_type || '',
    description: plainDescription(product.body_html),
    tags: Array.isArray(product.tags) ? product.tags.map(String) : [],
    variantCount: variants.length
  };
}

/**
 * Resolves a domain's public catalog.
 * status: "shopify" (products found), "none" (no public catalog), "error" (every attempt failed to connect).
 */
export async function fetchShopifyCatalog(input, { fetchImpl = fetch } = {}) {
  const domain = normalizeDomain(input);
  if (!domain) return { status: 'none', domain: '', storeUrl: null, count: 0, products: [] };

  let sawError = false;
  for (const host of hostCandidates(domain)) {
    let result;
    try {
      result = await fetchJson(`https://${host}/products.json?limit=${CATALOG_LIMIT}`, fetchImpl);
    } catch {
      sawError = true;
      continue;
    }
    if (!result.ok || !Array.isArray(result.data?.products)) continue;

    const storeUrl = new URL(result.url).origin;
    const products = result.data.products.map(p => normalizeProduct(p, storeUrl)).filter(Boolean);
    return { status: 'shopify', domain: new URL(storeUrl).hostname, storeUrl, count: products.length, products };
  }

  return { status: sawError ? 'error' : 'none', domain, storeUrl: null, count: 0, products: [] };
}
