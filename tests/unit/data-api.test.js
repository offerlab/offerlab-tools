import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDataRequest } from '$lib/server/data-api.js';
import { createTestDb, resetDb, searchFixture } from './helpers/d1.js';

let ctx, db;
beforeAll(async () => { ctx = await createTestDb(); db = ctx.db; });
afterAll(() => ctx.dispose());
beforeEach(() => resetDb(db));

const JSON_TYPE = 'application/json; charset=utf-8';
// OfferLab's tools/list for a token: a developer's tools, or a member's.
function offerlab(tools) {
  return vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: tools.map(name => ({ name })) } })));
}
const DEVELOPER = offerlab(['list_products', 'run_qa_seed', 'build_bundle_from_storefronts']);
const STAFF = { authorization: 'Bearer tok_dev', fetchImpl: DEVELOPER };

const call = (method, path, { body = null, query = {}, contentType = body ? JSON_TYPE : '', database = db, authorization = null, vars = {}, fetchImpl } = {}) =>
  handleDataRequest({ method, segments: path.split('/').filter(Boolean), query, body, contentType, db: database, authorization, vars, host: 'https://ol.test', fetchImpl });

describe('guards', () => {
  it('is 503 without a database', async () => {
    expect((await call('GET', 'history', { database: null })).status).toBe(503);
  });

  it('refuses a write that is not JSON, which a cross-origin page can send without a preflight', async () => {
    expect(await call('PUT', 'searches/a.test', { body: { type: 'empty' }, contentType: 'text/plain' })).toEqual({ status: 415, body: { error: 'Writes take application/json' } });
    expect((await call('POST', 'history', { body: { domain: 'a.test' }, contentType: '' })).status).toBe(415);
    expect((await call('PATCH', 'drafts/a.test/1', { body: {}, contentType: 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect((await call('DELETE', 'history', STAFF)).status).toBe(204);
  });

  it('is 404 for unknown routes and 400 for a bad domain or body', async () => {
    expect((await call('GET', 'nothing')).status).toBe(404);
    expect((await call('DELETE', 'searches/a.test')).status).toBe(404);
    expect((await call('GET', 'searches/')).body).toEqual({ error: 'Missing or invalid domain' });
    expect((await call('PUT', 'searches/a.test', { body: 'text' })).status).toBe(400);
  });
});

describe('searches', () => {
  it('stores and serves a search, trimming products on request', async () => {
    const put = await call('PUT', 'searches/https%3A%2F%2Fwww.Graza.co', { body: searchFixture('graza.co', 2, { products: 3 }) });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ domain: 'graza.co', searchId: 'search-graza.co' });

    const get = await call('GET', 'searches/graza.co');
    expect(get.status).toBe(200);
    expect(get.body.brands).toHaveLength(2);
    expect(get.body.brands[0].catalog.products).toHaveLength(3);

    const trimmed = await call('GET', 'searches/graza.co', { query: { products: '1' } });
    expect(trimmed.body.brands[0].catalog.products).toHaveLength(1);
    expect(trimmed.body.brands[0].catalog.truncated).toBe(true);
    const none = await call('GET', 'searches/graza.co', { query: { products: '0' } });
    expect(none.body.brands[0].catalog.products).toEqual([]);

    expect(await call('GET', 'searches/unknown.test')).toEqual({ status: 404, body: { error: 'No search stored for this domain' } });
  });
});

describe('partners', () => {
  it('lists the searches that recommended a domain', async () => {
    const record = searchFixture('a.test', 1);
    record.brands[0].url = 'https://graza.co';
    await call('PUT', 'searches/a.test', { body: record });
    const { status, body } = await call('GET', 'partners/graza.co', { query: { limit: '5' } });
    expect(status).toBe(200);
    expect(body).toEqual([{ domain: 'a.test', name: 'a.test', url: 'https://a.test', reasons: ['fits'], bundleIdea: 'a box' }]);
    expect((await call('GET', 'partners/graza.co/extra')).status).toBe(404);
  });
});

describe('history', () => {
  it('records, lists, removes and clears', async () => {
    expect(await call('POST', 'history', { body: { domain: 'https://A.test' } })).toEqual({ status: 204 });
    await call('POST', 'history', { body: { domain: 'b.test' } });
    expect((await call('POST', 'history', { body: {} })).status).toBe(400);

    const list = await call('GET', 'history', { query: { limit: '1' } });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect((await call('GET', 'history')).body.map(h => h.domain).sort()).toEqual(['a.test', 'b.test']);

    expect(await call('DELETE', 'history/a.test')).toEqual({ status: 204 });
    expect((await call('GET', 'history')).body.map(h => h.domain)).toEqual(['b.test']);
    expect(await call('DELETE', 'history', STAFF)).toEqual({ status: 204 });
    expect((await call('GET', 'history')).body).toEqual([]);
  });

  it('is emptied only by staff: an OfferLab developer or the crawl bearer', async () => {
    await call('POST', 'history', { body: { domain: 'a.test' } });
    const member = offerlab(['list_products', 'create_product']);
    expect(await call('DELETE', 'history')).toEqual({ status: 401, body: { error: 'Sign in to OfferLab to do this' } });
    expect((await call('DELETE', 'history', { authorization: 'Bearer tok_member', fetchImpl: member })).status).toBe(403);
    expect((await call('GET', 'history')).body).toHaveLength(1);
    expect((await call('DELETE', 'history', { authorization: 'Bearer s3cret', vars: { CRAWL_SECRET: 's3cret' } })).status).toBe(204);
    expect((await call('GET', 'history')).body).toEqual([]);
  });
});

describe('feedback', () => {
  it('validates the rating and lists the corpus', async () => {
    expect(await call('POST', 'feedback', { body: { rating: 'meh' } })).toEqual({ status: 400, body: { error: 'rating must be positive or negative' } });
    expect(await call('POST', 'feedback', { body: { searchId: 's', inputUrl: 'a.test', rating: 'positive', results: [{ name: 'X', url: 'https://x' }] } })).toEqual({ status: 204 });
    const { body } = await call('GET', 'feedback');
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ searchId: 's', inputUrl: 'a.test', rating: 'positive', results: [{ name: 'X', url: 'https://x' }] });
  });
});

describe('drafts', () => {
  it('remembers, publishes and forgets drafts per brand', async () => {
    expect(await call('PUT', 'drafts/a.test', { body: { name: 'no id' } })).toEqual({ status: 400, body: { error: 'A draft needs a stackId' } });
    const put = await call('PUT', 'drafts/a.test', { body: { stackId: 'st_1', name: 'Box' } });
    expect(put.status).toBe(200);
    expect(put.body[0]).toMatchObject({ stackId: 'st_1', name: 'Box' });

    expect(await call('PATCH', 'drafts/a.test/st_1', { body: { publishedUrl: 'https://ol/box' } })).toEqual({ status: 204 });
    expect((await call('GET', 'drafts/a.test')).body[0].publishedUrl).toBe('https://ol/box');
    expect((await call('GET', 'drafts/a.test/st_1')).status).toBe(404);

    expect((await call('DELETE', 'drafts/a.test')).status).toBe(401);
    expect((await call('GET', 'drafts/a.test')).body).toHaveLength(1);
    expect(await call('DELETE', 'drafts/a.test', STAFF)).toEqual({ status: 204 });
    expect((await call('GET', 'drafts/a.test')).body).toEqual([]);
    expect((await call('DELETE', 'drafts/a.test/st_1')).status).toBe(404);
    expect((await call('DELETE', 'drafts')).status).toBe(401);
    expect(await call('DELETE', 'drafts', STAFF)).toEqual({ status: 204 });
  });
});
