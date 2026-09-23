import { describe, expect, it, vi } from 'vitest';
import { normalizeDomain, hostCandidates, fetchShopifyCatalog, CATALOG_LIMIT } from '$lib/shared/catalog.js';

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

// A stubbed storefront: products.json per host, as `fetchJson` reads it (status, url, text()).
function storefront(byHost) {
  const calls = [];
  const fetchImpl = vi.fn(async (url) => {
    calls.push(url);
    const host = new URL(url).hostname;
    const entry = byHost[host];
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

describe('fetchShopifyCatalog', () => {
  it('normalises products.json and drops what cannot be sold', async () => {
    const { calls, fetchImpl } = storefront({ 'graza.co': { products: PRODUCTS } });
    const catalog = await fetchShopifyCatalog('https://www.Graza.co/pages/x', { fetchImpl });

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
    const none = await fetchShopifyCatalog('nothing.test', { fetchImpl: storefront({}).fetchImpl });
    expect(none).toEqual({ status: 'none', domain: 'nothing.test', storeUrl: null, count: 0, products: [] });

    const notJson = await fetchShopifyCatalog('html.test', { fetchImpl: storefront({ 'html.test': '<html>', 'www.html.test': '<html>' }).fetchImpl });
    expect(notJson.status).toBe('none');

    const error = await fetchShopifyCatalog('down.test', { fetchImpl: storefront({ 'down.test': 'throw', 'www.down.test': 'throw' }).fetchImpl });
    expect(error.status).toBe('error');
  });

  it('keeps trying hosts past a failure and takes the origin the store answered from', async () => {
    const { fetchImpl } = storefront({ 'us.brand.com': 'throw', 'brand.com': { products: PRODUCTS.slice(0, 1) } });
    const catalog = await fetchShopifyCatalog('us.brand.com', { fetchImpl });
    expect(catalog.status).toBe('shopify');
    expect(catalog.domain).toBe('brand.com');
    expect(catalog.products[0].url).toBe('https://brand.com/products/sizzle');
  });

  it('is none for an empty input', async () => {
    const fetchImpl = vi.fn();
    expect(await fetchShopifyCatalog('', { fetchImpl })).toEqual({ status: 'none', domain: '', storeUrl: null, count: 0, products: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
