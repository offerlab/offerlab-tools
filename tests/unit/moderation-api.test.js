import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleModerationRequest } from '$lib/server/moderation-api.js';
import * as store from '$lib/server/db.js';
import { createTestDb, resetDb, searchFixture } from './helpers/d1.js';

let ctx, db;
beforeAll(async () => { ctx = await createTestDb(); db = ctx.db; });
afterAll(() => ctx.dispose());
beforeEach(() => resetDb(db));

// OfferLab's tools/list, as the MCP endpoint answers it for a token granting `tools`.
function offerlab(tools, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: tools.map(name => ({ name })) } }), { status }));
}
const DEVELOPER = ['list_products', 'run_qa_seed', 'build_bundle_from_storefronts'];
const MEMBER = ['list_products', 'create_product'];

const call = (overrides) => handleModerationRequest({
  method: 'POST', authorization: 'Bearer tok_1', body: { action: 'hide-products', domain: 'bad.test' }, db, host: 'https://ol.test', fetchImpl: offerlab(DEVELOPER), ...overrides
});

describe('access', () => {
  it('only takes POST and needs a database', async () => {
    expect((await call({ method: 'GET' })).status).toBe(405);
    expect((await call({ db: null })).status).toBe(503);
  });

  it('refuses without a bearer, before asking OfferLab', async () => {
    const fetchImpl = offerlab(DEVELOPER);
    expect(await call({ authorization: null, fetchImpl })).toEqual({ status: 401, body: { error: 'Sign in to OfferLab to moderate results' } });
    expect((await call({ authorization: 'Bearer   ', fetchImpl })).status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a signed-in non-developer and an OfferLab that will not answer', async () => {
    const fetchImpl = offerlab(MEMBER);
    expect(await call({ fetchImpl })).toEqual({ status: 403, body: { error: 'Only OfferLab developers can moderate results' } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://ol.test/api/mcp');
    expect(init.headers.Authorization).toBe('Bearer tok_1');
    expect(JSON.parse(init.body)).toMatchObject({ method: 'tools/list' });

    expect((await call({ fetchImpl: offerlab(DEVELOPER, 401) })).status).toBe(403);
    expect((await call({ fetchImpl: vi.fn(async () => new Response('<html>', { status: 200 })) })).status).toBe(403);
    expect(await store.getCatalog(db, 'bad.test')).toBeNull();
  });
});

describe('actions for a developer', () => {
  it('hides and shows a brand\'s products', async () => {
    await store.putCatalog(db, 'bad.test', { status: 'serp', count: 1, products: [{ id: 1 }] });
    expect(await call()).toEqual({ status: 200, body: { domain: 'bad.test' } });
    expect((await store.getCatalog(db, 'bad.test')).hidden).toBe(true);

    expect(await call({ body: { action: 'show-products', domain: 'https://www.Bad.test' } })).toEqual({ status: 200, body: { domain: 'bad.test' } });
    expect(await store.getCatalog(db, 'bad.test')).toBeNull();
  });

  it('removes a recommendation from one search', async () => {
    await store.putSearch(db, 'graza.co', searchFixture('graza.co', 2));
    const result = await call({ body: { action: 'remove-recommendation', searchDomain: 'graza.co', domain: 'partner1-graza.co' } });
    expect(result).toEqual({ status: 200, body: { searchDomain: 'graza.co', domain: 'partner1-graza.co' } });
    expect((await store.getSearch(db, 'graza.co')).brands.map(b => b.name)).toEqual(['Partner 2']);
  });

  it('answers 400 for an unknown action or a missing domain', async () => {
    expect(await call({ body: { action: 'delete-everything' } })).toEqual({ status: 400, body: { error: 'Unknown action' } });
    expect(await call({ body: null })).toEqual({ status: 400, body: { error: 'Unknown action' } });
    expect(await call({ body: { action: 'hide-products' } })).toEqual({ status: 400, body: { error: 'A brand needs a domain' } });
  });
});
