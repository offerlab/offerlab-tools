import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, resetDb } from './helpers/d1.js';
import { liveLibrary, handleLibraryRequest, getLiveBundles, putLiveBundle } from '$lib/server/library.js';
import { toRecord, applyClassification } from '$lib/shared/library-snapshot.js';

const STORE = 'demo.example';

const product = (handle, title = 'New Kit') => ({
  handle, title, vendor: 'Anchor', product_type: 'OfferLab Bundle', tags: ['ol-partner-partner'],
  images: [{ src: `https://cdn.example/${handle}.jpg` }], body_html: '<p>Two brands, one box.</p>',
  published_at: '2026-09-23T10:00:00Z'
});

const snapshot = () => ({
  generatedAt: '2026-09-22T00:00:00Z',
  stores: [STORE],
  categories: ['snacks', 'other'],
  bundles: [{ id: `${STORE}/old-kit`, store: STORE, handle: 'old-kit', name: 'Old Kit', cover: 'https://cdn.example/old.jpg', brands: ['A'], products: [], category: 'snacks' }]
});

// The store lists the snapshot's bundle and one it does not know; Gemini classifies on request.
function stubFetch({ products = [product('old-kit', 'Old Kit'), product('new-kit')], classify = null, storeDown = false } = {}) {
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

describe('the live library', () => {
  let mf, db;
  beforeAll(async () => { ({ mf, db } = await createTestDb()); });
  afterAll(async () => { await mf.dispose(); });
  beforeEach(async () => { await resetDb(db); });

  it('lays the store\'s new bundles over the snapshot, newest first, without a key', async () => {
    const { fetchImpl } = stubFetch();
    const library = await liveLibrary({ snapshot: snapshot(), curation: { pin: [], exclude: [] }, db, apiKey: null, fetchImpl });
    expect(library.bundles.map(b => b.id)).toEqual([`${STORE}/new-kit`, `${STORE}/old-kit`]);
    expect(library.bundles[0]).toMatchObject({ category: 'other', brands: ['Anchor'], teams: ['Anchor', 'Partner'] });
    expect(library.bundles[0]).not.toHaveProperty('partnerTags');
    expect(library.liveAt).toBeTruthy();
    // Unclassified, so not remembered: it is tried again next time.
    expect(await getLiveBundles(db)).toEqual([]);
  });

  it('classifies a new bundle once, keeps it in D1 and carries it next time', async () => {
    const classify = () => [{ handle: 'new-kit', category: 'snacks', brands: ['Brand One', 'Brand Two'], products: ['Bar', 'Chips'] }];
    const first = stubFetch({ classify });
    const one = await liveLibrary({ snapshot: snapshot(), curation: { pin: [], exclude: [] }, db, apiKey: 'k', fetchImpl: first.fetchImpl });
    expect(one.bundles[0]).toMatchObject({ category: 'snacks', brands: ['Brand One', 'Brand Two'], products: ['Bar', 'Chips'] });
    expect(first.calls.filter(u => u.includes('generativelanguage'))).toHaveLength(1);
    expect((await getLiveBundles(db)).map(b => b.id)).toEqual([`${STORE}/new-kit`]);

    const second = stubFetch({ classify: () => { throw new Error('should not classify again'); } });
    const two = await liveLibrary({ snapshot: snapshot(), curation: { pin: [], exclude: [] }, db, apiKey: 'k', fetchImpl: second.fetchImpl });
    expect(two.bundles[0]).toMatchObject({ category: 'snacks', brands: ['Brand One', 'Brand Two'] });
    expect(second.calls.filter(u => u.includes('generativelanguage'))).toHaveLength(0);
  });

  it('serves the snapshot plus what is stored when the store cannot be read', async () => {
    const stored = applyClassification(toRecord(STORE, product('stored-kit', 'Stored Kit')), { category: 'snacks', brands: ['S'], products: [] });
    await putLiveBundle(db, stored);
    const { fetchImpl } = stubFetch({ storeDown: true });
    const library = await liveLibrary({ snapshot: snapshot(), curation: { pin: [], exclude: [] }, db, apiKey: 'k', fetchImpl, log: () => {} });
    expect(library.bundles.map(b => b.id)).toEqual([`${STORE}/stored-kit`, `${STORE}/old-kit`]);
  });

  it('honours the curation list', async () => {
    const { fetchImpl } = stubFetch();
    const library = await liveLibrary({ snapshot: snapshot(), curation: { pin: [], exclude: ['new-kit'] }, db, apiKey: null, fetchImpl });
    expect(library.bundles.map(b => b.id)).toEqual([`${STORE}/old-kit`]);
  });

  it('answers the route: GET only, and the bare snapshot when the merge itself fails', async () => {
    expect((await handleLibraryRequest({ method: 'POST', snapshot: snapshot() })).status).toBe(405);
    expect((await handleLibraryRequest({ method: 'GET', snapshot: null })).status).toBe(500);
    // A store that cannot be read is served around; a snapshot with no bundle list breaks the merge itself.
    const broken = { ...snapshot(), bundles: null };
    const { status, body } = await handleLibraryRequest({ method: 'GET', snapshot: broken, curation: { pin: [], exclude: [] }, db: null, fetchImpl: stubFetch().fetchImpl, log: () => {} });
    expect(status).toBe(200);
    expect(body).toBe(broken);
  });
});
