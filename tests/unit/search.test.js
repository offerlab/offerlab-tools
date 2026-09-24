import { describe, expect, it, vi } from 'vitest';
import {
  parseJsonResponse, brandDomain, ensureHttps, searchRecord, hasCatalog, catalogForStore, httpApi, extractText, fetchWithRetry, brandFacts, factsBlock, buildFrequentContext, normalizeRecommendations, capWellTrodden, geminiJson, topUpEmerging, unexpectedCollabs, mergeUnexpected, gradeCandidates, composeGraded
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

  it('asks the proxy to keep a long call alive', async () => {
    const { calls, api } = stub();
    await api.gemini({ contents: [] }, undefined, { keepalive: true });
    await api.gemini({ contents: [] }, 'gemini-2.5-pro', { keepalive: true });
    expect(calls[0].url).toBe('https://finder.test/api/gemini?keepalive=1');
    expect(calls[1].url).toBe('https://finder.test/api/gemini?model=gemini-2.5-pro&keepalive=1');
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

// The analysis has to describe the site that was typed: web search for a short domain lands on
// whichever company owns the name in the news (built.com sells protein bars; "Built" in search is
// a construction-finance platform).
describe('brandFacts', () => {
  const json = body => new Response(JSON.stringify(body), { status: 200 });
  const api = {
    opengraph: async () => json({ imageUrl: null, faviconUrl: null, title: 'BUILT Protein Bars | The Best Tasting Protein Bar', description: 'Discover a protein bar that actually tastes good!', siteName: 'BUILT' }),
    catalog: async () => json({ status: 'shopify', products: [
      { title: 'Strawberry Cheesecake Puff', vendor: 'BUILT', productType: 'Protein Bar' },
      { title: 'Orange Cream Pop Puff', vendor: 'BUILT', productType: 'Protein Bar' }
    ] })
  };

  it('reads the site\'s own words and what it sells', async () => {
    const facts = await brandFacts(api, 'built.com');
    expect(facts).toEqual({
      title: 'BUILT Protein Bars | The Best Tasting Protein Bar',
      description: 'Discover a protein bar that actually tastes good!',
      siteName: 'BUILT',
      vendor: 'BUILT',
      productTypes: ['Protein Bar'],
      products: ['Strawberry Cheesecake Puff', 'Orange Cream Pop Puff']
    });
    const block = factsBlock(facts);
    expect(block).toContain('Site title: BUILT | BUILT Protein Bars');
    expect(block).toContain('Products on sale: Strawberry Cheesecake Puff; Orange Cream Pop Puff');
    expect(block).toContain('ignore them');
  });

  it('says nothing when nothing could be read', async () => {
    const down = { opengraph: async () => new Response('', { status: 500 }), catalog: async () => new Response('', { status: 500 }) };
    const facts = await brandFacts(down, 'nowhere.example');
    expect(factsBlock(facts)).toBe('');
    expect(factsBlock(null)).toBe('');
  });
});

describe('buildFrequentContext', () => {
  it('names the well-trodden brands and caps them, and says nothing with none', () => {
    const context = buildFrequentContext([{ name: 'Brightland', domain: 'brightland.co' }, { domain: 'ourplace.com' }]);
    expect(context).toContain('Brightland, ourplace.com');
    expect(context).toContain('at most 2 of them');
    expect(buildFrequentContext([])).toBe('');
    expect(buildFrequentContext(undefined)).toBe('');
  });
});

describe('normalizeRecommendations', () => {
  it('gives every brand one of the six angles and one of the five lanes', () => {
    const [a, b, c] = normalizeRecommendations([
      { name: 'A', category: 'complementary', lane: 'lifestyle' },
      { name: 'B', category: 'same-aesthetic', lane: 'lifestyle-stack' },
      { name: 'C', category: 'unexpected-delight' }
    ]);
    expect([a.category, a.lane]).toEqual(['lifestyle-stack', 'lifestyle']);
    expect([b.category, b.lane]).toEqual(['same-aesthetic', 'lifestyle']);
    expect([c.category, c.lane]).toEqual(['unexpected-delight', 'unexpected']);
  });
});

describe('capWellTrodden', () => {
  const frequent = [{ name: 'Brightland' }, { name: 'Our Place' }, { name: 'Graza' }, { name: 'Fly By Jing' }];
  const list = names => names.map(name => ({ name }));

  it('keeps the first two well-trodden picks and drops the rest', () => {
    const brands = list(['Graza', 'Fishwife', 'Brightland', 'Our Place', 'Fly By Jing', 'Ooni', 'Acid League', 'Sanzo', 'Ghia', 'Haus', 'Jeni\'s', 'Momofuku', 'Curio']);
    expect(capWellTrodden(brands, frequent).map(b => b.name)).toEqual(['Graza', 'Fishwife', 'Brightland', 'Ooni', 'Acid League', 'Sanzo', 'Ghia', 'Haus', 'Jeni\'s', 'Momofuku', 'Curio']);
  });

  it('stops dropping once the list would fall below ten', () => {
    const brands = list(['Graza', 'Brightland', 'Our Place', 'Fly By Jing', 'A', 'B', 'C', 'D', 'E', 'F', 'G']);
    expect(capWellTrodden(brands, frequent)).toHaveLength(10);
  });

  it('leaves the list alone with nothing well-trodden', () => {
    expect(capWellTrodden(list(['A', 'B']), [])).toHaveLength(2);
  });
});

const gemini = text => ({ candidates: [{ content: { parts: [{ text }] } }] });
const answers = (...bodies) => { let i = 0; return { gemini: async () => new Response(JSON.stringify(bodies[Math.min(i++, bodies.length - 1)]), { status: 200 }) }; };

describe('geminiJson', () => {
  it('reads the answer, tries once more after a failure the proxy reports in the body, and gives up on the rest', async () => {
    const ok = gemini('{"a":1}');
    expect(await geminiJson(answers({ error: 'Gemini did not answer in time', status: 504 }, ok), 'Test', {})).toEqual(ok);
    await expect(geminiJson(answers({ error: 'Gemini API request failed', status: 400 }), 'Test', {})).rejects.toThrow('Test failed: 400 - Gemini API request failed');
    await expect(geminiJson(answers({ error: 'down', status: 503 }, { error: 'down', status: 503 }), 'Test', {})).rejects.toThrow('Test failed: 503 - down');
  });
});

describe('topUpEmerging', () => {
  const profile = { name: 'BUILT', url: 'https://built.com' };
  const brand = (name, brandStage, lane = 'same-shelf') => ({ name, url: `https://${name.toLowerCase()}.com`, brandStage, lane, category: 'same-moment' });

  it('adds emerging brands the list lacks, from the thin lanes, skipping what is listed or well-trodden', async () => {
    const brands = [brand('Vuori', 'established', 'lifestyle'), brand('Kodiak', 'established'), brand('Chomps', 'emerging')];
    const calls = [];
    const api = { gemini: async (body) => { calls.push(body.contents[0].parts[0].text); return new Response(JSON.stringify(gemini(JSON.stringify({ brands: [
      { name: 'Munk Pack', url: 'https://munkpack.com', lane: 'parallel-premium', category: 'same-values', brandStage: 'growing' },
      { name: 'Chomps', url: 'https://chomps.com', lane: 'unexpected', category: 'unexpected-delight' },
      { name: 'Brightland', url: 'https://brightland.co', lane: 'unexpected', category: 'unexpected-delight' },
      { name: 'Bala', url: 'https://shopbala.com', lane: 'unexpected', category: 'made up' }
    ] }))), { status: 200 }); } };
    const result = await topUpEmerging(api, { brandProfile: profile, brandName: 'BUILT', domain: 'built.com', brands, frequentBrands: [{ name: 'Brightland' }] });
    expect(result.map(b => b.name)).toEqual(['Vuori', 'Kodiak', 'Chomps', 'Munk Pack', 'Bala']);
    expect(result.slice(3).every(b => b.brandStage === 'emerging')).toBe(true);
    expect(result[4].category).toBe('unexpected-delight');
    expect(calls[0]).toContain('Add 4 EMERGING brands');
    expect(calls[0]).toContain('Brightland');
  });

  it('makes room in a full list by letting go of its last established picks', async () => {
    const brands = Array.from({ length: 15 }, (_, i) => brand(`Brand${i}`, i === 14 ? 'emerging' : 'established'));
    const api = { gemini: async () => new Response(JSON.stringify(gemini(JSON.stringify({ brands: [
      { name: 'New1', url: 'https://new1.com', lane: 'unexpected', category: 'unexpected-delight' },
      { name: 'New2', url: 'https://new2.com', lane: 'unexpected', category: 'unexpected-delight' },
      { name: 'New3', url: 'https://new3.com', lane: 'unexpected', category: 'unexpected-delight' },
      { name: 'New4', url: 'https://new4.com', lane: 'unexpected', category: 'unexpected-delight' }
    ] }))), { status: 200 }) };
    const result = await topUpEmerging(api, { brandProfile: profile, brandName: 'X', domain: 'x.com', brands });
    expect(result).toHaveLength(15);
    expect(result.filter(b => b.brandStage === 'emerging').map(b => b.name)).toEqual(['Brand14', 'New1', 'New2', 'New3', 'New4']);
    expect(result.map(b => b.name).slice(0, 10)).toEqual(brands.slice(0, 10).map(b => b.name));
  });

  it('leaves a list with enough emerging brands alone, without a call', async () => {
    const brands = ['A', 'B', 'C', 'D'].map(n => brand(n, 'emerging'));
    const api = { gemini: async () => { throw new Error('must not call'); } };
    expect(await topUpEmerging(api, { brandProfile: profile, brandName: 'X', domain: 'x.com', brands })).toBe(brands);
  });

  it('keeps the list as it was when the call fails', async () => {
    const brands = [brand('Vuori', 'established')];
    const api = { gemini: async () => new Response(JSON.stringify({ error: 'down', status: 503 }), { status: 200 }) };
    expect(await topUpEmerging(api, { brandProfile: profile, brandName: 'X', domain: 'x.com', brands })).toEqual(brands);
  });
});

describe('unexpectedCollabs and mergeUnexpected', () => {
  const profile = { name: 'Fly By Jing', url: 'https://flybyjing.com', description: 'Sichuan chili crisp' };
  const brand = (name, lane, brandStage = 'established') => ({ name, url: `https://${name.toLowerCase().replace(/ /g, '')}.com`, lane, category: 'same-moment', brandStage });
  const ideasBody = gemini(JSON.stringify({ ideas: [
    { brand: 'Who Gives A Crap', hook: 'Twenty-four days of spice needs a plan for the day after', their_product: 'Premium bamboo toilet paper', our_product: 'the advent calendar', why_yes: 'Everyone gets it', bundle_name: 'The Ring of Fire Kit', brandStage: 'established' },
    { brand: 'Dude Wipes', hook: 'Same story, on the go', their_product: 'Flushable wipes', our_product: 'Chili crisp', why_yes: 'Obvious once said', bundle_name: 'Aftermath', brandStage: 'growing' },
    { brand: 'Graza', hook: 'listed already', their_product: 'Sizzle', our_product: 'Chili crisp', why_yes: 'no', bundle_name: 'x' },
    { brand: 'Lao Gan Ma', hook: 'a competitor', their_product: 'Chili crisp', our_product: 'Chili crisp', why_yes: 'no', bundle_name: 'x' },
    { brand: 'Nowhere Co', hook: 'no site', their_product: 'thing', our_product: 'Chili crisp', why_yes: 'maybe', bundle_name: 'x' }
  ] }));
  const grades = { 'Who Gives A Crap': { surprise: 2.6, fit: 1.6 }, 'Dude Wipes': { surprise: 2.4, fit: 1.5 }, 'Lao Gan Ma': { surprise: 0.5, fit: 2.5, competitor: 0.9 }, 'Nowhere Co': { surprise: 2.9, fit: 1.4 } };
  const jevFor = name => ({ answers: { kind: { probabilities: { consumer_brand: 1 } }, competitor: { noul: grades[name]?.competitor ?? 0.05 }, lane: { choice: 'adjacent-function', confidence: 0.8 }, stage: { choice: 'established' }, fit: { score: grades[name]?.fit ?? 2 }, surprise: { score: grades[name]?.surprise ?? 1 } } });
  const api = {
    gemini: async () => new Response(JSON.stringify(ideasBody), { status: 200 }),
    jev: async (body) => new Response(JSON.stringify(jevFor(JSON.parse(body).state.candidate.name)), { status: 200 }),
    serp: async (params) => {
      const q = new URLSearchParams(params).get('q');
      const sites = { 'Who Gives A Crap official site': ['https://www.instagram.com/whogivesacrap', 'https://whogivesacrap.org/'], 'Dude Wipes official site': ['https://dudewipes.com/collections/all'], 'Graza official site': ['https://graza.co/'], 'Nowhere Co official site': [] };
      return new Response(JSON.stringify({ organic_results: (sites[q] || []).map(link => ({ link })) }), { status: 200 });
    }
  };

  it('ideates without grounding, lets Jev pick the surprising ideas that hold a bundle, and resolves each pick\'s real site', async () => {
    const picks = await unexpectedCollabs(api, { brandProfile: profile, brandName: 'Fly By Jing', domain: 'flybyjing.com', frequentBrands: [{ name: 'Brightland' }] });
    expect(picks.map(b => [b.name, b.url])).toEqual([['Who Gives A Crap', 'https://whogivesacrap.org'], ['Dude Wipes', 'https://dudewipes.com'], ['Graza', 'https://graza.co']]);
    expect(picks[0]).toMatchObject({ lane: 'unexpected', category: 'unexpected-delight', hook: 'Twenty-four days of spice needs a plan for the day after', brandStage: 'established' });
    expect(picks[0].reasons[1]).toBe('Premium bamboo toilet paper with the advent calendar');
    expect(picks[0].bundleIdea).toBe('The Ring of Fire Kit: Everyone gets it');
  });

  it('keeps the list as it was when ideation fails', async () => {
    const failing = { ...api, gemini: async () => new Response(JSON.stringify({ error: 'down', status: 503 }), { status: 200 }) };
    expect(await unexpectedCollabs(failing, { brandProfile: profile, brandName: 'X', domain: 'x.com' })).toEqual([]);
  });

  it('mergeUnexpected keeps the main call\'s own unexpected picks only to fill the lane, and makes room in a full list', () => {
    const others = Array.from({ length: 13 }, (_, i) => brand(`B${i}`, 'lifestyle', i === 12 ? 'emerging' : 'established'));
    const brands = [...others, brand('Own1', 'unexpected'), brand('Own2', 'unexpected')];
    const merged = mergeUnexpected(brands, [brand('Hot1', 'unexpected'), brand('Hot2', 'unexpected'), brand('B3', 'unexpected')]);
    expect(merged).toHaveLength(15);
    expect(merged.filter(b => b.lane === 'unexpected').map(b => b.name)).toEqual(['Hot1', 'Hot2', 'Own1']);
    expect(merged.find(b => b.name === 'B12')).toBeTruthy();
    expect(merged.find(b => b.name === 'B11')).toBeUndefined();
    expect(mergeUnexpected(brands, [])).toBe(brands);
  });
});

describe('gradeCandidates and composeGraded', () => {
  const brand = (name, lane, brandStage = 'established') => ({ name, url: `https://${name.toLowerCase().replace(/[^a-z]/g, '')}.com`, lane, category: 'same-moment', brandStage });
  const grade = (over = {}) => ({ brand: 1, kind: 'consumer_brand', competitor: 0.05, lane: 'same-shelf', laneConfidence: 0.8, stage: 'growing', stageConfidence: 0.8, fit: 2.4, surprise: 1.5, ...over });

  it('asks Jev about every candidate and reads the answers, tolerating a candidate it cannot grade', async () => {
    const answers = { kind: { choice: 'media', probabilities: { consumer_brand: 0.02, media: 0.98 }, confidence: 0.9 }, competitor: { noul: 0.1 }, lane: { choice: 'lifestyle', confidence: 0.7 }, stage: { choice: 'established' }, fit: { score: 1.9 }, surprise: { score: 2.4 } };
    let n = 0;
    const api = { jev: async () => (n++ === 0 ? new Response(JSON.stringify({ answers }), { status: 200 }) : new Response('', { status: 500 })) };
    const grades = await gradeCandidates(api, { name: 'X' }, [brand('Monocle', 'lifestyle'), brand('Y', 'same-shelf')]);
    expect(grades[0]).toMatchObject({ brand: 0.02, kind: 'media', competitor: 0.1, lane: 'lifestyle', stage: 'established', fit: 1.9, surprise: 2.4 });
    expect(grades[1]).toBeNull();
    expect(await gradeCandidates({}, { name: 'X' }, [brand('Y', 'same-shelf')])).toEqual([null]);
  });

  it('drops non-brands, competitors and unbelievable bundles, takes Jev\'s lane and stage, and fills the unexpected lane by surprise', () => {
    const brands = [
      brand('Monocle', 'lifestyle'), brand('Wild One', 'adjacent-function'), brand('Field Skillet', 'unexpected'),
      brand('Hatch', 'unexpected'), brand('Cadence', 'parallel-premium'), brand('Floyd', 'same-shelf'),
      brand('Parachute', 'parallel-premium'), brand('Snow Peak', 'lifestyle'), brand('Flea Away', 'adjacent-function')
    ];
    const grades = [
      grade({ brand: 0.02, kind: 'media' }),
      grade({ competitor: 0.69 }),
      grade({ fit: 1.0, surprise: 2.5 }),
      grade({ lane: 'adjacent-function', laneConfidence: 0.91, stage: 'established', surprise: 1.4 }),
      grade({ lane: 'adjacent-function', laneConfidence: 0.77, stage: 'emerging', surprise: 2.6 }),
      grade({ lane: 'parallel-premium', laneConfidence: 0.67, surprise: 2.3 }),
      grade({ lane: 'parallel-premium', laneConfidence: 0.74, surprise: 1.7 }),
      grade({ lane: 'lifestyle', laneConfidence: 0.34, surprise: 2.0 }),
      grade({ lane: 'adjacent-function', laneConfidence: 0.88, stage: 'emerging', surprise: 1.5 })
    ];
    const out = composeGraded(brands, grades);
    expect(out.map(b => b.name)).toEqual(['Hatch', 'Cadence', 'Floyd', 'Parachute', 'Snow Peak', 'Flea Away']);
    expect(out.find(b => b.name === 'Hatch')).toMatchObject({ lane: 'adjacent-function', brandStage: 'established' });
    // Cadence and Floyd are the surprising ones; they hold the unexpected lane whatever their relation.
    expect(out.filter(b => b.lane === 'unexpected').map(b => b.name)).toEqual(['Cadence', 'Floyd']);
    expect(out.find(b => b.name === 'Cadence').category).toBe('unexpected-delight');
    // Snow Peak: Jev was not sure, so the model's lane stands.
    expect(out.find(b => b.name === 'Snow Peak').lane).toBe('lifestyle');
    expect(out.find(b => b.name === 'Flea Away').brandStage).toBe('emerging');
  });

  it('pins the ideated pairings to the unexpected lane, never fills it by fit, and keeps the model\'s stage when Jev is unsure', () => {
    const brands = [
      { ...brand('Who Gives A Crap', 'unexpected'), hook: 'the aftermath' },
      brand('Slip', 'same-shelf'), brand('Osea', 'same-shelf'), brand('Loftie', 'adjacent-function'), brand('Cometeer', 'adjacent-function'),
      brand('The Sill', 'lifestyle'), brand('Kin', 'lifestyle'), brand('Public Goods', 'parallel-premium'), brand('Soft Services', 'parallel-premium', 'emerging')
    ];
    const grades = [
      grade({ lane: 'adjacent-function', surprise: 2.6 }),
      grade({ fit: 2.8, surprise: 0.9 }), grade({ surprise: 1.6 }), grade({ lane: 'adjacent-function', surprise: 1.8 }), grade({ lane: 'adjacent-function', surprise: 1.7 }),
      grade({ lane: 'lifestyle', surprise: 1.5 }), grade({ lane: 'lifestyle', surprise: 1.9 }), grade({ lane: 'parallel-premium', surprise: 1.5 }), grade({ lane: 'parallel-premium', stage: 'growing', stageConfidence: 0.3, surprise: 1.7 })
    ];
    const out = composeGraded(brands, grades);
    expect(out.filter(b => b.lane === 'unexpected').map(b => b.name)).toEqual(['Who Gives A Crap']);
    expect(out.find(b => b.name === 'Slip').lane).toBe('same-shelf');
    expect(out.find(b => b.name === 'Soft Services').brandStage).toBe('emerging');
  });

  it('leaves the list alone when nothing was graded', () => {
    const brands = [brand('A', 'same-shelf')];
    expect(composeGraded(brands, [null])).toBe(brands);
  });
});
