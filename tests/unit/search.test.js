import { describe, expect, it, vi } from 'vitest';
import {
  parseJsonResponse, brandDomain, ensureHttps, searchRecord, hasCatalog, catalogForStore, httpApi, extractText, fetchWithRetry
} from '$lib/shared/search.js';

describe('parseJsonResponse', () => {
  it('reads JSON out of a markdown fence', () => {
    expect(parseJsonResponse('Here you go:\n```json\n{"brands": [{"name": "Graza"}]}\n```')).toEqual({ brands: [{ name: 'Graza' }] });
  });

  it('reads bare JSON', () => {
    expect(parseJsonResponse('{"a": 1}')).toEqual({ a: 1 });
  });

  it('repairs trailing commas', () => {
    expect(parseJsonResponse('{"brands": [{"name": "Graza",},],}')).toEqual({ brands: [{ name: 'Graza' }] });
  });

  it('salvages a reply cut off mid-object', () => {
    const result = parseJsonResponse('```json\n{"brands": [{"name": "Graza", "url": "https://graza.co"}, {"name": "Fly By');
    expect(result.brands[0]).toEqual({ name: 'Graza', url: 'https://graza.co' });
  });

  it('throws on nothing', () => {
    expect(() => parseJsonResponse('')).toThrow('No response from AI');
  });
});

describe('extractText', () => {
  it('joins the non-thought parts', () => {
    const data = { candidates: [{ content: { parts: [{ text: 'a', thought: true }, { text: 'b' }, { text: 'c' }] } }] };
    expect(extractText(data)).toBe('bc');
    expect(extractText(null)).toBe('');
  });
});

describe('brandDomain', () => {
  it('strips scheme, www and path', () => {
    expect(brandDomain('https://www.Graza.co/pages/x')).toBe('graza.co');
    expect(brandDomain('graza.co/shop')).toBe('graza.co');
    expect(brandDomain('  graza.co ')).toBe('graza.co');
  });

  it('is empty for nothing', () => {
    expect(brandDomain('')).toBe('');
    expect(brandDomain(null)).toBe('');
    expect(brandDomain(42)).toBe('');
  });
});

describe('ensureHttps', () => {
  it('prefixes a bare domain', () => {
    expect(ensureHttps({ url: 'graza.co', name: 'Graza' })).toEqual({ url: 'https://graza.co', name: 'Graza' });
    expect(ensureHttps({ url: '//graza.co' }).url).toBe('https://graza.co');
  });

  it('leaves a full url and empty items alone', () => {
    expect(ensureHttps({ url: 'http://graza.co' }).url).toBe('http://graza.co');
    expect(ensureHttps({ url: '' })).toEqual({ url: '' });
    expect(ensureHttps(null)).toBeNull();
  });
});

describe('hasCatalog', () => {
  it('is true for shopify and a fresh serp catalog with products', () => {
    expect(hasCatalog({ status: 'shopify', products: [] })).toBe(true);
    expect(hasCatalog({ status: 'serp', products: [{}] })).toBe(true);
  });

  it('is false for stale serp, empty serp, none and nothing', () => {
    expect(hasCatalog({ status: 'serp', products: [{}], stale: true })).toBe(false);
    expect(hasCatalog({ status: 'serp', products: [] })).toBe(false);
    expect(hasCatalog({ status: 'none' })).toBe(false);
    expect(hasCatalog(null)).toBe(false);
  });
});

describe('catalogForStore', () => {
  it('drops the products of a shopify catalog but keeps the rest', () => {
    const brand = { name: 'A', catalog: { status: 'shopify', count: 2, storeUrl: 'https://a.com', products: [{ id: 1 }, { id: 2 }] } };
    expect(catalogForStore(brand)).toEqual({ name: 'A', catalog: { status: 'shopify', count: 2, storeUrl: 'https://a.com', products: [] } });
    expect(brand.catalog.products).toHaveLength(2);
  });

  it('sends a serp catalog along whole and leaves a brand without one alone', () => {
    const serp = { name: 'B', catalog: { status: 'serp', count: 1, products: [{ id: 1 }] } };
    expect(catalogForStore(serp)).toBe(serp);
    const bare = { name: 'C' };
    expect(catalogForStore(bare)).toBe(bare);
  });
});

describe('searchRecord', () => {
  const results = {
    searchedBrand: { name: 'S', url: 'https://s.com', catalog: { status: 'shopify', count: 1, products: [{ id: 1 }] } },
    brands: [{ name: 'A', url: 'https://a.com', catalog: { status: 'shopify', count: 1, products: [{ id: 2 }] } }],
    serpApiOutOfCredits: true
  };

  it('is empty without brands', () => {
    expect(searchRecord({ brands: [] }, 'x')).toEqual({ type: 'empty', searchId: 'x' });
  });

  it('strips shopify products by default', () => {
    const record = searchRecord(results, 'id-1');
    expect(record.type).toBe('results');
    expect(record.searchId).toBe('id-1');
    expect(record.serpApiOutOfCredits).toBe(true);
    expect(record.brands[0].catalog.products).toEqual([]);
    expect(record.searchedBrand.catalog.products).toEqual([]);
  });

  it('keeps every catalog when asked', () => {
    const record = searchRecord(results, 'id-2', { keepCatalogs: true });
    expect(record.brands[0].catalog.products).toEqual([{ id: 2 }]);
    expect(record.searchedBrand.catalog.products).toEqual([{ id: 1 }]);
  });
});

describe('httpApi', () => {
  function stub() {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    });
    return { calls, api: httpApi('https://finder.test', fetchImpl) };
  }

  it('builds the read proxy urls against the base', async () => {
    const { calls, api } = stub();
    await api.serp(new URLSearchParams({ q: 'graza olive oil', engine: 'google_shopping' }));
    await api.catalog('graza.co');
    await api.socials('www.graza.co');
    await api.opengraph('https://graza.co/a b');
    expect(calls.map(c => c.url)).toEqual([
      'https://finder.test/api/serpapi?q=graza+olive+oil&engine=google_shopping',
      'https://finder.test/api/catalog?domain=graza.co',
      'https://finder.test/api/socials?domain=www.graza.co',
      'https://finder.test/api/opengraph?url=https%3A%2F%2Fgraza.co%2Fa%20b'
    ]);
  });

  it('posts JSON to gemini, with the model when given', async () => {
    const { calls, api } = stub();
    await api.gemini({ contents: [] });
    await api.gemini({ contents: [] }, 'gemini-2.5-pro');
    expect(calls[0].url).toBe('https://finder.test/api/gemini');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body)).toEqual({ contents: [] });
    expect(calls[1].url).toBe('https://finder.test/api/gemini?model=gemini-2.5-pro');
  });

  it('calls relative paths with no base', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    await httpApi('', fetchImpl).catalog('a.com');
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/catalog?domain=a.com');
  });
});

describe('fetchWithRetry', () => {
  const res = (status) => new Response('{}', { status });
  // A request that never answers until its attempt's signal aborts it.
  const hang = (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));

  it('gives an attempt its own signal', async () => {
    let seen;
    const response = await fetchWithRetry('/x', { method: 'POST' }, 3, async (_url, options) => { seen = options.signal; return res(200); }, { timeoutMs: 100 });
    expect(response.status).toBe(200);
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it('retries an attempt that times out', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const pending = fetchWithRetry('/x', {}, 3, async (_url, options) => (++calls === 1 ? hang(options.signal) : res(200)), { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50); // first attempt times out
    await vi.advanceTimersByTimeAsync(1000); // backoff before the second
    expect((await pending).status).toBe(200);
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  it('retries a 5xx and hands back the last response', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const pending = fetchWithRetry('/x', {}, 2, async () => { calls++; return res(502); });
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).status).toBe(502);
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  it('does not retry a cancelled request', async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = fetchWithRetry('/x', { signal: controller.signal }, 3, async (_url, options) => { calls++; return hang(options.signal); }, { timeoutMs: 5000 });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });

  it('says so when every attempt times out', async () => {
    vi.useFakeTimers();
    const pending = fetchWithRetry('/x', {}, 2, async (_url, options) => hang(options.signal), { timeoutMs: 50 });
    const failure = expect(pending).rejects.toThrow('timed out 2 times');
    await vi.advanceTimersByTimeAsync(50 + 1000 + 50);
    await failure;
    vi.useRealTimers();
  });

  it('threads the api signal into a plain GET', async () => {
    const controller = new AbortController();
    let seen;
    await httpApi('', async (_url, options) => { seen = options?.signal; return res(200); }, { signal: controller.signal }).catalog('a.com');
    expect(seen).toBe(controller.signal);
  });
});
