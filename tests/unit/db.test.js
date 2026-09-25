import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '$lib/server/db.js';
import { createTestDb, migrationStatements, resetDb, searchFixture } from './helpers/d1.js';

let ctx, db;
beforeAll(async () => { ctx = await createTestDb(); db = ctx.db; });
afterAll(() => ctx.dispose());
beforeEach(() => resetDb(db));

describe('canonicalDomain', () => {
  it('is the lowercase host without www', () => {
    expect(store.canonicalDomain('https://www.Graza.co/pages/x')).toBe('graza.co');
    expect(store.canonicalDomain('WWW.GRAZA.CO')).toBe('graza.co');
    expect(store.canonicalDomain('')).toBe('');
  });
});

describe('searches', () => {
  it('stores a search and hands it back with trimmed catalogs', async () => {
    const record = searchFixture('graza.co', 2, { products: 30 });
    record.brands.push({ name: 'Bare', url: 'https://bare.test', reasons: [] });
    const written = await store.putSearch(db, 'https://www.Graza.co/', record, 1000);
    expect(written).toEqual({ domain: 'graza.co', searchId: 'search-graza.co', timestamp: 1000 });

    const search = await store.getSearch(db, 'graza.co');
    expect(search.type).toBe('results');
    expect(search.searchId).toBe('search-graza.co');
    expect(search.timestamp).toBe(1000);
    expect(search.serpApiOutOfCredits).toBe(false);
    expect(search.searchedBrand.name).toBe('graza.co');
    expect(search.searchedBrand.catalog.products).toHaveLength(store.DEFAULT_PRODUCTS_PER_BRAND);
    expect(search.searchedBrand.catalog.truncated).toBe(true);
    expect(search.brands.map(b => b.name)).toEqual(['Partner 1', 'Partner 2', 'Bare']);
    expect(search.brands[0].catalog.count).toBe(30);
    expect(search.brands[2].catalog).toEqual({ status: 'none', domain: 'bare.test', storeUrl: null, count: 0, products: [], truncated: false });

    const none = await store.getSearch(db, 'graza.co', { products: 0 });
    expect(none.brands[0].catalog.products).toEqual([]);
    expect(none.brands[0].catalog.truncated).toBe(true);
    const all = await store.getSearch(db, 'graza.co', { products: null });
    expect(all.brands[0].catalog.products).toHaveLength(30);
    expect(all.brands[0].catalog.truncated).toBe(false);

    // Brands are stored without their catalogs; the catalogs table has them.
    const row = await db.prepare('SELECT brand FROM search_brands WHERE search_domain = ? AND position = 0').bind('graza.co').first();
    expect(JSON.parse(row.brand).catalog).toBeUndefined();
    expect((await store.getCatalog(db, 'partner1-graza.co')).count).toBe(30);
  });

  it('is null for a domain never searched and coerces an unknown type to error', async () => {
    expect(await store.getSearch(db, 'never.test')).toBeNull();
    await store.putSearch(db, 'odd.test', { type: 'bogus', errorMessage: 'boom' });
    const search = await store.getSearch(db, 'odd.test');
    expect(search.type).toBe('error');
    expect(search.errorMessage).toBe('boom');
    expect(search.brands).toEqual([]);
    expect(search.searchedBrand).toBeNull();
  });

  it('replaces the previous search for the same domain', async () => {
    await store.putSearch(db, 'graza.co', searchFixture('graza.co', 3), 1);
    await store.putSearch(db, 'graza.co', searchFixture('graza.co', 1), 2);
    const search = await store.getSearch(db, 'graza.co');
    expect(search.brands).toHaveLength(1);
    expect(search.timestamp).toBe(2);
  });

  it('refuses a search without a domain', async () => {
    await expect(store.putSearch(db, '', { type: 'results' })).rejects.toThrow('A search needs a domain');
  });
});

describe('catalogs', () => {
  it('does not remember an error and keeps a serp catalog over an empty crawl', async () => {
    expect(await store.putCatalog(db, 'a.test', { status: 'error', products: [] })).toBe(false);
    expect(await store.getCatalog(db, 'a.test')).toBeNull();

    await store.putCatalog(db, 'a.test', { status: 'serp', count: 1, products: [{ id: 1 }] }, 5);
    expect(await store.putCatalog(db, 'a.test', { status: 'none', products: [] }, 6)).toBe(false);
    const stored = await store.getCatalog(db, 'a.test');
    expect(stored.status).toBe('serp');
    expect(stored.fetchedAt).toBe(5);

    expect(store.keepStoredSerp({ status: 'serp', count: 1 }, { products: [] })).toBe(true);
    expect(store.keepStoredSerp({ status: 'serp', count: 1 }, { products: [{}] })).toBe(false);
    expect(store.keepStoredSerp({ status: 'shopify', count: 1 }, { products: [] })).toBe(false);
    expect(store.keepStoredSerp(null, { products: [] })).toBe(false);
  });

  it('strips the transient flags before storing', async () => {
    await store.putCatalog(db, 'b.test', { status: 'shopify', products: [{ id: 1 }], cached: true, stale: true, truncated: true, fetchedAt: 1 }, 9);
    const stored = await store.getCatalog(db, 'b.test');
    expect(stored).toEqual({ status: 'shopify', products: [{ id: 1 }], count: 1, fetchedAt: 9 });
  });
});

describe('history', () => {
  it('touches, lists newest first, removes and clears', async () => {
    await store.touchHistory(db, 'a.test', 1);
    await store.touchHistory(db, 'https://www.B.test/', 2);
    expect((await store.listHistory(db)).map(h => h.domain)).toEqual(['b.test', 'a.test']);

    await store.touchHistory(db, 'a.test', 3);
    expect(await store.listHistory(db)).toEqual([{ domain: 'a.test', url: 'a.test', timestamp: 3 }, { domain: 'b.test', url: 'b.test', timestamp: 2 }]);
    expect((await store.listHistory(db, 1)).map(h => h.domain)).toEqual(['a.test']);

    await store.removeHistory(db, 'b.test');
    expect((await store.listHistory(db)).map(h => h.domain)).toEqual(['a.test']);
    await store.clearHistory(db);
    expect(await store.listHistory(db)).toEqual([]);
    expect(await store.touchHistory(db, '')).toBe(false);
  });
});

describe('feedback', () => {
  it('keeps only names and urls and lists oldest first', async () => {
    await store.addFeedback(db, { searchId: 's1', inputUrl: 'https://A.test', rating: 'positive', results: [{ name: 'X', url: 'https://x', extra: 1 }] }, 1);
    await store.addFeedback(db, { searchId: 's2', inputUrl: 'b.test', rating: 'negative', results: null }, 2);
    expect(await store.listFeedback(db)).toEqual([
      { searchId: 's1', inputUrl: 'a.test', rating: 'positive', results: [{ name: 'X', url: 'https://x' }], timestamp: 1 },
      { searchId: 's2', inputUrl: 'b.test', rating: 'negative', results: [], timestamp: 2 }
    ]);
    expect((await store.listFeedback(db, 1)).map(f => f.searchId)).toEqual(['s2']);
    await expect(store.addFeedback(db, { rating: 'meh' })).rejects.toThrow('rating must be positive or negative');
  });
});

describe('drafts', () => {
  it('replaces the same stack, keeps a published url, and forgets per brand', async () => {
    expect(await store.putDraft(db, 'a.test', { name: 'no stack' })).toBeNull();
    const first = await store.putDraft(db, 'a.test', { stackId: 7, name: 'Box', publishedUrl: 'https://ol/box' }, 1);
    expect(first).toEqual([{ stackId: '7', name: 'Box', publishedUrl: 'https://ol/box', createdAt: new Date(1).toISOString() }]);

    const again = await store.putDraft(db, 'a.test', { stackId: '7', name: 'Box v2' }, 2);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ name: 'Box v2', publishedUrl: 'https://ol/box', createdAt: new Date(2).toISOString() });

    await store.putDraft(db, 'a.test', { stackId: '8', name: 'Newer' }, 3);
    expect((await store.listDrafts(db, 'a.test')).map(d => d.stackId)).toEqual(['8', '7']);
    expect(await store.listDrafts(db, 'b.test')).toEqual([]);

    await store.setDraftPublishedUrl(db, 8, 'https://ol/newer');
    expect((await store.listDrafts(db, 'a.test'))[0].publishedUrl).toBe('https://ol/newer');

    await store.putDraft(db, 'b.test', { stackId: '9' }, 4);
    await store.deleteDrafts(db, 'a.test');
    expect(await store.listDrafts(db, 'a.test')).toEqual([]);
    expect(await store.listDrafts(db, 'b.test')).toHaveLength(1);
    await store.deleteDrafts(db, '');
    expect(await store.listDrafts(db, 'b.test')).toEqual([]);
  });
});

describe('listFrequentBrands', () => {
  it('counts the searches each brand was recommended in, most first, above a floor', async () => {
    for (const [domain, brands, at] of [
      ['a.test', ['Graza', 'Olipop', 'Nutr'], 1],
      ['b.test', ['Graza', 'Olipop'], 2],
      ['c.test', ['Graza', 'Olipop', 'MiiR'], 3],
      ['d.test', ['Graza'], 4]
    ]) {
      const search = searchFixture(domain, brands.length);
      search.brands = brands.map(name => ({ name, url: `https://${name.toLowerCase()}.co` }));
      await store.putSearch(db, domain, search, at);
    }
    // An empty search is not a search.
    await store.putSearch(db, 'empty.test', { type: 'empty' }, 5);

    expect(await store.listFrequentBrands(db, { min: 2 })).toEqual([
      { domain: 'graza.co', name: 'Graza', searches: 4 },
      { domain: 'olipop.co', name: 'Olipop', searches: 3 }
    ]);
    expect(await store.listFrequentBrands(db, { min: 2, limit: 1 })).toHaveLength(1);
    // Only the most recent searches count.
    expect(await store.listFrequentBrands(db, { searches: 2, min: 2 })).toEqual([{ domain: 'graza.co', name: 'Graza', searches: 2 }]);
    expect(await store.listFrequentBrands(db, { min: 5 })).toEqual([]);
  });

  const recommend = async (domain, names, at) => {
    const search = searchFixture(domain, names.length);
    search.brands = names.map(name => ({ name, url: `https://${name.toLowerCase()}.co` }));
    await store.putSearch(db, domain, search, at);
  };

  it('serves the stored count until it is FREQUENT_TTL_MS old, then counts again', async () => {
    await recommend('a.test', ['Graza'], 1);
    await recommend('b.test', ['Graza'], 2);
    const first = await store.listFrequentBrands(db, { min: 2 }, 1000);
    expect(first).toEqual([{ domain: 'graza.co', name: 'Graza', searches: 2 }]);

    await recommend('c.test', ['Graza', 'Olipop'], 3);
    await recommend('d.test', ['Olipop'], 4);
    expect(await store.listFrequentBrands(db, { min: 2 }, 1000 + store.FREQUENT_TTL_MS - 1)).toEqual(first);
    expect(await store.listFrequentBrands(db, { min: 2 }, 1000 + store.FREQUENT_TTL_MS)).toEqual([
      { domain: 'graza.co', name: 'Graza', searches: 3 },
      { domain: 'olipop.co', name: 'Olipop', searches: 2 }
    ]);
    // Another window or floor is its own row; a smaller limit is a slice of the stored one.
    expect(await store.listFrequentBrands(db, { searches: 1, min: 1 }, 1000)).toEqual([{ domain: 'olipop.co', name: 'Olipop', searches: 1 }]);
    expect(await store.listFrequentBrands(db, { min: 2, limit: 1 }, 1000 + store.FREQUENT_TTL_MS)).toHaveLength(1);
  });

  it('reads the last searches and their brands, not the whole table', async () => {
    for (let i = 0; i < 60; i++) await recommend(`s${i}.test`, ['Graza', 'Olipop', 'Nutr', 'MiiR', 'Haus'], i);
    let rowsRead = 0;
    const counting = {
      prepare: sql => {
        const wrap = statement => ({
          bind: (...args) => wrap(statement.bind(...args)),
          first: () => statement.first(),
          run: () => statement.run(),
          all: async () => { const result = await statement.all(); rowsRead += result.meta.rows_read; return result; }
        });
        return wrap(db.prepare(sql));
      }
    };
    const brands = await store.listFrequentBrands(counting, { searches: 3, min: 1 });
    expect(brands).toHaveLength(5);
    expect(brands[0].searches).toBe(3);
    // 3 searches and their 15 brands, give or take SQLite's sorting; 360 rows are stored.
    expect(rowsRead).toBeGreaterThan(0);
    expect(rowsRead).toBeLessThan(60);
  });

  it('counts on every call before migration 0006 has made its table', async () => {
    await recommend('a.test', ['Graza'], 1);
    const missing = {
      prepare: sql => sql.includes('frequent_brands')
        ? { bind: () => ({ first: () => Promise.reject(new Error('D1_ERROR: no such table: frequent_brands: SQLITE_ERROR')), run: () => Promise.reject(new Error('D1_ERROR: no such table: frequent_brands: SQLITE_ERROR')) }) }
        : db.prepare(sql)
    };
    expect(await store.listFrequentBrands(missing, { min: 1 })).toEqual([{ domain: 'graza.co', name: 'Graza', searches: 1 }]);
  });

  it('is backfilled by migration 0006 with the same answer the store counts', async () => {
    for (const [domain, names, at] of [
      ['a.test', ['Graza', 'Olipop', 'Nutr'], 1],
      ['b.test', ['Graza', 'Olipop'], 2],
      ['c.test', ['Graza', 'Olipop', 'MiiR'], 3],
      ['d.test', ['Graza', 'Nutr'], 4],
      ['e.test', ['Nutr'], 5]
    ]) await recommend(domain, names, at);
    await db.prepare(migrationStatements().find(sql => sql.startsWith('INSERT OR REPLACE INTO frequent_brands'))).run();
    const backfilled = await db.prepare(`SELECT brands, computed_at FROM frequent_brands WHERE id = '100:3'`).first();
    expect(JSON.parse(backfilled.brands)).toEqual([
      { domain: 'graza.co', name: 'Graza', searches: 4 },
      { domain: 'nutr.co', name: 'Nutr', searches: 3 },
      { domain: 'olipop.co', name: 'Olipop', searches: 3 }
    ]);
    expect(await store.listFrequentBrands(db, {}, backfilled.computed_at)).toEqual(JSON.parse(backfilled.brands));
  });
});

describe('listKnownPartners', () => {
  it('finds the searches that recommended a domain, newest first', async () => {
    const olderSearch = searchFixture('old.test', 1);
    olderSearch.brands[0] = { name: 'Graza', url: 'https://www.graza.co', reasons: ['r1'], bundleIdea: 'idea 1' };
    await store.putSearch(db, 'old.test', olderSearch, 1);

    const newerSearch = searchFixture('new.test', 1);
    newerSearch.brands[0] = { name: 'Graza', url: 'https://graza.co/shop', reasons: ['r2'] };
    await store.putSearch(db, 'new.test', newerSearch, 2);

    // An empty search and a self-recommendation do not count.
    await store.putSearch(db, 'empty.test', { type: 'empty' }, 3);
    const self = searchFixture('graza.co', 1);
    self.brands[0] = { name: 'Graza', url: 'https://graza.co' };
    await store.putSearch(db, 'graza.co', self, 4);

    expect(await store.listKnownPartners(db, 'graza.co')).toEqual([
      { domain: 'new.test', name: 'new.test', url: 'https://new.test', reasons: ['r2'], bundleIdea: null },
      { domain: 'old.test', name: 'old.test', url: 'https://old.test', reasons: ['r1'], bundleIdea: 'idea 1' }
    ]);
    expect(await store.listKnownPartners(db, 'graza.co', 1)).toHaveLength(1);
    expect(await store.listKnownPartners(db, 'nobody.test')).toEqual([]);
  });
});

describe('readThrough', () => {
  const ttl = { shopify: 60_000 };
  const now = Date.now();
  const stored = { status: 'shopify', count: 1, products: [{ id: 1 }], fetchedAt: now };
  const crawled = { status: 'shopify', count: 2, products: [{ id: 1 }, { id: 2 }] };

  function run(overrides = {}) {
    const get = vi.fn(async () => stored);
    const put = vi.fn(async () => true);
    const crawl = vi.fn(async () => crawled);
    return { get, put, crawl, promise: store.readThrough({ db: {}, domain: 'a.test', get, put, ttl, crawl, ...overrides }) };
  }

  it('serves a fresh stored copy without crawling', async () => {
    const { crawl, put, promise } = run();
    expect(await promise).toEqual({ ...stored, cached: true });
    expect(crawl).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('crawls and stores when the copy is stale or missing', async () => {
    const stale = run({ get: vi.fn(async () => ({ ...stored, fetchedAt: now - 120_000 })) });
    expect(await stale.promise).toBe(crawled);
    expect(stale.put).toHaveBeenCalledWith({}, 'a.test', crawled);

    const miss = run({ get: vi.fn(async () => null) });
    expect(await miss.promise).toBe(crawled);
    expect(miss.crawl).toHaveBeenCalledWith('a.test');
  });

  it('skips the read on refresh', async () => {
    const { get, crawl, promise } = run({ refresh: true });
    await promise;
    expect(get).not.toHaveBeenCalled();
    expect(crawl).toHaveBeenCalled();
  });

  it('keeps the stored copy, marked stale, when keep says so', async () => {
    const serp = { status: 'serp', count: 1, products: [{ id: 1 }], fetchedAt: 0 };
    const { put, promise } = run({ get: vi.fn(async () => serp), crawl: vi.fn(async () => ({ status: 'none', products: [] })), keep: store.keepStoredSerp });
    expect(await promise).toEqual({ ...serp, cached: true, stale: true });
    expect(put).not.toHaveBeenCalled();
  });

  it('hands the write to defer when given one', async () => {
    const defer = vi.fn();
    const { put, promise } = run({ get: vi.fn(async () => null), defer });
    await promise;
    expect(defer).toHaveBeenCalledTimes(1);
    expect(defer.mock.calls[0][0]).toBeInstanceOf(Promise);
    expect(put).toHaveBeenCalled();
  });

  it('serves the crawl when the read fails, and just crawls without a db', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = run({ get: vi.fn(async () => { throw new Error('nope'); }) });
    expect(await failing.promise).toBe(crawled);
    warn.mockRestore();

    const bare = run({ db: null });
    expect(await bare.promise).toBe(crawled);
    expect(bare.get).not.toHaveBeenCalled();
    expect(bare.put).not.toHaveBeenCalled();
  });

  it('isFresh needs a numeric fetchedAt and a ttl for the status', () => {
    expect(store.isFresh({ status: 'shopify', fetchedAt: now }, ttl, now)).toBe(true);
    expect(store.isFresh({ status: 'shopify', fetchedAt: now - 60_000 }, ttl, now)).toBe(false);
    expect(store.isFresh({ status: 'none', fetchedAt: now }, ttl, now)).toBe(false);
    expect(store.isFresh({ status: 'shopify' }, ttl, now)).toBe(false);
    expect(store.isFresh(null, ttl, now)).toBe(false);
  });
});
