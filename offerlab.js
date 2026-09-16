/**
 * The finder's connection to OfferLab: sign in over OAuth, then drive the MCP endpoint to turn a
 * set of picked products into a draft collab and a link straight into the builder.
 *
 * Every call to OfferLab goes through the finder's own /api/offerlab/* routes — see
 * shared/offerlab.js for why. The one exception is /demo/brands/:domain, which answers with open
 * CORS and is read here directly.
 */

const KEY = {
  client: 'offerlab.client',       // the registered public client, stable for this origin
  token: 'offerlab.token',         // session only: gone when the tab closes
  pkce: 'offerlab.pkce',
  returnTo: 'offerlab.returnTo',
  master: 'offerlab.masterTeam'
};

const MASTER_TEAM_NAME = 'OfferLab Demo';
const TEAM_PAGE_SIZE = 100;
const PRODUCT_PAGE_SIZE = 100;

export const state = { account: null, tools: null };

/* -------------------------------------------------------------------------- */
/* Storage                                                                     */
/* -------------------------------------------------------------------------- */

function read(store, key) {
  try {
    const raw = store.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(store, key, value) {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, JSON.stringify(value));
  } catch { /* private window, or storage disabled */ }
}

export function token() {
  return read(sessionStorage, KEY.token)?.access_token || null;
}

export function isConnected() {
  return Boolean(token());
}

export function disconnect() {
  write(sessionStorage, KEY.token, null);
  state.account = null;
  state.tools = null;
}

/* -------------------------------------------------------------------------- */
/* OAuth: authorization code with PKCE, public client                          */
/* -------------------------------------------------------------------------- */

function randomString(bytes = 48) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

function base64url(bytes) {
  let binary = '';
  new Uint8Array(bytes).forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(digest);
}

// The registered redirect must be one fixed string, so it is the bare origin and path. Whatever
// the operator was looking at is put back afterwards from sessionStorage.
function redirectUri() {
  return `${location.origin}${location.pathname}`;
}

async function api(path, options = {}) {
  const response = await fetch(`/api/offerlab/${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new OfferLabError(data.error_description || data.error || `Request failed (${response.status})`, response.status);
  return data;
}

export class OfferLabError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OfferLabError';
    this.status = status;
  }
}

async function clientId() {
  const uri = redirectUri();
  const saved = read(localStorage, KEY.client);
  if (saved?.client_id && saved.redirect_uri === uri) return saved.client_id;

  const registered = await api('register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uri: uri, client_name: 'OfferLab collab finder' })
  });
  if (!registered.client_id) throw new OfferLabError('OfferLab did not return a client id');
  write(localStorage, KEY.client, { client_id: registered.client_id, redirect_uri: uri });
  return registered.client_id;
}

export async function connect() {
  const { authorize } = await api('config');
  const verifier = randomString();
  const stateToken = randomString(16);

  write(sessionStorage, KEY.pkce, { verifier, state: stateToken });
  write(sessionStorage, KEY.returnTo, location.search + location.hash);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: await clientId(),
    redirect_uri: redirectUri(),
    code_challenge: await challengeFor(verifier),
    code_challenge_method: 'S256',
    state: stateToken,
    scope: 'mcp:read mcp:write'
  });
  location.assign(`${authorize}?${params}`);
}

/**
 * Finishes the flow when the browser comes back with ?code.
 *
 * The finder's own state lives in the query string, and the redirect replaced it. That is put
 * back SYNCHRONOUSLY, before the await, so the rest of the app still reads its own parameters on
 * this load — the exchange can finish afterwards. Resolves false when this is not a callback.
 */
export function completeRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return Promise.resolve(false);

  const pkce = read(sessionStorage, KEY.pkce);
  write(sessionStorage, KEY.pkce, null);
  const returnTo = read(sessionStorage, KEY.returnTo) || '';
  write(sessionStorage, KEY.returnTo, null);
  history.replaceState(null, '', `${location.pathname}${returnTo}`);

  if (!pkce || params.get('state') !== pkce.state) {
    return Promise.reject(new OfferLabError('That sign-in did not match the one this tab started'));
  }
  return exchange(code, pkce.verifier);
}

async function exchange(code, verifier) {
  const granted = await api('token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: read(localStorage, KEY.client)?.client_id,
      code_verifier: verifier
    })
  });
  if (!granted.access_token) throw new OfferLabError(granted.error_description || 'OfferLab did not return a token');

  write(sessionStorage, KEY.token, granted);
  return true;
}

/* -------------------------------------------------------------------------- */
/* MCP                                                                         */
/* -------------------------------------------------------------------------- */

let requestId = 0;

async function rpc(method, params) {
  const bearer = token();
  if (!bearer) throw new OfferLabError('Not connected to OfferLab', 401);

  const response = await fetch('/api/offerlab/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params })
  });
  const body = await response.json().catch(() => ({}));

  if (response.status === 401) {
    disconnect();
    throw new OfferLabError('That OfferLab session expired — connect again', 401);
  }
  if (body.error) throw new OfferLabError(body.error.message || body.error, response.status);
  if (!response.ok) throw new OfferLabError(body.error || `OfferLab returned ${response.status}`, response.status);
  return body.result;
}

/**
 * Every tool answers with one text part holding JSON — a record for a create, {data, pagination}
 * for a list, and {error} when it refused, with isError set alongside. structuredContent is
 * handled too in case a hand-written tool ever uses it.
 */
function unwrap(result) {
  const text = result?.content?.find(part => part.type === 'text')?.text;
  let payload = result?.structuredContent;
  if (payload === undefined && typeof text === 'string') {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (result?.isError) {
    throw new OfferLabError(payload?.error || (typeof payload === 'string' && payload) || 'OfferLab rejected that request');
  }
  return payload === undefined ? result : payload;
}

export async function callTool(name, args = {}) {
  return unwrap(await rpc('tools/call', { name, arguments: args }));
}

/** What the connected account may do. Admin tools present means a developer. */
export async function loadCapabilities() {
  const result = await rpc('tools/list', {});
  state.tools = (result?.tools || []).map(tool => tool.name);
  return state.tools;
}

export function canCreateDrafts() {
  return Boolean(state.tools?.includes('create_stack') && state.tools?.includes('set_active_team'));
}

/* -------------------------------------------------------------------------- */
/* Creating a draft bundle                                                     */
/* -------------------------------------------------------------------------- */

const brandCache = new Map();

/** The demo environment's own record of a brand: its team, and whether it can be bundled from. */
export async function demoBrand(domain, host) {
  if (brandCache.has(domain)) return brandCache.get(domain);
  const response = await fetch(`${host}/demo/brands/${encodeURIComponent(domain)}`);
  const data = await response.json().catch(() => null);
  const brand = response.ok ? data?.brand : null;
  brandCache.set(domain, brand);
  return brand;
}

async function masterTeamId() {
  const cached = read(localStorage, KEY.master);
  if (cached) return cached;

  for (let page = 1; page <= 50; page++) {
    const result = await callTool('list_teams', { page, per_page: TEAM_PAGE_SIZE });
    const teams = result?.teams || [];
    const match = teams.find(team => team.name === MASTER_TEAM_NAME);
    if (match) {
      write(localStorage, KEY.master, match.id);
      return match.id;
    }
    if (teams.length < TEAM_PAGE_SIZE) break;
  }
  throw new OfferLabError(`No "${MASTER_TEAM_NAME}" team on this OfferLab — the demo environment has not been provisioned`);
}

/**
 * Shopify product ids to OfferLab product ids, a brand at a time. The importer stores the id from
 * products.json verbatim on integrations_external_id, which is the same id the picker holds, so
 * the join needs nothing clever.
 */
async function productsForTeam(teamId) {
  await callTool('set_active_team', { team_id: teamId });
  const byExternalId = new Map();
  for (let page = 1; page <= 20; page++) {
    const result = await callTool('list_products', { page, per_page: PRODUCT_PAGE_SIZE });
    const products = result?.data || [];
    products.forEach(product => {
      if (product.integrations_external_id) byExternalId.set(String(product.integrations_external_id), product);
    });
    if (products.length < PRODUCT_PAGE_SIZE) break;
  }
  return byExternalId;
}

/** The builder wants the obfuscated id, which is the last segment of the stack's share url. */
function builderUrl(stack, host) {
  const share = stack?.share_url;
  const id = share ? share.split('/').filter(Boolean).pop() : null;
  return id ? `${host}/account/collabs/${id}/edit` : null;
}

/**
 * Picks in, a draft collab in the master team out, plus the link to open it.
 * `picks` are the picker's own entries: { domain, brandName, product }.
 */
export async function createDraftBundle({ name, picks, onProgress = () => {} }) {
  const { host } = await api('config');
  const domains = [...new Set(picks.map(pick => pick.domain))];

  onProgress('Finding these brands in OfferLab');
  const teams = new Map();
  for (const domain of domains) {
    const brand = await demoBrand(domain, host);
    if (!brand?.team_id) {
      throw new OfferLabError(`${labelFor(picks, domain)} has no team in the demo environment yet`);
    }
    teams.set(domain, brand.team_id);
  }

  onProgress('Matching the products you picked');
  const resolved = [];
  for (const domain of domains) {
    const catalog = await productsForTeam(teams.get(domain));
    for (const pick of picks.filter(p => p.domain === domain)) {
      const product = catalog.get(String(pick.product.id));
      if (!product) throw new OfferLabError(`“${pick.product.title}” is not in ${labelFor(picks, domain)}'s OfferLab catalog`);
      resolved.push(product);
    }
  }

  const master = await masterTeamId();
  await callTool('set_active_team', { team_id: master });

  onProgress('Creating the draft');
  const stack = await callTool('create_stack', { name, product_bundle: true });
  if (!stack?.id) throw new OfferLabError('OfferLab did not return the draft it created');

  onProgress('Adding the products');
  for (const [index, product] of resolved.entries()) {
    await callTool('create_stack_step', { stack_id: stack.id, product_id: product.id, sort_order: index + 1 });
  }

  const url = builderUrl(stack, host);
  if (!url) throw new OfferLabError('The draft was created but OfferLab did not return a link to it');
  return { stackId: stack.id, url, name };
}

function labelFor(picks, domain) {
  return picks.find(pick => pick.domain === domain)?.brandName || domain;
}
