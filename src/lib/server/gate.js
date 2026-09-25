/**
 * Who may call /api/*. The finder has no sign-in of its own, so the gate asks for one of two things:
 *
 * - The session cookie the page sets when it loads (HttpOnly, signed, 30 days, renewed as it is
 *   used). A browser that opened the finder has it; a script aimed at /api/* from outside does not,
 *   and with no allow-origin header another site's page cannot borrow a visitor's.
 * - `Authorization: Bearer <CRAWL_SECRET>`: the cron, `npm run crawl`, and a local dev server or
 *   branch preview forwarding to production (UPSTREAM_API_TOKEN, src/lib/server/api.js).
 *
 * The cookie is cheap to get (load the page), so it is not the whole defence: every browser call
 * is also counted against a per-address rate limit (the Workers rate limiting bindings in
 * wrangler.jsonc), tighter on the routes that spend a paid key. The signing key is SESSION_SECRET,
 * or CRAWL_SECRET when that is not set. A deployment holding a paid key but no signing key refuses
 * the API rather than serving it open; a keyless one (a branch preview, `vite dev`) holds nothing
 * worth guarding and forwards its paid calls to a deployment that is guarded.
 */

export const SESSION_COOKIE = 'finder_session';
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
// A session past half its life is issued again on its next request, so an open tab never expires.
const RENEW_AFTER_S = SESSION_MAX_AGE_S / 2;

const PAID_KEYS = ['GEMINI_API_KEY', 'SERP_API_KEY', 'OPENGRAPH_API_KEY', 'TYPESAFE_API_KEY'];

// Which rate limiter counts a route. A search makes about five Gemini calls and a hundred others,
// mostly catalogs, socials and Jev grades; the limits leave room for a few people searching at
// once from one address (a trade-show booth shares one) and none for a script left running.
const LIMITERS = [
  { prefix: '/api/gemini', binding: 'GEMINI_LIMITER' },
  { prefix: '/api/serpapi', binding: 'PAID_API_LIMITER' },
  { prefix: '/api/opengraph', binding: 'PAID_API_LIMITER' },
  { prefix: '/api/jev', binding: 'PAID_API_LIMITER' }
];
const DEFAULT_LIMITER = 'API_LIMITER';

const encoder = new TextEncoder();

function base64url(buffer) {
  let text = '';
  for (const byte of new Uint8Array(buffer)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(secret, text) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
}

/** Compares two strings in time that does not depend on where they differ. */
export function sameSecret(a, b) {
  const left = encoder.encode(String(a ?? ''));
  const right = encoder.encode(String(b ?? ''));
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

export function sessionSecret(vars) {
  return vars.SESSION_SECRET || vars.CRAWL_SECRET || '';
}

/** A fresh session cookie value: when it was issued, and the signature over that. */
export async function issueSession(secret, nowS = Math.floor(Date.now() / 1000)) {
  return `${nowS}.${await sign(secret, `finder-session.${nowS}`)}`;
}

/** `{ valid, renew }` for a cookie value: whether it is ours and current, and whether to issue it again. */
export async function readSession(value, secret, nowS = Math.floor(Date.now() / 1000)) {
  const [issued, signature, extra] = String(value || '').split('.');
  const issuedS = Number(issued);
  if (!secret || extra !== undefined || !signature || !/^\d+$/.test(issued || '')) return { valid: false, renew: true };
  const age = nowS - issuedS;
  if (age < -300 || age > SESSION_MAX_AGE_S) return { valid: false, renew: true };
  if (!sameSecret(signature, await sign(secret, `finder-session.${issuedS}`))) return { valid: false, renew: true };
  return { valid: true, renew: age > RENEW_AFTER_S };
}

/** Whether the request carries the staff bearer, CRAWL_SECRET. */
export function isStaffRequest(authorization, vars) {
  return Boolean(vars.CRAWL_SECRET) && sameSecret(authorization || '', `Bearer ${vars.CRAWL_SECRET}`);
}

function limiterFor(pathname) {
  return LIMITERS.find(({ prefix }) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.binding || DEFAULT_LIMITER;
}

function refuse(status, error, headers = {}) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
  });
}

/**
 * The gate for one /api/* request. Answers the refusal to send, or null to let it through;
 * `renew` asks the caller to issue the session again on the way out.
 *
 * @param {object} req
 * @param {string} req.pathname
 * @param {string|null} req.authorization
 * @param {string|undefined} req.cookie     the session cookie's value
 * @param {string} req.address              the caller's address, the rate limit's key
 * @param {Record<string, any>} req.vars    the Worker's env: secrets and rate limiting bindings
 * @param {boolean} [req.dev]               `vite dev`, which runs open without a signing key
 * @returns {Promise<{ refusal: Response|null, renew: boolean }>}
 */
export async function guardApi({ pathname, authorization, cookie, address, vars, dev = false }) {
  if (isStaffRequest(authorization, vars)) return { refusal: null, renew: false };

  const secret = sessionSecret(vars);
  if (!secret) {
    if (dev || !PAID_KEYS.some(name => vars[name])) return { refusal: null, renew: false };
    console.error('[Gate] A paid API key is set but no SESSION_SECRET or CRAWL_SECRET: the API is closed');
    return { refusal: refuse(503, 'Server misconfiguration'), renew: false };
  }

  const session = await readSession(cookie, secret);
  if (!session.valid) return { refusal: refuse(401, 'No session: reload the page'), renew: false };

  const limiter = vars[limiterFor(pathname)];
  if (limiter && address) {
    const { success } = await limiter.limit({ key: address });
    if (!success) return { refusal: refuse(429, 'Too many requests: try again in a minute', { 'Retry-After': '60' }), renew: false };
  }
  return { refusal: null, renew: session.renew };
}

/** Whether a page request should carry a new session cookie out: none yet, a stale one, or one past half its life. */
export async function needsSession(cookie, vars) {
  const secret = sessionSecret(vars);
  if (!secret) return false;
  return (await readSession(cookie, secret)).renew;
}
