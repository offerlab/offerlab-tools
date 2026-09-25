/**
 * Reads one web page for what it says about products: its title, cover and price, any products it
 * describes in JSON-LD, and the pictures on it that look like products. The stand-in products of
 * a brand with no public catalog are made from this (shared/standins.js), and so is a product
 * created from a link. Runtime-neutral: only uses global fetch and regular expressions.
 *
 * Plenty of sites turn a server away (Balsam Hill sits behind Vercel's bot checkpoint), so a page
 * that cannot be read is an answer, `status: 'blocked'`, not an error.
 */

const FETCH_TIMEOUT_MS = 10000;
const MAX_HTML = 1_500_000;
const MAX_IMAGES = 24;
const MIN_IMAGE_SIDE = 120;

// A desktop browser's headers: plenty of storefronts serve a bare page, or nothing, to anything else.
const BROWSER_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
};

// The interstitials bot protection answers with, which arrive as a page like any other.
const CHALLENGE_TITLE = /security checkpoint|hang tight|just a moment|attention required|access denied|verify you are (a )?human|are you a robot|captcha|pardon our interruption/i;

// Pictures that are chrome rather than merchandise.
const NOT_A_PRODUCT = /logo|icon|favicon|sprite|spacer|pixel|badge|payment|flag|avatar|placeholder|loader|arrow|chevron|star-?rating|trustpilot|klarna|afterpay|paypal|\/svg|\.svg(\?|$)|\.gif(\?|$)/i;

/** "shop.brand.com/p/x" -> "https://shop.brand.com/p/x"; null when it is not a public web address. */
export function pageUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  // Only named public hosts: nothing local, and no bare addresses to probe a network with.
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) return null;
  return url.href;
}

/**
 * Fetches and reads one page.
 * status: "ok" (read), "blocked" (the site answered with a refusal or a bot check), "error" (no
 * answer at all), "invalid" (not a public web address).
 */
export async function fetchPage(input, { fetchImpl = fetch } = {}) {
  const url = pageUrl(input);
  if (!url) return { status: 'invalid', url: null };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal, headers: BROWSER_HEADERS });
    const finalUrl = response.url || url;
    if (!response.ok) return { status: 'blocked', url: finalUrl, httpStatus: response.status };
    const type = response.headers?.get?.('content-type') || '';
    if (type && !/html|xml/i.test(type)) return { status: 'blocked', url: finalUrl, httpStatus: response.status };
    const html = (await response.text()).slice(0, MAX_HTML);
    const page = readPage(html, finalUrl);
    if (CHALLENGE_TITLE.test(page.title || '')) return { status: 'blocked', url: finalUrl, httpStatus: response.status };
    return { status: 'ok', url: finalUrl, ...page };
  } catch {
    return { status: 'error', url };
  } finally {
    clearTimeout(timer);
  }
}

/** A page's HTML as `{ title, description, image, price, currency, products, images }`. */
export function readPage(html, baseUrl) {
  const text = String(html || '');
  const meta = readMeta(text);
  const titleTag = decode((text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const products = readJsonLd(text).flatMap(productsIn).map(p => productFrom(p, baseUrl)).filter(Boolean);

  return {
    title: meta['og:title'] || meta['twitter:title'] || titleTag || null,
    description: meta['og:description'] || meta.description || meta['twitter:description'] || null,
    image: absolute(meta['og:image'] || meta['og:image:secure_url'] || meta['twitter:image'], baseUrl),
    price: toPrice(meta['product:price:amount'] || meta['og:price:amount']),
    currency: meta['product:price:currency'] || meta['og:price:currency'] || null,
    products: dedupe(products, p => p.name.toLowerCase()),
    images: readImages(text, baseUrl)
  };
}

/** The product a page is about: its JSON-LD product, else what its meta tags say. */
export function mainProduct(page) {
  const [first] = page?.products || [];
  const name = first?.name || page?.title || null;
  if (!name) return null;
  return {
    name,
    image: first?.image || page.image || page.images?.[0]?.src || null,
    price: first?.price ?? page.price ?? null,
    url: first?.url || page.url || null
  };
}

/* -------------------------------------------------------------------------- */
/* Markup                                                                      */
/* -------------------------------------------------------------------------- */

function attributes(tag) {
  const attrs = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match;
  while ((match = pattern.exec(tag))) attrs[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? '');
  return attrs;
}

function readMeta(html) {
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = attributes(tag);
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content && !(key in meta)) meta[key] = attrs.content.trim();
  }
  return meta;
}

function readImages(html, baseUrl) {
  const images = [];
  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    const attrs = attributes(tag);
    const src = absolute(largestFromSrcset(attrs['data-srcset'] || attrs.srcset) || attrs['data-src'] || attrs['data-original'] || attrs.src, baseUrl);
    if (!src || NOT_A_PRODUCT.test(src) || NOT_A_PRODUCT.test(attrs.class || '')) continue;
    const width = parseInt(attrs.width, 10);
    const height = parseInt(attrs.height, 10);
    if ((width && width < MIN_IMAGE_SIDE) || (height && height < MIN_IMAGE_SIDE)) continue;
    images.push({ src, alt: (attrs.alt || attrs.title || '').trim() });
  }
  return dedupe(images, image => image.src).slice(0, MAX_IMAGES);
}

function largestFromSrcset(srcset) {
  if (!srcset) return null;
  const candidates = srcset.split(/,\s+/).map(part => {
    const [url, size] = part.trim().split(/\s+/);
    return { url, size: parseFloat(size) || 0 };
  }).filter(c => c.url);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.size - a.size)[0].url;
}

/* -------------------------------------------------------------------------- */
/* JSON-LD                                                                     */
/* -------------------------------------------------------------------------- */

function readJsonLd(html) {
  const blocks = [];
  const pattern = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    try {
      blocks.push(JSON.parse(match[1].trim()));
    } catch { /* a malformed block says nothing */ }
  }
  return blocks;
}

function typesOf(node) {
  const type = node?.['@type'];
  return (Array.isArray(type) ? type : [type]).map(t => String(t || '').toLowerCase());
}

// Every Product node, wherever the page nested it: arrays, @graph, item lists, a page's main entity.
function productsIn(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return [];
  if (Array.isArray(node)) return node.flatMap(n => productsIn(n, depth + 1));
  if (typesOf(node).some(t => t === 'product' || t === 'productgroup')) return [node];
  return [node['@graph'], node.itemListElement, node.item, node.mainEntity, node.hasVariant]
    .filter(Boolean)
    .flatMap(n => productsIn(n, depth + 1));
}

function productFrom(node, baseUrl) {
  const name = decode(String(node.name || '')).trim();
  if (!name) return null;
  const offers = [node.offers, node.hasVariant?.map?.(v => v.offers)].flat(2).filter(Boolean);
  const prices = offers
    .flatMap(o => [o.price, o.lowPrice, o.priceSpecification?.price, ...(Array.isArray(o.offers) ? o.offers.map(x => x.price) : [])])
    .map(toPrice)
    .filter(p => p !== null);
  return {
    name,
    image: absolute(imageOf(node.image), baseUrl),
    price: prices.length ? Math.min(...prices) : null,
    url: absolute(typeof node.url === 'string' ? node.url : null, baseUrl)
  };
}

function imageOf(image) {
  if (!image) return null;
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) return imageOf(image[0]);
  return image.url || image.contentUrl || null;
}

/* -------------------------------------------------------------------------- */
/* Values                                                                      */
/* -------------------------------------------------------------------------- */

/** "$1,299.00" -> 1299; null when there is no positive price in it. */
export function toPrice(value) {
  if (typeof value === 'number') return value > 0 ? value : null;
  const match = String(value ?? '').replace(/,(?=\d{3}\b)/g, '').match(/\d+(?:\.\d+)?/);
  const n = match ? parseFloat(match[0]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function absolute(src, baseUrl) {
  if (!src || typeof src !== 'string' || src.startsWith('data:')) return null;
  try {
    const url = new URL(src.trim(), baseUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function decode(text) {
  return String(text)
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

function dedupe(items, keyOf) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
