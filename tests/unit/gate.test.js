import { describe, expect, it, vi } from 'vitest';
import { guardApi, issueSession, readSession, needsSession, sameSecret, isStaffRequest, SESSION_MAX_AGE_S } from '$lib/server/gate.js';
import { renderHistoryRows } from '$lib/client/actions/history_list.js';

const NOW = 1_800_000_000;

function limiter(allow = true) {
  const keys = [];
  return { keys, limit: async ({ key }) => { keys.push(key); return { success: allow }; } };
}

const vars = (extra = {}) => ({ CRAWL_SECRET: 's3cret', GEMINI_API_KEY: 'g', ...extra });
const guard = (overrides) => guardApi({ pathname: '/api/data/history', authorization: null, cookie: undefined, address: '203.0.113.9', vars: vars(), ...overrides });

describe('sameSecret', () => {
  it('matches only the same string', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abd')).toBe(false);
    expect(sameSecret('abc', 'abcd')).toBe(false);
    expect(sameSecret('', null)).toBe(true);
  });
});

describe('sessions', () => {
  it('reads back what it issued, and renews one past half its life', async () => {
    const value = await issueSession('k', NOW);
    expect(await readSession(value, 'k', NOW + 60)).toEqual({ valid: true, renew: false });
    expect(await readSession(value, 'k', NOW + SESSION_MAX_AGE_S * 0.75)).toEqual({ valid: true, renew: true });
  });

  it('refuses a forged, re-dated, expired or foreign one', async () => {
    const value = await issueSession('k', NOW);
    const [, signature] = value.split('.');
    expect((await readSession(value, 'other', NOW)).valid).toBe(false);
    expect((await readSession(`${NOW + 1}.${signature}`, 'k', NOW)).valid).toBe(false);
    expect((await readSession(value, 'k', NOW + SESSION_MAX_AGE_S + 1)).valid).toBe(false);
    expect((await readSession(`${value}.x`, 'k', NOW)).valid).toBe(false);
    expect((await readSession('', 'k', NOW)).valid).toBe(false);
    expect((await readSession(value, '', NOW)).valid).toBe(false);
  });

  it('asks a page to issue one when there is none and a key to sign it', async () => {
    expect(await needsSession(undefined, vars())).toBe(true);
    expect(await needsSession(await issueSession('s3cret'), vars())).toBe(false);
    expect(await needsSession(undefined, {})).toBe(false);
  });

  it('signs with SESSION_SECRET over CRAWL_SECRET', async () => {
    const cookie = await issueSession('session-key');
    expect((await guard({ cookie, vars: vars({ SESSION_SECRET: 'session-key' }) })).refusal).toBeNull();
    expect((await guard({ cookie })).refusal.status).toBe(401);
  });
});

describe('guardApi', () => {
  it('refuses a call without a session', async () => {
    const { refusal } = await guard();
    expect(refusal.status).toBe(401);
  });

  it('lets a session in, counted against the route\'s limiter by address', async () => {
    const api = limiter();
    const gemini = limiter();
    const cookie = await issueSession('s3cret');
    const all = vars({ API_LIMITER: api, GEMINI_LIMITER: gemini, PAID_API_LIMITER: limiter() });
    expect((await guard({ cookie, vars: all })).refusal).toBeNull();
    expect((await guard({ cookie, vars: all, pathname: '/api/gemini' })).refusal).toBeNull();
    expect(api.keys).toEqual(['203.0.113.9']);
    expect(gemini.keys).toEqual(['203.0.113.9']);
  });

  it('answers 429 past the limit', async () => {
    const cookie = await issueSession('s3cret');
    const { refusal } = await guard({ cookie, pathname: '/api/serpapi', vars: vars({ PAID_API_LIMITER: limiter(false) }) });
    expect(refusal.status).toBe(429);
    expect(refusal.headers.get('Retry-After')).toBe('60');
  });

  it('lets the staff bearer in uncounted', async () => {
    const api = limiter();
    expect(isStaffRequest('Bearer s3cret', vars())).toBe(true);
    expect(isStaffRequest('Bearer nope', vars())).toBe(false);
    expect(isStaffRequest('Bearer ', {})).toBe(false);
    expect((await guard({ authorization: 'Bearer s3cret', vars: vars({ API_LIMITER: api }) })).refusal).toBeNull();
    expect(api.keys).toEqual([]);
  });

  it('closes the API of a deployment with a paid key and nothing to sign with', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await guard({ vars: { GEMINI_API_KEY: 'g' } })).refusal.status).toBe(503);
    error.mockRestore();
  });

  it('runs open where there is nothing to guard: a keyless preview, or vite dev', async () => {
    expect((await guard({ vars: { UPSTREAM_API_ORIGIN: 'https://finder.test' } })).refusal).toBeNull();
    expect((await guard({ vars: { GEMINI_API_KEY: 'g' }, dev: true })).refusal).toBeNull();
  });
});

describe('renderHistoryRows', () => {
  it('escapes a stored domain, so it cannot add an attribute', () => {
    const list = { classList: { contains: () => false }, innerHTML: '' };
    renderHistoryRows(list, [{ domain: 'x"onload="alert(1)' }]);
    expect(list.innerHTML).not.toContain('"onload="');
    expect(list.innerHTML).toContain('x&quot;onload=&quot;alert(1)');
  });
});
