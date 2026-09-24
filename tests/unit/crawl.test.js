import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '$lib/server/db.js';
import { crawlSettings, enqueueSeeds, claimNext, runStep, crawlStatus, CRAWL_DEFAULTS } from '$lib/server/crawl.js';
import { askJev } from '$lib/shared/jev.js';
import { createTestDb, resetDb, searchFixture } from './helpers/d1.js';

// Jev is the one outside call the expand step makes; the rest of the module stays real.
vi.mock('$lib/shared/jev.js', async (importOriginal) => ({ ...(await importOriginal()), askJev: vi.fn() }));

let ctx, db;
beforeAll(async () => {
  ctx = await createTestDb();
  db = ctx.db;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); return ctx.dispose(); });
beforeEach(() => resetDb(db));

const settings = { ...CRAWL_DEFAULTS };
const row = (domain) => db.prepare('SELECT * FROM crawl_queue WHERE domain = ?').bind(domain).first();
const seed = (domain, fields) => db.prepare(
  `INSERT INTO crawl_queue (domain, depth, source_domain, status, priority, attempts, created_at, updated_at, started_at, searched_at)
   VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
).bind(domain, fields.depth ?? 0, fields.status, fields.priority ?? 0, fields.attempts ?? 0, fields.createdAt ?? 1, fields.createdAt ?? 1, fields.startedAt ?? null, fields.searchedAt ?? null).run();

describe('crawlSettings', () => {
  it('reads the caps from the environment and falls back per key', () => {
    expect(crawlSettings()).toEqual(CRAWL_DEFAULTS);
    expect(crawlSettings({ CRAWL_MAX_DEPTH: '2', CRAWL_EXPAND_PER_SEARCH: '3', CRAWL_DAILY_LIMIT: 'lots' }))
      .toEqual({ ...CRAWL_DEFAULTS, maxDepth: 2, expandPerSearch: 3 });
  });
});

describe('enqueueSeeds', () => {
  it('queues canonical domains once at depth 0', async () => {
    const keys = await enqueueSeeds(db, ['https://www.A.test/x', 'a.test', 'b.test', ''], {}, 5);
    expect(keys).toEqual(['a.test', 'b.test']);
    const a = await row('a.test');
    expect(a).toMatchObject({ depth: 0, status: 'queued', priority: 1000, attempts: 0, created_at: 5, source_domain: null });
    expect(JSON.parse(a.verdict)).toEqual({ reason: 'seed', refresh: false });
  });

  it('leaves in-flight rows alone and requeues finished ones', async () => {
    await seed('busy.test', { status: 'searching', attempts: 1, startedAt: 1 });
    await seed('waiting.test', { status: 'queued', priority: 3 });
    await seed('done.test', { status: 'done', attempts: 2, depth: 1 });
    await enqueueSeeds(db, ['busy.test', 'waiting.test', 'done.test'], { refresh: true }, 9);

    expect(await row('busy.test')).toMatchObject({ status: 'searching', attempts: 1, verdict: null });
    expect(await row('waiting.test')).toMatchObject({ status: 'queued', priority: 3, verdict: null });
    const done = await row('done.test');
    expect(done).toMatchObject({ status: 'queued', attempts: 0, depth: 0, priority: 1000, updated_at: 9 });
    expect(JSON.parse(done.verdict).refresh).toBe(true);
  });
});

describe('claimNext', () => {
  const now = 1_000_000;

  it('is null on an empty queue', async () => {
    expect(await claimNext(db, settings, now)).toBeNull();
  });

  it('claims expansions before searches and stamps searched_at on a search', async () => {
    await seed('search.test', { status: 'queued', priority: 1000 });
    await seed('expand.test', { status: 'expand', depth: 1 });

    const first = await claimNext(db, settings, now);
    expect(first).toMatchObject({ domain: 'expand.test', status: 'expanding', attempts: 1, started_at: now, searched_at: null });
    const second = await claimNext(db, settings, now + 1);
    expect(second).toMatchObject({ domain: 'search.test', status: 'searching', attempts: 1, started_at: now + 1, searched_at: now + 1 });
    expect(await claimNext(db, settings, now + 2)).toBeNull();
  });

  it('orders by depth, then priority, then age', async () => {
    await seed('deep.test', { status: 'queued', depth: 1, priority: 999, createdAt: 1 });
    await seed('low.test', { status: 'queued', depth: 0, priority: 1, createdAt: 1 });
    await seed('old.test', { status: 'queued', depth: 0, priority: 5, createdAt: 1 });
    await seed('new.test', { status: 'queued', depth: 0, priority: 5, createdAt: 2 });
    const order = [];
    for (let i = 0; i < 4; i++) order.push((await claimNext(db, settings, now + i)).domain);
    expect(order).toEqual(['old.test', 'new.test', 'low.test', 'deep.test']);
  });

  it('stops claiming searches at the daily cap but still expands', async () => {
    await seed('today.test', { status: 'done', searchedAt: now - 1000 });
    await seed('yesterday.test', { status: 'done', searchedAt: now - 25 * 60 * 60 * 1000 });
    await seed('next.test', { status: 'queued' });
    expect(await claimNext(db, { ...settings, dailyLimit: 1 }, now)).toEqual({ capped: true });
    expect(await claimNext(db, { ...settings, dailyLimit: 2 }, now)).toMatchObject({ domain: 'next.test' });

    await seed('expand.test', { status: 'expand' });
    expect(await claimNext(db, { ...settings, dailyLimit: 1 }, now)).toMatchObject({ domain: 'expand.test', status: 'expanding' });
  });

  it('reclaims a step whose worker went quiet, and the search counts again', async () => {
    await seed('stuck.test', { status: 'searching', attempts: 1, startedAt: now - settings.staleAfterMs - 1, searchedAt: now - settings.staleAfterMs - 1 });
    await seed('working.test', { status: 'expanding', attempts: 1, startedAt: now - 1000 });
    const claimed = await claimNext(db, settings, now);
    expect(claimed).toMatchObject({ domain: 'stuck.test', status: 'searching', attempts: 2, started_at: now, searched_at: now });
    expect(await claimNext(db, settings, now)).toBeNull();
  });
});

// A Gemini reply as /api/gemini relays it.
const gemini = (payload) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }), { status: 200 });
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status });

function fakeApi({ brands = 5, catalogs = true } = {}) {
  // Emerging, so the search has no emerging top-up to make and Gemini is asked exactly twice.
  const recommendations = Array.from({ length: brands }, (_, i) => ({ name: `Brand ${i}`, url: `https://brand${i}.test`, reasons: ['fits'], bundleIdea: 'box', brandStage: 'emerging' }));
  const catalog = (domain) => ({ status: 'shopify', domain, storeUrl: `https://${domain}`, count: 1, products: [{ id: 1, title: 'P', image: 'https://x/p.jpg', price: 5, url: `https://${domain}/products/p` }] });
  return {
    gemini: vi.fn()
      .mockImplementationOnce(async () => gemini({ brandProfile: { name: 'Seed', url: 'https://seed.test', description: 'Seed sells seeds' } }))
      .mockImplementationOnce(async () => gemini({ brands: recommendations, products: [] })),
    catalog: vi.fn(async (domain) => json(catalogs ? catalog(domain) : { status: 'none', domain, count: 0, products: [] })),
    socials: vi.fn(async () => json({ socials: {} })),
    opengraph: vi.fn(async () => json({ imageUrl: null })),
    serp: vi.fn(async () => json({ shopping_results: [] }))
  };
}

describe('runStep: search', () => {
  it('reuses a stored search and moves a seed on to expansion', async () => {
    await store.putSearch(db, 'seed.test', searchFixture('seed.test', 6));
    await seed('seed.test', { status: 'searching', attempts: 1 });
    const result = await runStep(await row('seed.test'), { db, api: fakeApi(), settings });
    expect(result).toEqual({ domain: 'seed.test', step: 'search', status: 'expand', reused: true, partners: 6, withCatalog: 6, serpApiOutOfCredits: false });
    expect(await row('seed.test')).toMatchObject({ status: 'expand', attempts: 0 });
    expect(JSON.parse((await row('seed.test')).outcome).partners).toBe(6);
  });

  it('is done at max depth and fails with too few partners', async () => {
    await store.putSearch(db, 'leaf.test', searchFixture('leaf.test', 6));
    await seed('leaf.test', { status: 'searching', depth: 1, attempts: 1 });
    expect((await runStep(await row('leaf.test'), { db, api: fakeApi(), settings })).status).toBe('done');

    await store.putSearch(db, 'thin.test', searchFixture('thin.test', 2));
    await seed('thin.test', { status: 'searching', attempts: 1 });
    const failed = await runStep(await row('thin.test'), { db, api: fakeApi(), settings });
    expect(failed).toMatchObject({ status: 'failed', partners: 2, error: 'found 2 partners, fewer than 5' });
    expect((await row('thin.test')).status).toBe('failed');
  });

  it('runs the search through the api when nothing is stored and keeps the catalogs', async () => {
    const api = fakeApi();
    await seed('seed.test', { status: 'searching', attempts: 1 });
    const result = await runStep(await row('seed.test'), { db, api, settings });
    expect(result).toMatchObject({ status: 'expand', reused: false, partners: 5, withCatalog: 5 });
    expect(api.gemini).toHaveBeenCalledTimes(2);
    expect(api.serp).not.toHaveBeenCalled();

    const stored = await store.getSearch(db, 'seed.test');
    expect(stored.searchedBrand.name).toBe('Seed');
    expect(stored.brands.map(b => b.url)).toEqual(['https://brand0.test', 'https://brand1.test', 'https://brand2.test', 'https://brand3.test', 'https://brand4.test']);
    expect((await store.getCatalog(db, 'brand3.test')).count).toBe(1);
    expect(await store.getCatalog(db, 'seed.test')).not.toBeNull();
  });

  it('retries a failed step once, then fails it', async () => {
    const broken = () => ({ ...fakeApi(), gemini: vi.fn(async () => json({ error: 'quota' }, 500)) });
    await seed('flaky.test', { status: 'searching', attempts: 1 });
    const first = await runStep(await row('flaky.test'), { db, api: broken(), settings });
    expect(first).toMatchObject({ step: 'searching', status: 'queued', error: 'Brand analysis failed: 500 - quota' });
    expect(await row('flaky.test')).toMatchObject({ status: 'queued', attempts: 1 });

    await db.prepare("UPDATE crawl_queue SET status = 'searching', attempts = 2 WHERE domain = ?").bind('flaky.test').run();
    const second = await runStep(await row('flaky.test'), { db, api: broken(), settings });
    expect(second.status).toBe('failed');
    expect(JSON.parse((await row('flaky.test')).outcome)).toEqual({ error: 'Brand analysis failed: 500 - quota' });
  });
});

describe('runStep: expand', () => {
  const answer = (brand, own, fit) => ({ model: 'jev-test', answers: { kind: { choice: brand >= 0.6 ? 'consumer_brand' : 'retailer', probabilities: { consumer_brand: brand } }, own_products: { noul: own }, fit: { score: fit } } });

  it('is done without a key', async () => {
    await seed('seed.test', { status: 'expanding', attempts: 1 });
    const result = await runStep(await row('seed.test'), { db, jevKey: null, settings });
    expect(result).toMatchObject({ step: 'expand', status: 'done', expanded: false, error: 'TYPESAFE_API_KEY is not set' });
    expect((await row('seed.test')).status).toBe('done');
  });

  it('asks Jev about each new candidate with a catalog and queues the best under the cap', async () => {
    const record = searchFixture('seed.test', 5);
    record.brands[2].catalog = undefined;
    record.brands[4].url = 'https://seed.test/self';
    await store.putSearch(db, 'seed.test', record);
    await store.putSearch(db, 'partner4-seed.test', searchFixture('partner4-seed.test', 1));
    await seed('seed.test', { status: 'expanding', attempts: 1 });

    const verdicts = {
      'https://partner1-seed.test': answer(0.9, 0.8, 2.5),
      'https://partner2-seed.test': answer(0.9, 0.8, 1.0),
      'https://partner4-seed.test': answer(0.9, 0.8, 3.0)
    };
    askJev.mockImplementation(async (key, state) => {
      expect(key).toBe('jev-key');
      const parsed = JSON.parse(state);
      expect(parsed.searched_brand.name).toBe('seed.test');
      expect(parsed.candidate.sample_products).toEqual(['Product 0']);
      return verdicts[parsed.candidate.website];
    });

    const result = await runStep(await row('seed.test'), { db, jevKey: 'jev-key', settings: { ...settings, expandPerSearch: 1 } });
    expect(result).toEqual({ domain: 'seed.test', step: 'expand', status: 'done', expanded: true, judged: 3, queued: ['partner1-seed.test'] });
    expect(askJev).toHaveBeenCalledTimes(2);

    const queued = await row('partner1-seed.test');
    expect(queued).toMatchObject({ status: 'queued', depth: 1, source_domain: 'seed.test', priority: 2.25, attempts: 0 });
    expect(JSON.parse(queued.verdict)).toMatchObject({ reason: 'passed', score: 2.25, answers: { kind: 'consumer_brand', fit: 2.5 } });
    expect(JSON.parse((await row('partner2-seed.test')).verdict).reason).toBe('weak fit');
    expect(JSON.parse((await row('partner3-seed.test')).verdict)).toEqual({ reason: 'no catalog', score: 0, answers: null });
    expect((await row('partner3-seed.test')).status).toBe('skipped');
    expect(await row('partner4-seed.test')).toBeNull();
    expect(await row('seed.test')).toMatchObject({ status: 'done' });
  });

  it('skips over the cap and lets a later search requeue a skipped brand', async () => {
    await store.putSearch(db, 'seed.test', searchFixture('seed.test', 2));
    await seed('seed.test', { status: 'expanding', attempts: 1 });
    askJev.mockImplementation(async (key, state) => JSON.parse(state).candidate.website.includes('partner1') ? answer(0.9, 0.9, 3) : answer(0.9, 0.9, 2));
    const result = await runStep(await row('seed.test'), { db, jevKey: 'k', settings: { ...settings, expandPerSearch: 1 } });
    expect(result.queued).toEqual(['partner1-seed.test']);
    expect(JSON.parse((await row('partner2-seed.test')).verdict).reason).toBe('over the cap of 1 per search');

    const other = searchFixture('other.test', 1);
    other.brands[0].url = 'https://partner2-seed.test';
    await store.putSearch(db, 'other.test', other);
    await seed('other.test', { status: 'expanding', attempts: 1 });
    await runStep(await row('other.test'), { db, jevKey: 'k', settings });
    expect(await row('partner2-seed.test')).toMatchObject({ status: 'queued', source_domain: 'other.test', depth: 1 });
  });
});

describe('crawlStatus', () => {
  it('counts by status and lists recent rows with parsed JSON', async () => {
    await seed('a.test', { status: 'queued', searchedAt: Date.now() });
    await seed('b.test', { status: 'done' });
    await db.prepare("UPDATE crawl_queue SET verdict = '{\"reason\":\"seed\"}', outcome = 'not json' WHERE domain = 'b.test'").run();
    const status = await crawlStatus(db, settings, { limit: 1 });
    expect(status.counts).toEqual({ queued: 1, done: 1 });
    expect(status.searchesToday).toBe(1);
    expect(status.settings).toBe(settings);
    expect(status.recent).toHaveLength(1);
    const b = (await crawlStatus(db, settings)).recent.find(r => r.domain === 'b.test');
    expect(b.verdict).toEqual({ reason: 'seed' });
    expect(b.outcome).toBeNull();
  });
});
