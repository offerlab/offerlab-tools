import { describe, expect, it } from 'vitest';
import { needsStandIns, gatherStandIns, productFromLink, nameFromAddress, standIn } from '$lib/shared/standins.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const gemini = body => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] });
const brand = { name: 'Balsam Hill', url: 'https://www.balsamhill.com', description: 'Realistic artificial Christmas trees.' };

// The api as the gatherer calls it: the page proxy, SerpAPI's Google Shopping, and Gemini.
function fakeApi({ page = { status: 'blocked' }, shopping = [], suggestions = null } = {}) {
  const calls = { page: [], serp: 0, gemini: [] };
  return {
    calls,
    page: async (url) => { calls.page.push(url); return json(page); },
    serp: async () => { calls.serp++; return json({ shopping_results: shopping }); },
    gemini: async (body) => {
      calls.gemini.push(body.contents[0].parts[0].text);
      return suggestions ? gemini(suggestions) : json({ error: 'down', status: 400 });
    }
  };
}

describe('needsStandIns', () => {
  it('is for a brand with a site and no products, unless staff hid them', () => {
    expect(needsStandIns({ url: 'https://a.com', catalog: { status: 'none', products: [] } })).toBe(true);
    expect(needsStandIns({ url: 'https://a.com' })).toBe(true);
    expect(needsStandIns({ url: 'https://a.com', catalog: { status: 'shopify', products: [{ id: 1 }] } })).toBe(false);
    expect(needsStandIns({ url: 'https://a.com', catalog: { status: 'none', products: [], hidden: true } })).toBe(false);
    expect(needsStandIns({ name: 'No site' })).toBe(false);
  });
});

describe('gatherStandIns', () => {
  const shopping = [
    { title: 'Balsam Hill Classic Blue Spruce Artificial Christmas Tree', thumbnail: 'https://g.test/spruce.jpg', product_link: 'https://google.com/x', source: 'Balsam Hill', extracted_price: 899 },
    { title: 'Some Other Brand Tree', thumbnail: 'https://g.test/other.jpg', product_link: 'https://google.com/y', source: 'Walmart', extracted_price: 99 }
  ];

  it('works from Google Shopping when the site turns the read away, and lets Gemini name and price them', async () => {
    const api = fakeApi({
      shopping,
      suggestions: { products: [
        { name: 'Classic Blue Spruce', price: 899, picture: 1 },
        { name: 'Majestic Wreath', price: '$129', picture: 1 },
        { name: 'Unpriced', price: null, picture: null }
      ] }
    });
    const result = await gatherStandIns(api, brand);
    expect(api.calls.page).toEqual(['https://www.balsamhill.com']);
    expect(api.calls.gemini[0]).toContain('1 | Balsam Hill Classic Blue Spruce Artificial Christmas Tree | $899 | Google Shopping');
    expect(result.images).toEqual([{ src: 'https://g.test/spruce.jpg', alt: 'Balsam Hill Classic Blue Spruce Artificial Christmas Tree' }]);
    // A picture goes to one product only, and a product with no price is no stand-in.
    expect(result.products).toEqual([
      { id: 'suggested-1', title: 'Classic Blue Spruce', image: 'https://g.test/spruce.jpg', price: 899, url: null, available: true, standIn: true },
      { id: 'suggested-2', title: 'Majestic Wreath', image: null, price: 129, url: null, available: true, standIn: true }
    ]);
  });

  it('puts the site\'s own named products first, and keeps them as they are when Gemini is down', async () => {
    const api = fakeApi({
      page: {
        status: 'ok',
        image: 'https://www.balsamhill.com/banner.jpg',
        products: [{ name: 'Vermont White Spruce', image: 'https://www.balsamhill.com/vws.jpg', price: 1099 }],
        images: [{ src: 'https://www.balsamhill.com/wreath.jpg', alt: 'Wreath' }]
      }
    });
    const result = await gatherStandIns(api, brand, { shopping: false });
    expect(api.calls.serp).toBe(0);
    expect(result.images.map(i => i.src)).toEqual([
      'https://www.balsamhill.com/vws.jpg', 'https://www.balsamhill.com/wreath.jpg', 'https://www.balsamhill.com/banner.jpg'
    ]);
    expect(result.products).toEqual([standIn({ id: 'suggested-1', name: 'Vermont White Spruce', price: 1099, image: 'https://www.balsamhill.com/vws.jpg' })]);
  });

  it('is null when nothing could be found or suggested', async () => {
    expect(await gatherStandIns(fakeApi(), brand)).toBe(null);
  });
});

describe('productFromLink', () => {
  it('reads the product off its page', async () => {
    const api = fakeApi({ page: { status: 'ok', url: 'https://a.com/p/tree', title: 'Tree | A', products: [{ name: 'Tree', image: 'https://a.com/t.jpg', price: '700', url: 'https://a.com/p/tree' }], images: [] } });
    expect(await productFromLink(api, 'a.com/p/tree')).toEqual({ name: 'Tree', image: 'https://a.com/t.jpg', price: 700, url: 'https://a.com/p/tree', blocked: false });
  });

  it('guesses the name from the address when the site will not serve the page', async () => {
    const result = await productFromLink(fakeApi(), 'https://www.balsamhill.com/p/balsam-fir-christmas-tree-BF123');
    expect(result).toEqual({ name: 'Balsam Fir Christmas Tree', image: null, price: null, url: 'https://www.balsamhill.com/p/balsam-fir-christmas-tree-BF123', blocked: true });
  });
});

describe('nameFromAddress', () => {
  it('takes the last wordy part of the path', () => {
    expect(nameFromAddress('https://brand.com/products/cozy-wool-throw')).toBe('Cozy Wool Throw');
    expect(nameFromAddress('brand.com/shop/lamps/arc_floor_lamp.html?variant=3')).toBe('Arc Floor Lamp');
    expect(nameFromAddress('https://www.amazon.com/Stanley-Quencher-Tumbler/dp/B0CJZMP7L1')).toBe('Stanley Quencher Tumbler');
    expect(nameFromAddress('https://www.balsamhill.com/p/balsam-fir-flip-artificial-christmas-tree-BFFLIP')).toBe('Balsam Fir Flip Artificial Christmas Tree');
  });

  it('is empty when the path names nothing', () => {
    expect(nameFromAddress('https://brand.com/')).toBe('');
    expect(nameFromAddress('https://brand.com/p/12345')).toBe('');
  });
});
