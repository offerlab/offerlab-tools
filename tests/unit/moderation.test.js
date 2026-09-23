import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as store from '$lib/server/db.js';
import { hideProducts, showProducts, removeRecommendation, isProductsHidden, moderationFor } from '$lib/server/moderation.js';
import { createTestDb, resetDb, searchFixture } from './helpers/d1.js';

let ctx, db;
beforeAll(async () => { ctx = await createTestDb(); db = ctx.db; });
afterAll(() => ctx.dispose());
beforeEach(() => resetDb(db));

describe('hiding products', () => {
  it('clears the catalog, serves it hidden and refuses new writes until shown again', async () => {
    await store.putCatalog(db, 'bad.test', { status: 'serp', count: 1, products: [{ id: 1 }] });
    expect(await hideProducts(db, 'https://www.Bad.test/')).toEqual({ domain: 'bad.test' });
    expect(await isProductsHidden(db, 'bad.test')).toBe(true);

    const hidden = await store.getCatalog(db, 'bad.test');
    expect(hidden).toMatchObject({ status: 'none', domain: 'bad.test', count: 0, products: [], hidden: true });
    expect(typeof hidden.fetchedAt).toBe('number');
    expect(await store.putCatalog(db, 'bad.test', { status: 'shopify', count: 1, products: [{ id: 2 }] })).toBe(false);
    expect(await store.putCatalog(db, 'other.test', { ...hidden })).toBe(false);

    await showProducts(db, 'bad.test');
    expect(await isProductsHidden(db, 'bad.test')).toBe(false);
    expect(await store.getCatalog(db, 'bad.test')).toBeNull();
    expect(await store.putCatalog(db, 'bad.test', { status: 'shopify', count: 1, products: [{ id: 2 }] })).toBe(true);
  });

  it('shows the hidden catalog inside a stored search', async () => {
    await store.putSearch(db, 'graza.co', searchFixture('graza.co', 2));
    await hideProducts(db, 'partner1-graza.co');
    const search = await store.getSearch(db, 'graza.co');
    expect(search.brands[0].catalog).toMatchObject({ hidden: true, products: [], count: 0 });
    expect(search.brands[1].catalog.products).toHaveLength(1);
  });

  it('needs a domain', async () => {
    await expect(hideProducts(db, '')).rejects.toThrow('A brand needs a domain');
  });
});

describe('removing a recommendation', () => {
  it('drops the brand from that search only, and keeps it out when the search runs again', async () => {
    await store.putSearch(db, 'graza.co', searchFixture('graza.co', 2));
    const other = searchFixture('other.test', 1);
    other.brands[0].url = 'https://partner2-graza.co';
    await store.putSearch(db, 'other.test', other);

    expect(await removeRecommendation(db, 'graza.co', 'https://partner2-graza.co')).toEqual({ searchDomain: 'graza.co', domain: 'partner2-graza.co' });
    expect((await store.getSearch(db, 'graza.co')).brands.map(b => b.name)).toEqual(['Partner 1']);
    expect((await store.getSearch(db, 'other.test')).brands).toHaveLength(1);

    await store.putSearch(db, 'graza.co', searchFixture('graza.co', 2));
    expect((await store.getSearch(db, 'graza.co')).brands.map(b => b.name)).toEqual(['Partner 1']);
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM search_brands WHERE search_domain = ?').bind('graza.co').first();
    expect(rows.n).toBe(1);
  });

  it('needs both domains', async () => {
    await expect(removeRecommendation(db, 'graza.co', '')).rejects.toThrow('needs the search and the brand');
  });
});

describe('moderationFor', () => {
  it('answers hidden and removed sets for one search', async () => {
    await hideProducts(db, 'h.test');
    await removeRecommendation(db, 's.test', 'r.test');
    await removeRecommendation(db, 'elsewhere.test', 'x.test');
    const { hidden, removed } = await moderationFor(db, 's.test', ['h.test', 'r.test', 'x.test']);
    expect([...hidden]).toEqual(['h.test']);
    expect([...removed]).toEqual(['r.test']);
    const none = await moderationFor(db, 'nothing.test', []);
    expect(none.hidden.size + none.removed.size).toBe(0);
  });

  it('reads as unmoderated before the migration lands', async () => {
    const noTable = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('D1_ERROR: no such table: moderation'); }, all: async () => { throw new Error('no such table: moderation'); } }) }) };
    expect(await isProductsHidden(noTable, 'a.test')).toBe(false);
    expect((await moderationFor(noTable, 'a.test', ['b.test'])).hidden.size).toBe(0);
  });
});
