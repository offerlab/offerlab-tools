import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, resetDb } from './helpers/d1.js';
import { liveLibrary, readLibrary, libraryTag, handleLibraryRequest, getLibraryBundles, putLibraryBundle } from '$lib/server/library.js';
import { toRecord, applyClassification } from '$lib/shared/library-snapshot.js';

const STORE = 'demo.example';

// The listing is the record, so what the store says about a bundle (its date included) wins.
const product = (handle, title = 'New Kit', publishedAt = '2026-09-23T10:00:00Z') => ({
  handle, title, vendor: 'Anchor', product_type: 'OfferLab Bundle', tags: ['ol-partner-partner'],
  images: [{ src: `https://cdn.example/${handle}.jpg` }], body_html: '<p>Two brands, one box.</p>',
  published_at: publishedAt
});
const oldKit = () => product('old-kit', 'Old Kit', '2026-09-01T00:00:00Z');

// The snapshot knows one bundle, published before anything the store lists now, with the hash the
// build script would have written for it (the same rule the live read applies).
const snapshot = () => ({
  generatedAt: '2026-09-22T00:00:00Z',
  stores: [STORE],
  categories: ['snacks', 'other'],
  bundles: [{ id: `${STORE}/old-kit`, store: STORE, handle: 'old-kit', name: 'Old Kit', cover: 'https://cdn.example/old.jpg', brands: ['A'], products: [], category: 'snacks', publishedAt: '2026-09-01T00:00:00Z', hash: toRecord(STORE, oldKit()).hash }]
});
const curation = { pin: [], exclude: [] };

// The store lists the snapshot's bundle and one it does not know; Gemini classifies on request.
function stubFetch({ products = [oldKit(), product('new-kit')], classify = null, storeDown = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('/products.json')) {
      if (storeDown) throw new Error('store unreachable');
      return new Response(JSON.stringify({ products }), { status: 200 });
    }
    if (String(url).includes('generativelanguage')) {
      const answer = classify ? classify(JSON.parse(init.body)) : [];
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetchImpl, calls };
}

const ids = library => library.bundles.map(b => b.id);
const classifyCalls = calls => calls.filter(u => u.includes('generativelanguage')).length;

describe('the Showcase library', () => {
  let mf, db;
  beforeAll(async () => { ({ mf, db } = await createTestDb()); });
  afterAll(async () => { await mf.dispose(); });
  beforeEach(async () => { await resetDb(db); });

  it('seeds the table from the snapshot and lays the store\'s new bundle on top, newest first', async () => {
    const { fetchImpl } = stubFetch();
    const library = await liveLibrary({ snapshot: snapshot(), curation, db, apiKey: null, fetchImpl });
    expect(ids(library)).toEqual([`${STORE}/new-kit`, `${STORE}/old-kit`]);
    expect(library.bundles[0]).toMatchObject({ category: 'other', brands: ['Anchor'], teams: ['Anchor', 'Partner'] });
    expect(library.bundles[0]).not.toHaveProperty('partnerTags');
    expect(library.bundles[0]).not.toHaveProperty('classifiedNow');
    expect(library.liveAt).toBeTruthy();
    // The snapshot's bundle is now in the table; the unclassified one is not, so it is tried again.
    expect((await getLibraryBundles(db)).map(b => b.id)).toEqual([`${STORE}/old-kit`]);
  });

  it('classifies a new bundle once, keeps it, and carries the answer next time', async () => {
    const classify = () => [{ handle: 'new-kit', category: 'snacks', brands: ['Brand One', 'Brand Two'], products: ['Bar', 'Chips'] }];
    const first = stubFetch({ classify });
    const one = await liveLibrary({ snapshot: snapshot(), curation, db, apiKey: 'k', fetchImpl: first.fetchImpl });
    expect(one.bundles[0]).toMatchObject({ category: 'snacks', brands: ['Brand One', 'Brand Two'], products: ['Bar', 'Chips'] });
    expect(classifyCalls(first.calls)).toBe(1);
    expect((await getLibraryBundles(db)).map(b => b.id).sort()).toEqual([`${STORE}/new-kit`, `${STORE}/old-kit`]);

    const second = stubFetch({ classify: () => { throw new Error('should not classify again'); } });
    const two = await liveLibrary({ snapshot: snapshot(), curation, db, apiKey: 'k', fetchImpl: second.fetchImpl });
    expect(two.bundles[0]).toMatchObject({ category: 'snacks', brands: ['Brand One', 'Brand Two'] });
    expect(classifyCalls(second.calls)).toBe(0);
  });

  it('dates a bundle unlisted when the store stops listing it, and lists it again when it returns', async () => {
    const classify = () => [{ handle: 'new-kit', category: 'snacks', brands: ['B'], products: [] }];
    await liveLibrary({ snapshot: snapshot(), curation, db, apiKey: 'k', fetchImpl: stubFetch({ classify }).fetchImpl });

    const gone = await liveLibrary({ snapshot: snapshot(), curation, db, apiKey: 'k', fetchImpl: stubFetch({ products: [oldKit()] }).fetchImpl });
    expect(ids(gone)).toEqual([`${STORE}/old-kit`]);
    const stored = await getLibraryBundles(db);
    expect(stored.find(b => b.id === `${STORE}/new-kit`).unlistedAt).toBeTruthy();
    expect(stored.find(b => b.id === `${STORE}/old-kit`).unlistedAt).toBeNull();

    const back = stubFetch({ classify: () => { throw new Error('a returning bundle keeps its answer'); } });
    const again = await liveLibrary({ snapshot: snapshot(), curation, db, apiKey: 'k', fetchImpl: back.fetchImpl });
    expect(ids(again)).toEqual([`${STORE}/new-kit`, `${STORE}/old-kit`]);
    expect((await getLibraryBundles(db)).find(b => b.id === `${STORE}/new-kit`).unlistedAt).toBeNull();
  });

  it('serves what is stored and listed when the store cannot be read', async () => {
    const stored = applyClassification(toRecord(STORE, product('stored-kit', 'Stored Kit')), { category: 'snacks', brands: ['S'], products: [] });
    await putLibraryBundle(db, stored);
    const { fetchImpl } = stubFetch({ storeDown: true });
    const library = await liveLibrary({ snapshot: snapshot(), curation, db, apiKey: 'k', fetchImpl, log: () => {} });
    expect(ids(library)).toEqual([`${STORE}/stored-kit`, `${STORE}/old-kit`]);
  });

  it('works without a database: the snapshot plus what the store lists, nothing remembered', async () => {
    const { fetchImpl } = stubFetch();
    const library = await liveLibrary({ snapshot: snapshot(), curation, db: null, apiKey: null, fetchImpl });
    expect(ids(library)).toEqual([`${STORE}/new-kit`, `${STORE}/old-kit`]);
    expect(await getLibraryBundles(db)).toEqual([]);
  });

  it('honours the curation list', async () => {
    const { fetchImpl } = stubFetch();
    const library = await liveLibrary({ snapshot: snapshot(), curation: { pin: [], exclude: ['new-kit'] }, db, apiKey: null, fetchImpl });
    expect(ids(library)).toEqual([`${STORE}/old-kit`]);
  });

  it('reads the table alone, listed bundles newest first, and the snapshot before the first sync', async () => {
    expect(ids(await readLibrary({ snapshot: snapshot(), db }))).toEqual([`${STORE}/old-kit`]);
    const classify = () => [{ handle: 'new-kit', category: 'snacks', brands: ['B'], products: [] }];
    await liveLibrary({ snapshot: snapshot(), curation, db, apiKey: 'k', fetchImpl: stubFetch({ classify }).fetchImpl });
    await liveLibrary({ snapshot: snapshot(), curation, db, apiKey: 'k', fetchImpl: stubFetch({ products: [product('new-kit')] }).fetchImpl });
    const read = await readLibrary({ snapshot: snapshot(), db });
    expect(ids(read)).toEqual([`${STORE}/new-kit`]);
    expect(read.bundles[0]).not.toHaveProperty('unlistedAt');
    expect(read.readAt).toBeTruthy();
  });

  it('tags a library by its bundles, so the same set carries the same tag and a change a new one', async () => {
    const one = await readLibrary({ snapshot: snapshot(), db });
    expect(libraryTag(one)).toBe(libraryTag(await readLibrary({ snapshot: snapshot(), db })));
    await liveLibrary({ snapshot: snapshot(), curation, db, apiKey: 'k', fetchImpl: stubFetch({ classify: () => [{ handle: 'new-kit', category: 'snacks', brands: ['B'], products: [] }] }).fetchImpl });
    expect(libraryTag(await readLibrary({ snapshot: snapshot(), db }))).not.toBe(libraryTag(one));
  });

  it('answers a plain GET from the table and a sync from the store', async () => {
    const { fetchImpl, calls } = stubFetch({ classify: () => [{ handle: 'new-kit', category: 'snacks', brands: ['B'], products: [] }] });
    const read = await handleLibraryRequest({ method: 'GET', snapshot: snapshot(), curation, db, apiKey: 'k', fetchImpl });
    expect(ids(read.body)).toEqual([`${STORE}/old-kit`]);
    expect(calls).toEqual([]);
    const synced = await handleLibraryRequest({ method: 'GET', snapshot: snapshot(), curation, db, apiKey: 'k', fetchImpl, sync: true });
    expect(ids(synced.body)).toEqual([`${STORE}/new-kit`, `${STORE}/old-kit`]);
    expect(calls.some(u => u.includes('/products.json'))).toBe(true);
    expect(ids((await handleLibraryRequest({ method: 'GET', snapshot: snapshot(), curation, db, apiKey: 'k', fetchImpl })).body)).toEqual([`${STORE}/new-kit`, `${STORE}/old-kit`]);
  });

  it('answers the route: GET only, and the bare snapshot when the sync itself fails', async () => {
    expect((await handleLibraryRequest({ method: 'POST', snapshot: snapshot() })).status).toBe(405);
    expect((await handleLibraryRequest({ method: 'GET', snapshot: null })).status).toBe(500);
    const broken = { ...snapshot(), bundles: null };
    const { status, body } = await handleLibraryRequest({ method: 'GET', snapshot: broken, curation, db: null, fetchImpl: stubFetch().fetchImpl, log: () => {} });
    expect(status).toBe(200);
    expect(body).toBe(broken);
  });
});
