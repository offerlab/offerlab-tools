import { describe, expect, it, vi } from 'vitest';
import { normalizeDomain, hostCandidates, fetchStorefrontCatalog, isStorefrontCatalog, CATALOG_LIMIT } from '$lib/shared/catalog.js';

describe('normalizeDomain', () => {
  it('lowercases and keeps the host, www included', () => {
    expect(normalizeDomain('https://www.Graza.co/pages/x')).toBe('www.graza.co');
    expect(normalizeDomain(' Graza.co ')).toBe('graza.co');
    expect(normalizeDomain('us.brand.com/shop?x=1')).toBe('us.brand.com');
  });

  it('is empty for nothing or not a host', () => {
    expect(normalizeDomain('')).toBe('');
    expect(normalizeDomain(null)).toBe('');
    expect(normalizeDomain('not a url')).toBe('');
  });

  it('is empty for a host no real domain has, which the URL parser would let through', () => {
    expect(normalizeDomain('x"onload="alert(1)')).toBe('');
    expect(normalizeDomain("https://a'b.com")).toBe('');
    expect(normalizeDomain('[::1]')).toBe('');
    expect(normalizeDomain('xn--caf-dma.com')).toBe('xn--caf-dma.com');
    expect(normalizeDomain('café.com')).toBe('xn--caf-dma.com');
  });
});

describe('hostCandidates', () => {
  it('tries bare then www', () => {
    expect(hostCandidates('graza.co')).toEqual(['graza.co', 'www.graza.co']);
  });

  it('keeps a www domain first', () => {
    expect(hostCandidates('www.graza.co')).toEqual(['www.graza.co', 'graza.co']);
  });

  it('adds the apex for a subdomain', () => {
    expect(hostCandidates('us.brand.com')).toEqual(['us.brand.com', 'www.us.brand.com', 'brand.com', 'www.brand.com']);
  });
});

// A stubbed storefront: products.json per host, and Store API pages per host in `woo`, as
// `fetchJson` reads them (status, url, text()).
function storefront(byHost, woo = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url) => {
    calls.push(url);
    const { hostname: host, pathname, searchParams } = new URL(url);
    const entry = pathname.startsWith('/wp-json/')
      ? (woo[host] === 'throw' ? 'throw' : woo[host]?.[Number(searchParams.get('page')) - 1])
      : byHost[host];
    if (entry === 'throw') throw new Error('ECONNREFUSED');
    if (entry == null) return { ok: false, status: 404, url, text: async () => 'Not found' };
    if (typeof entry === 'string') return { ok: true, status: 200, url, text: async () => entry };
    return { ok: true, status: 200, url, text: async () => JSON.stringify(entry) };
  });
  return { calls, fetchImpl };
}

const PRODUCTS = [
  {
    id: 1, handle: 'sizzle', title: 'Sizzle', vendor: 'Graza', product_type: 'Olive oil',
    body_html: '<p>Cooking oil &amp; more.</p><style>.x{}</style>',
    tags: ['oil', 2],
    images: [{ src: 'https://cdn/sizzle.jpg' }],
    variants: [{ price: '21.00', compare_at_price: '25.00', available: true }, { price: '19.50', compare_at_price: '30.00', available: false }]
  },
  { id: 2, handle: 'free', title: 'Placeholder', images: [{ src: 'https://cdn/free.jpg' }], variants: [{ price: '0.00', available: true }] },
  { id: 3, handle: 'variant-image', title: 'Variant image', images: [], variants: [{ price: '5', featured_image: { src: 'https://cdn/v.jpg' }, available: true }] },
  { id: 4, handle: 'no-variants', title: 'No variants', images: [{ src: 'https://cdn/x.jpg' }], variants: [] },
  { id: 5, handle: 'no-image', title: 'No image', images: [], variants: [{ price: '9', available: true }] },
  { id: 6, handle: 'long', title: 'Long copy', images: [{ src: 'https://cdn/l.jpg' }], variants: [{ price: 'abc' }, { price: '12' }], body_html: 'word '.repeat(80) }
];

describe('fetchStorefrontCatalog', () => {
  it('normalises products.json and drops what cannot be sold', async () => {
    const { calls, fetchImpl } = storefront({ 'graza.co': { products: PRODUCTS } });
    const catalog = await fetchStorefrontCatalog('https://www.Graza.co/pages/x', { fetchImpl });

    expect(calls).toEqual([`https://www.graza.co/products.json?limit=${CATALOG_LIMIT}`, `https://graza.co/products.json?limit=${CATALOG_LIMIT}`]);
    expect(catalog.status).toBe('shopify');
    expect(catalog.domain).toBe('graza.co');
    expect(catalog.storeUrl).toBe('https://graza.co');
    expect(catalog.count).toBe(3);
    expect(catalog.products.map(p => p.handle)).toEqual(['sizzle', 'variant-image', 'long']);

    const [sizzle, variantImage, long] = catalog.products;
    expect(sizzle).toMatchObject({
      id: 1, title: 'Sizzle', url: 'https://graza.co/products/sizzle', image: 'https://cdn/sizzle.jpg',
      price: 19.5, compareAtPrice: 30, available: true, vendor: 'Graza', productType: 'Olive oil',
      description: 'Cooking oil & more.', tags: ['oil', '2'], variantCount: 2
    });
    expect(variantImage.image).toBe('https://cdn/v.jpg');
    expect(long.price).toBe(12);
    expect(long.compareAtPrice).toBeNull();
    expect(long.description.length).toBeLessThanOrEqual(204);
    expect(long.description.endsWith('...')).toBe(true);
  });

  it('is none when no host has a catalog and error when none could be reached', async () => {
    const none = await fetchStorefrontCatalog('nothing.test', { fetchImpl: storefront({}).fetchImpl });
    expect(none).toEqual({ status: 'none', domain: 'nothing.test', storeUrl: null, count: 0, products: [] });

    const notJson = await fetchStorefrontCatalog('html.test', { fetchImpl: storefront({ 'html.test': '<html>', 'www.html.test': '<html>' }).fetchImpl });
    expect(notJson.status).toBe('none');

    const error = await fetchStorefrontCatalog('down.test', { fetchImpl: storefront({ 'down.test': 'throw', 'www.down.test': 'throw' }).fetchImpl });
    expect(error.status).toBe('error');
  });

  it('keeps trying hosts past a failure and takes the origin the store answered from', async () => {
    const { fetchImpl } = storefront({ 'us.brand.com': 'throw', 'brand.com': { products: PRODUCTS.slice(0, 1) } });
    const catalog = await fetchStorefrontCatalog('us.brand.com', { fetchImpl });
    expect(catalog.status).toBe('shopify');
    expect(catalog.domain).toBe('brand.com');
    expect(catalog.products[0].url).toBe('https://brand.com/products/sizzle');
  });

  it('is none for an empty input', async () => {
    const fetchImpl = vi.fn();
    expect(await fetchStorefrontCatalog('', { fetchImpl })).toEqual({ status: 'none', domain: '', storeUrl: null, count: 0, products: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// Store API products as Havanna's store serves them: prices in cents, names HTML-escaped.
function wooProduct(id, overrides = {}) {
  return {
    id, name: `Product ${id}`, slug: `product-${id}`, type: 'simple',
    permalink: `https://havannausa.com/product/product-${id}/`,
    short_description: '<p>Short</p>',
    description: '<p><strong>Description:</strong></p>\n<p>Two types of dulce de leche.</p>',
    on_sale: false,
    prices: { price: '1499', regular_price: '1499', sale_price: '1499', price_range: null, currency_code: 'USD', currency_minor_unit: 2 },
    images: [{ id: 1, src: `https://havannausa.com/wp-content/uploads/${id}.png` }],
    categories: [{ id: 143, name: 'Mini Line' }],
    tags: [], brands: [], variations: [],
    is_purchasable: true, is_in_stock: true,
    ...overrides
  };
}

describe('fetchStorefrontCatalog on WooCommerce', () => {
  it('reads the Store API when no host has products.json, and normalises it', async () => {
    const { calls, fetchImpl } = storefront({ 'havannausa.com': '<html>' }, {
      'havannausa.com': [[
        wooProduct(7297, { name: 'Alfajor Mar del Plata &#8211; Box x 4 Alfajores', tags: [{ name: 'Gift &amp; Share' }], brands: [{ name: 'Havanna' }] }),
        wooProduct(2, { on_sale: true, prices: { price: '1000', regular_price: '1250', currency_minor_unit: 2 }, is_in_stock: false }),
        wooProduct(3, { type: 'variable', variations: [{ id: 31 }, { id: 32 }], prices: { price: '900', regular_price: '900', price_range: { min_amount: '900', max_amount: '1500' }, currency_minor_unit: 2 } }),
        wooProduct(4, { images: [] }),
        wooProduct(5, { prices: { price: '0', currency_minor_unit: 2 } }),
        wooProduct(6, { type: 'external', is_purchasable: false })
      ]]
    });
    const catalog = await fetchStorefrontCatalog('havannausa.com', { fetchImpl });

    expect(calls).toEqual([
      `https://havannausa.com/products.json?limit=${CATALOG_LIMIT}`,
      `https://www.havannausa.com/products.json?limit=${CATALOG_LIMIT}`,
      'https://havannausa.com/wp-json/wc/store/v1/products?per_page=100&page=1'
    ]);
    expect(catalog).toMatchObject({ status: 'woocommerce', domain: 'havannausa.com', storeUrl: 'https://havannausa.com', count: 3 });
    expect(isStorefrontCatalog(catalog)).toBe(true);

    const [alfajor, onSale, variable] = catalog.products;
    expect(alfajor).toEqual({
      id: 7297, handle: 'product-7297', title: 'Alfajor Mar del Plata \u2013 Box x 4 Alfajores',
      url: 'https://havannausa.com/product/product-7297/', image: 'https://havannausa.com/wp-content/uploads/7297.png',
      price: 14.99, compareAtPrice: null, available: true, vendor: 'Havanna', productType: 'Mini Line',
      description: 'Description: Two types of dulce de leche.', tags: ['Gift & Share'], variantCount: 1
    });
    expect(onSale).toMatchObject({ price: 10, compareAtPrice: 12.5, available: false });
    expect(variable).toMatchObject({ price: 9, variantCount: 2 });
  });

  it('pages through the Store API up to the limit and keeps what came before a failed page', async () => {
    const page = (start, n) => Array.from({ length: n }, (_, i) => wooProduct(start + i));
    const full = storefront({}, { 'shop.test': [page(1, 100), page(101, 100), page(201, 100)] });
    const capped = await fetchStorefrontCatalog('shop.test', { fetchImpl: full.fetchImpl });
    expect(capped.count).toBe(CATALOG_LIMIT);
    expect(full.calls.filter(u => u.includes('/wp-json/'))).toHaveLength(3);

    const broken = storefront({}, { 'shop.test': [page(1, 100)] });
    const partial = await fetchStorefrontCatalog('shop.test', { fetchImpl: broken.fetchImpl });
    expect(partial.status).toBe('woocommerce');
    expect(partial.count).toBe(100);
  });

  it('prefers products.json, skips hosts that never answered, and ignores a WordPress site without Woo', async () => {
    const both = storefront({ 'www.both.test': { products: PRODUCTS.slice(0, 1) } }, { 'both.test': [[wooProduct(1)]] });
    expect((await fetchStorefrontCatalog('both.test', { fetchImpl: both.fetchImpl })).status).toBe('shopify');

    const down = storefront({ 'down.test': 'throw', 'www.down.test': 'throw' }, { 'down.test': [[wooProduct(1)]] });
    expect((await fetchStorefrontCatalog('down.test', { fetchImpl: down.fetchImpl })).status).toBe('error');
    expect(down.calls.some(u => u.includes('/wp-json/'))).toBe(false);

    const blog = storefront({}, { 'blog.test': [{ code: 'rest_no_route' }], 'www.blog.test': [[{ id: 1, title: { rendered: 'Post' } }]] });
    expect((await fetchStorefrontCatalog('blog.test', { fetchImpl: blog.fetchImpl })).status).toBe('none');
  });
});
