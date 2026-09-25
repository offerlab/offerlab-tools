import { describe, expect, it, vi } from 'vitest';
import { pageUrl, readPage, mainProduct, fetchPage, toPrice } from '$lib/shared/page.js';

describe('pageUrl', () => {
  it('takes a public web address, with or without its scheme', () => {
    expect(pageUrl('balsamhill.com/p/tree')).toBe('https://balsamhill.com/p/tree');
    expect(pageUrl('http://shop.brand.co')).toBe('http://shop.brand.co/');
  });

  it('refuses anything that is not a named public host', () => {
    for (const bad of ['', 'not a url', 'localhost:3000', 'http://127.0.0.1/admin', 'http://[::1]/', 'ftp://brand.com', 'http://printer.local', 'intranet']) {
      expect(pageUrl(bad)).toBe(null);
    }
  });
});

describe('toPrice', () => {
  it('reads a price out of what a page writes', () => {
    expect(toPrice('$1,299.00')).toBe(1299);
    expect(toPrice('49.5')).toBe(49.5);
    expect(toPrice(700)).toBe(700);
  });

  it('is null for nothing, zero or words', () => {
    expect(toPrice('')).toBe(null);
    expect(toPrice('0.00')).toBe(null);
    expect(toPrice('Call for price')).toBe(null);
    expect(toPrice(null)).toBe(null);
  });
});

const PRODUCT_PAGE = `<!doctype html><html><head>
<title>Fallback title</title>
<meta property="og:title" content="Classic Blue Spruce &amp; Lights">
<meta property="og:image" content="/img/spruce-og.jpg">
<meta property="product:price:amount" content="899.00">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"Product","name":"Classic Blue Spruce","image":["https://cdn.example.com/spruce.jpg"],"url":"/p/classic-blue-spruce","offers":[{"@type":"Offer","price":"999.00"},{"@type":"Offer","price":"899.00"}]}]}</script>
<script type="application/ld+json">{ not json</script>
</head><body>
<img src="/logo.svg" alt="Brand">
<img src="https://cdn.example.com/icons/cart.png" width="24" height="24">
<img data-src="/img/wreath.jpg" alt="Majestic Wreath">
<img srcset="/img/garland-400.jpg 400w, /img/garland-1200.jpg 1200w" alt="Garland">
<img src="data:image/gif;base64,R0lGOD">
<img src="/img/wreath.jpg" alt="Majestic Wreath again">
</body></html>`;

describe('readPage', () => {
  const page = readPage(PRODUCT_PAGE, 'https://www.balsamhill.com/p/classic-blue-spruce');

  it('reads the meta tags, entities decoded and addresses made whole', () => {
    expect(page.title).toBe('Classic Blue Spruce & Lights');
    expect(page.image).toBe('https://www.balsamhill.com/img/spruce-og.jpg');
    expect(page.price).toBe(899);
  });

  it('finds a JSON-LD product nested in a graph, at its lowest offer, skipping a broken block', () => {
    expect(page.products).toEqual([{
      name: 'Classic Blue Spruce',
      image: 'https://cdn.example.com/spruce.jpg',
      price: 899,
      url: 'https://www.balsamhill.com/p/classic-blue-spruce'
    }]);
  });

  it('keeps the pictures that could be products, lazy and srcset ones included, once each', () => {
    expect(page.images).toEqual([
      { src: 'https://www.balsamhill.com/img/wreath.jpg', alt: 'Majestic Wreath' },
      { src: 'https://www.balsamhill.com/img/garland-1200.jpg', alt: 'Garland' }
    ]);
  });

  it('finds products in an item list', () => {
    const list = readPage(`<script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"ListItem","item":{"@type":"Product","name":"Wreath","image":{"url":"/w.jpg"},"offers":{"lowPrice":"129"}}}]}</script>`, 'https://brand.com/');
    expect(list.products).toEqual([{ name: 'Wreath', image: 'https://brand.com/w.jpg', price: 129, url: null }]);
  });
});

describe('mainProduct', () => {
  it('is the JSON-LD product when there is one', () => {
    const page = { ...readPage(PRODUCT_PAGE, 'https://www.balsamhill.com/p/x'), url: 'https://www.balsamhill.com/p/x' };
    expect(mainProduct(page)).toEqual({ name: 'Classic Blue Spruce', image: 'https://cdn.example.com/spruce.jpg', price: 899, url: 'https://www.balsamhill.com/p/classic-blue-spruce' });
  });

  it('falls back to the meta tags, and is null with no name at all', () => {
    const page = { ...readPage('<meta property="og:title" content="Tree"><meta property="og:image" content="https://a.com/t.jpg">', 'https://a.com/'), url: 'https://a.com/t' };
    expect(mainProduct(page)).toEqual({ name: 'Tree', image: 'https://a.com/t.jpg', price: null, url: 'https://a.com/t' });
    expect(mainProduct(readPage('<p>nothing</p>', 'https://a.com/'))).toBe(null);
  });
});

describe('fetchPage', () => {
  const html = (body, { status = 200, type = 'text/html; charset=utf-8', url = 'https://brand.com/' } = {}) =>
    vi.fn(async () => ({ ok: status < 400, status, url, headers: new Headers({ 'content-type': type }), text: async () => body }));

  it('reads a page it is served', async () => {
    const page = await fetchPage('brand.com', { fetchImpl: html('<title>Brand</title>') });
    expect(page).toMatchObject({ status: 'ok', url: 'https://brand.com/', title: 'Brand' });
  });

  it('calls a refusal or a bot check blocked, not an error', async () => {
    expect(await fetchPage('brand.com', { fetchImpl: html('nope', { status: 429 }) })).toMatchObject({ status: 'blocked', httpStatus: 429 });
    expect(await fetchPage('brand.com', { fetchImpl: html('<title>Vercel Security Checkpoint</title>') })).toMatchObject({ status: 'blocked' });
    expect(await fetchPage('brand.com', { fetchImpl: html('{}', { type: 'application/json' }) })).toMatchObject({ status: 'blocked' });
  });

  it('says error when nothing answered, and invalid without fetching for a bad address', async () => {
    expect(await fetchPage('brand.com', { fetchImpl: async () => { throw new Error('ECONNRESET'); } })).toMatchObject({ status: 'error' });
    const fetchImpl = vi.fn();
    expect(await fetchPage('localhost', { fetchImpl })).toEqual({ status: 'invalid', url: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
