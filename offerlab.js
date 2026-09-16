/**
 * The finder's connection to OfferLab: sign in over OAuth, then drive the MCP endpoint to turn a
 * set of picked products into a draft collab and a link straight into the builder.
 *
 * Every call to OfferLab goes through the finder's own /api/offerlab/* routes — see
 * shared/offerlab.js for why. The one exception is /demo/brands/:domain, which answers with open
 * CORS and is read here directly.
 */

import { isDeveloper } from './shared/offerlab.js';

const KEY = {
  client: 'offerlab.client',       // the registered public client, stable for this origin
  token: 'offerlab.token',         // session only: gone when the tab closes
  pkce: 'offerlab.pkce',
  returnTo: 'offerlab.returnTo',
  master: 'offerlab.masterTeam',
  drafts: 'offerlab.drafts',
  enabled: 'offerlab.enabled'
};

const MASTER_TEAM_NAME = 'OfferLab Demo';
// Per searched brand, so a booth conversation that ran long does not push out the draft from the
// one before it. Enough for a show day; the store is not a record of anything that matters.
const DRAFTS_PER_BRAND = 20;
// A walk-up brand's catalog import. Generous: it is a whole storefront with images today, and
// OL-3996 will cut it to the products the bundle asked for.
const PROVISION_TIMEOUT_MS = 180000;
const PROVISION_POLL_MS = 3000;
const TEAM_PAGE_SIZE = 100;
const PRODUCT_PAGE_SIZE = 100;

export const state = { account: null, tools: null };

/**
 * Whether this browser gets the OfferLab handoff at all.
 *
 * The finder is shared with people outside the company for the research half — searching brands
 * and reading concepts. The handoff is not for them: it signs in against an internal demo
 * environment they have no account on, so an unflagged visitor must never be offered it. On by
 * default while developing, and turned on elsewhere with ?offerlab=1, which sticks.
 */
export function isEnabled() {
  const asked = new URLSearchParams(location.search).get('offerlab');
  // An explicit no settles it, including on a dev machine — otherwise there is no way to see what
  // a guest sees without deploying.
  if (asked === '0') {
    write(localStorage, KEY.enabled, null);
    return false;
  }
  if (asked === '1') write(localStorage, KEY.enabled, true);

  if (read(localStorage, KEY.enabled)) return true;
  return ['localhost', '127.0.0.1'].includes(location.hostname);
}

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

// Refresh this long before expiry, so a call that starts just under the wire does not land just
// over it.
const TOKEN_REFRESH_MARGIN_MS = 60000;
let refreshing = null;

/**
 * The access token, renewed if it is about to lapse.
 *
 * A booth conversation can outlive a grant, and reconnecting in front of a brand is the kind of
 * thing that ends a demo. Concurrent callers share one in-flight refresh: the pipeline makes
 * several calls in a row, and each spending the same refresh token would invalidate the others.
 */
async function freshToken() {
  const grant = read(sessionStorage, KEY.token);
  if (!grant?.access_token) return null;
  if (!grant.refresh_token || !grant.expiresAt) return grant.access_token;
  if (Date.now() < grant.expiresAt - TOKEN_REFRESH_MARGIN_MS) return grant.access_token;

  refreshing = refreshing || refresh(grant.refresh_token).finally(() => { refreshing = null; });
  return refreshing;
}

async function refresh(refreshToken) {
  try {
    const granted = await api('token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: read(localStorage, KEY.client)?.client_id
      })
    });
    if (!granted.access_token) throw new OfferLabError('OfferLab refused the refresh');
    storeGrant(granted);
    return granted.access_token;
  } catch (err) {
    // A refused refresh is a dead session, not a retryable failure.
    console.warn('[OfferLab] refresh failed, disconnecting:', err.message);
    disconnect();
    return null;
  }
}

// expires_in is seconds from now, which is only meaningful at the moment it arrives.
function storeGrant(granted) {
  write(sessionStorage, KEY.token, {
    ...granted,
    expiresAt: granted.expires_in ? Date.now() + granted.expires_in * 1000 : null
  });
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
/* Drafts already created, per searched brand                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the pitch step reads back (OL-3987). Local storage, not session: the operator closes the
 * tab between conversations and the links have to survive that. Keyed by the searched brand,
 * because that is the brand the pitch is for, whoever else ended up in the bundle.
 */
export function draftsFor(searchedDomain) {
  return read(localStorage, KEY.drafts)?.[searchedDomain] || [];
}

export function rememberDraft(searchedDomain, draft) {
  if (!searchedDomain || !draft?.stackId) return draftsFor(searchedDomain);

  const all = read(localStorage, KEY.drafts) || {};
  // Same stack twice is a rebuild, not a second draft: the newer record replaces the older one.
  const kept = (all[searchedDomain] || []).filter(entry => entry.stackId !== draft.stackId);
  all[searchedDomain] = [{ ...draft, createdAt: new Date().toISOString() }, ...kept].slice(0, DRAFTS_PER_BRAND);
  write(localStorage, KEY.drafts, all);
  return all[searchedDomain];
}

/**
 * The drafts built for one pair. Matched on domain rather than brand name, which is display text
 * and can differ between what the catalog reports and what a recommendation called the brand.
 */
export function draftsForPair(searchedDomain, partnerDomain) {
  if (!searchedDomain || !partnerDomain) return [];
  return draftsFor(searchedDomain).filter(draft => (draft.domains || []).includes(partnerDomain));
}

/** Records the published page against a draft, so the lookup happens once per stack. */
export function rememberPublishedUrl(searchedDomain, stackId, publishedUrl) {
  const all = read(localStorage, KEY.drafts) || {};
  const list = all[searchedDomain] || [];
  const entry = list.find(draft => draft.stackId === stackId);
  if (!entry || entry.publishedUrl === publishedUrl) return;
  entry.publishedUrl = publishedUrl;
  write(localStorage, KEY.drafts, all);
}

/**
 * The bundle's page on the demo store, once the builder has published it. A stack carries an
 * external page per destination; only a published one has a url worth showing.
 */
export async function publishedUrlFor(stackId) {
  const result = await callTool('list_stack_external_pages', { stack_id: stackId, per_page: 20 });
  const page = (result?.data || []).find(entry => entry.published && entry.url);
  return page?.url || null;
}

export function forgetDrafts(searchedDomain) {
  const all = read(localStorage, KEY.drafts) || {};
  if (searchedDomain) delete all[searchedDomain];
  write(localStorage, KEY.drafts, searchedDomain ? all : null);
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

  storeGrant(granted);
  return true;
}

/* -------------------------------------------------------------------------- */
/* MCP                                                                         */
/* -------------------------------------------------------------------------- */

let requestId = 0;

async function rpc(method, params) {
  const bearer = await freshToken();
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

/**
 * Who this token is, and what it may do. Both come from one round trip each and are cached for
 * the session, because neither changes while a token lives.
 *
 * There is no tool that names the user: /api/mcp resolves one from the bearer but exposes nothing
 * about them. list_teams does return the team the token is scoped to, which is the thing an
 * operator actually needs to see before creating a draft in it.
 */
export async function loadAccount() {
  if (state.tools) return state;

  const tools = await rpc('tools/list', {});
  state.tools = (tools?.tools || []).map(tool => tool.name);

  try {
    const teams = await callTool('list_teams', { per_page: 1 });
    state.account = { team: teams?.active_team?.name || null, developer: isDeveloper(state.tools) };
  } catch (err) {
    // The role is the half that gates the UI, and tools/list already answered it.
    console.warn('[OfferLab] could not read the active team:', err.message);
    state.account = { team: null, developer: isDeveloper(state.tools) };
  }
  return state;
}

/**
 * Creating a draft is developer-only, and the admin tools are only listed for a developer.
 * Unknown until loadAccount has run, which is why this answers null rather than false: a caller
 * showing UI on it must not treat "not asked yet" as "not allowed".
 */
export function canCreateDrafts() {
  return state.tools === null ? null : isDeveloper(state.tools);
}

/* -------------------------------------------------------------------------- */
/* Creating a draft bundle                                                     */
/* -------------------------------------------------------------------------- */

const brandCache = new Map();

/** The demo environment's own record of a brand: its team, and whether it can be bundled from. */
export async function demoBrand(domain, host, { fresh = false } = {}) {
  if (!fresh && brandCache.has(domain)) return brandCache.get(domain);
  const response = await fetch(`${host}/demo/brands/${encodeURIComponent(domain)}`);
  const data = await response.json().catch(() => null);
  const brand = response.ok ? data?.brand : null;
  brandCache.set(domain, brand);
  return brand;
}

/**
 * Stands a brand up in the demo environment and waits for it. The POST is fire and forget — the
 * run happens in a job — so readiness comes from polling the same GET the finder already reads.
 */
async function provision(domain, externalIds, host, onProgress) {
  const response = await fetch('/api/offerlab/provision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
    body: JSON.stringify({ domain, external_ids: externalIds })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new OfferLabError(data.error || `Could not start ${domain} (${response.status})`);

  const deadline = Date.now() + PROVISION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, PROVISION_POLL_MS));
    const brand = await demoBrand(domain, host, { fresh: true });
    if (brand?.ready) return brand;
    onProgress(`Still importing ${brand?.name || domain}`);
  }
  throw new OfferLabError(`${domain} is taking longer than expected to import — try again in a moment`);
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
    let brand = await demoBrand(domain, host);
    if (!brand?.ready) {
      // A brand nobody pre-created, or one whose run never finished. Stand it up and wait.
      onProgress(`Setting ${labelFor(picks, domain)} up in OfferLab`);
      brand = await provision(
        domain,
        picks.filter(pick => pick.domain === domain).map(pick => pick.product.id),
        host,
        onProgress
      );
    }
    if (!brand?.team_id) throw new OfferLabError(`${labelFor(picks, domain)} could not be set up in OfferLab`);
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
  return {
    stackId: stack.id,
    url,
    name,
    domains,
    brands: domains.map(domain => labelFor(picks, domain)),
    products: picks.map(pick => ({ title: pick.product.title, brand: labelFor(picks, pick.domain) })),
    productCount: resolved.length
  };
}

function labelFor(picks, domain) {
  return picks.find(pick => pick.domain === domain)?.brandName || domain;
}
