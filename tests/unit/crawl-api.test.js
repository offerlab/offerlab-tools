import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCrawlRequest } from '$lib/server/crawl-api.js';
import { CRAWL_DEFAULTS } from '$lib/server/crawl.js';
import { createTestDb, resetDb } from './helpers/d1.js';

let ctx, db;
beforeAll(async () => {
  ctx = await createTestDb();
  db = ctx.db;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); return ctx.dispose(); });
beforeEach(() => resetDb(db));

const env = { CRAWL_SECRET: 's3cret', CRAWL_DAILY_LIMIT: '10' };
const call = (overrides) => handleCrawlRequest({
  method: 'GET', path: '', authorization: 'Bearer s3cret', body: null, db, env, origin: 'https://finder.test', ...overrides
});

describe('access', () => {
  it('is off without a secret', async () => {
    expect(await call({ env: {} })).toEqual({ status: 503, body: { error: 'The crawl is off: CRAWL_SECRET is not set' } });
  });

  it('refuses a missing or wrong bearer', async () => {
    expect((await call({ authorization: null })).status).toBe(401);
    expect((await call({ authorization: 'Bearer nope' })).status).toBe(401);
    expect((await call({ authorization: 's3cret' })).status).toBe(401);
  });

  it('needs a database', async () => {
    expect(await call({ db: null })).toEqual({ status: 503, body: { error: 'No database bound' } });
  });

  it('has no other routes', async () => {
    expect((await call({ path: 'nope' })).status).toBe(404);
    expect((await call({ path: 'next', method: 'GET' })).status).toBe(404);
  });
});

describe('GET /api/crawl', () => {
  it('answers the queue status with the settings in force', async () => {
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body).toEqual({ counts: {}, searchesToday: 0, settings: { ...CRAWL_DEFAULTS, dailyLimit: 10 }, recent: [] });
  });
});

describe('POST /api/crawl', () => {
  it('queues the domains and rejects an empty list', async () => {
    const queued = await call({ method: 'POST', body: { domains: ['https://www.A.test', 'b.test'], refresh: true } });
    expect(queued).toEqual({ status: 200, body: { queued: ['a.test', 'b.test'] } });
    const { body } = await call();
    expect(body.counts).toEqual({ queued: 2 });
    expect(body.recent.map(r => r.domain).sort()).toEqual(['a.test', 'b.test']);
    expect(body.recent[0].verdict).toEqual({ reason: 'seed', refresh: true });

    expect((await call({ method: 'POST', body: {} })).status).toBe(400);
    expect((await call({ method: 'POST', body: null })).status).toBe(400);
  });
});

describe('POST /api/crawl/next', () => {
  it('is idle with nothing queued', async () => {
    expect(await call({ method: 'POST', path: 'next' })).toEqual({ status: 200, body: { idle: true } });
  });

  it('reports the cap', async () => {
    await call({ method: 'POST', body: { domains: ['a.test'] } });
    const capped = await call({ method: 'POST', path: 'next', env: { ...env, CRAWL_DAILY_LIMIT: '0' } });
    expect(capped).toEqual({ status: 200, body: { capped: true, dailyLimit: 0 } });
  });

  it('runs one step through the app-local fetch and reports what happened', async () => {
    await call({ method: 'POST', body: { domains: ['a.test'] } });
    const fetchImpl = vi.fn(async (url) => new Response(JSON.stringify({ error: 'no key' }), { status: 500 }));
    const { status, body } = await call({ method: 'POST', path: 'next', fetchImpl });
    expect(status).toBe(200);
    expect(body).toMatchObject({ domain: 'a.test', step: 'searching', status: 'queued', error: 'Brand analysis failed: 500 - no key' });
    // The site's own words and catalog are read first to ground the analysis; then Gemini.
    const urls = fetchImpl.mock.calls.map(c => String(c[0]));
    expect(urls[0]).toMatch('https://finder.test/api/opengraph?url=');
    expect(urls.some(u => u.startsWith('https://finder.test/api/gemini'))).toBe(true);
    expect((await call()).body.recent[0]).toMatchObject({ status: 'queued', attempts: 1, outcome: { error: 'Brand analysis failed: 500 - no key' } });
  });
});
