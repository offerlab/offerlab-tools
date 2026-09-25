/**
 * The finder's connection to OfferLab: sign in over OAuth, then drive the MCP endpoint to turn a
 * set of picked products into a draft collab and a link straight into the builder.
 *
 * Every call to OfferLab goes through the finder's own /api/offerlab/* routes — see
 * shared/offerlab.js for why. The one exception is /demo/brands/:domain, which answers with open
 * CORS and is read here directly.
 */

import { isDeveloper, canBuildBundles } from '$lib/shared/offerlab.js';
import * as store from './store.js';

const KEY = {
  client: 'offerlab.client',       // the registered public client, stable for this origin
  token: 'offerlab.token',         // every tab and restart: OfferLab's own session outlives a tab
  pkce: 'offerlab.pkce',
  returnTo: 'offerlab.returnTo',
  master: 'offerlab.masterTeam'
};

const MASTER_TEAM_NAME = 'OfferLab Demo';
const MASTER_TEAM_DOMAIN = 'demo.offerlab.com';
const TEAM_PAGE_SIZE = 100;
// A build that has to stand a walk-up brand up. Only the bundle's own products are imported, so
// this is the brand's team, its logo and a handful of products, not a whole storefront.
const BUILD_TIMEOUT_MS = 300000;
const BUILD_POLL_MS = 2000;

const BUILD_TOOL = 'build_bundle_from_storefronts';

export const state = { account: null, tools: null, buildTakesSpecs: false };

/** The OfferLab handoff shows for everyone; signing in is what needs an account. */
export function isEnabled() {
  return true;
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

// The sign-in used to live in sessionStorage, so each new tab or restart started signed out while
// OfferLab itself still had the operator signed in. A grant stored there by an older build moves over.
function readGrant() {
  const legacy = read(sessionStorage, KEY.token);
  if (legacy) {
    write(localStorage, KEY.token, legacy);
    write(sessionStorage, KEY.token, null);
  }
  return read(localStorage, KEY.token);
}

export function token() {
  return readGrant()?.access_token || null;
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
export async function freshToken() {
  const grant = readGrant();
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
    // Another tab may have spent this refresh token first; its fresh grant is ours too.
    const current = readGrant();
    if (current?.refresh_token && current.refresh_token !== refreshToken) return current.access_token;
    // A refused refresh is a dead session, not a retryable failure.
    console.warn('[OfferLab] refresh failed, disconnecting:', err.message);
    disconnect();
    return null;
  }
}

// expires_in is seconds from now, which is only meaningful at the moment it arrives.
function storeGrant(granted) {
  write(localStorage, KEY.token, {
    ...granted,
    expiresAt: granted.expires_in ? Date.now() + granted.expires_in * 1000 : null
  });
}

export function isConnected() {
  return Boolean(token());
}

export function disconnect() {
  write(localStorage, KEY.token, null);
  write(sessionStorage, KEY.token, null);
  state.account = null;
  state.tools = null;
}

/* -------------------------------------------------------------------------- */
/* Drafts already created, per searched brand                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the pitch step reads back (OL-3987). In the data store, not the browser: the operator
 * closes the tab between conversations, and the next booth may be a different laptop. Keyed by
 * the searched brand, because that is the brand the pitch is for, whoever else ended up in the
 * bundle. Newest first, capped per brand by the store.
 */
export function draftsFor(searchedDomain) {
  if (!searchedDomain) return Promise.resolve([]);
  return store.loadDrafts(searchedDomain);
}

/** Same stack twice is a rebuild, not a second draft: the newer record replaces the older one. */
export async function rememberDraft(searchedDomain, draft) {
  if (!searchedDomain || !draft?.stackId) return draftsFor(searchedDomain);
  return (await store.saveDraft(searchedDomain, draft)) || [];
}

/**
 * The drafts built for one pair. Matched on domain rather than brand name, which is display text
 * and can differ between what the catalog reports and what a recommendation called the brand.
 */
export async function draftsForPair(searchedDomain, partnerDomain) {
  if (!searchedDomain || !partnerDomain) return [];
  return (await draftsFor(searchedDomain)).filter(draft => (draft.domains || []).includes(partnerDomain));
}

/** Records the published page against a draft, so the lookup happens once per stack. */
export function rememberPublishedUrl(searchedDomain, stackId, publishedUrl) {
  if (!searchedDomain || !stackId || !publishedUrl) return Promise.resolve(false);
  return store.markDraftPublished(searchedDomain, stackId, publishedUrl);
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
  return store.clearDrafts(searchedDomain);
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
  // What the build tool takes, so a pick with no storefront is offered only where it can be built.
  const build = (tools?.tools || []).find(tool => tool.name === BUILD_TOOL);
  state.buildTakesSpecs = Boolean(build?.inputSchema?.properties?.products);

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
 * Whether this token can actually build a bundle, which is narrower than being a developer: it
 * asks for the tool the handoff calls rather than for the role that usually carries it.
 * Unknown until loadAccount has run, which is why this answers null rather than false: a caller
 * showing UI on it must not treat "not asked yet" as "not allowed".
 */
export function canCreateDrafts() {
  return state.tools === null ? null : canBuildBundles(state.tools);
}

/**
 * Whether the build can be handed a product as a description (name, price, picture) rather than a
 * storefront URL, which is what a Google Shopping product is. Null until loadAccount has run.
 */
export function buildTakesSpecs() {
  return state.tools === null ? null : Boolean(state.buildTakesSpecs);
}

/* -------------------------------------------------------------------------- */
/* Creating a draft bundle                                                     */
/* -------------------------------------------------------------------------- */

const brandCache = new Map();

let hostPromise = null;

/** The OfferLab this build talks to. Configured server-side, so it is asked for once and kept. */
export function host() {
  hostPromise = hostPromise || api('config').then(config => config.host);
  return hostPromise;
}

/** The demo environment's own record of a brand: its team, and whether it can be bundled from. */
export async function demoBrand(domain, hostUrl, { fresh = false } = {}) {
  if (!fresh && brandCache.has(domain)) return brandCache.get(domain);
  const base = hostUrl || await host();
  const response = await fetch(`${base}/demo/brands/${encodeURIComponent(domain)}`);
  const data = await response.json().catch(() => null);
  const brand = response.ok ? data?.brand : null;
  brandCache.set(domain, brand);
  return brand;
}

/**
 * The master team owns every bundle. Found by its website first, which is one call: OL-4012 sets
 * that to the demo store and list_teams can filter on it. The scan by name is the fallback for an
 * OfferLab where that seed has not run, and it pages, because the roster puts hundreds of brand
 * teams in front of it.
 */
async function masterTeamId() {
  const cached = read(localStorage, KEY.master);
  if (cached) return cached;

  const byDomain = await callTool('list_teams', { domain: MASTER_TEAM_DOMAIN }).catch(() => null);
  const found = (byDomain?.teams || [])[0];
  if (found?.id) {
    write(localStorage, KEY.master, found.id);
    return found.id;
  }

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
  throw new OfferLabError(`No "${MASTER_TEAM_NAME}" team on this OfferLab \u2014 the demo environment has not been provisioned`);
}

/**
 * Which brand the bundle presents as is not stored anywhere: OfferLab reads it off the bundle's
 * FIRST step, so whichever product leads decides whose name and avatar the bundle carries. The
 * searched brand leads, because the bundle is being pitched to them (OL-4009).
 *
 * Selection order is kept within each group, so a pick of two from the searched brand still reads
 * in the order they were chosen.
 */
function presentingOrder(picks, presentingDomain) {
  if (!presentingDomain) return picks;
  const lead = picks.filter(pick => pick.domain === presentingDomain);
  return lead.length ? [...lead, ...picks.filter(pick => pick.domain !== presentingDomain)] : picks;
}

/** The four steps the build reports, as something an operator can read over someone's shoulder. */
const BUILD_STEP_COPY = {
  finding_brand: brand => (brand ? `Finding ${brand}` : 'Finding the brands'),
  importing_products: brand => (brand ? `Importing ${brand}'s products` : 'Importing the products'),
  linking_collaboration: brand => (brand ? `Connecting ${brand}` : 'Connecting the brands'),
  creating_bundle: () => 'Creating the bundle'
};

function stepMessage(progress) {
  const copy = BUILD_STEP_COPY[progress?.step];
  return copy ? copy(progress.brand) : 'Building the bundle';
}

/**
 * Nothing is built when a product cannot be found or cannot go live, so the message names what
 * stopped it rather than reporting a count against a bundle that does not exist.
 */
function buildFailure(status, result) {
  const failures = Array.isArray(result?.failures) ? result.failures : [];
  if (failures.length) {
    const [first] = failures;
    const rest = failures.length > 1 ? ` (and ${failures.length - 1} more)` : '';
    // The reason usually names the brand already.
    const who = first.brand && !String(first.reason || '').startsWith(first.brand) ? `${first.brand}: ` : '';
    return `${who}${first.reason || 'could not be set up'}${rest}`;
  }
  return status?.error_message || 'OfferLab could not build that bundle';
}

/**
 * The build runs in a job, so readiness comes from polling. Each poll carries the step and the
 * brand it is on, which is what the operator is shown rather than an anonymous spinner.
 */
async function awaitBuild(actionId, onProgress) {
  const deadline = Date.now() + BUILD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, BUILD_POLL_MS));
    const status = await callTool('get_action_status', { action_type: 'build_bundle', action_id: actionId });

    if (status?.state === 'completed') return status.result || {};
    if (status?.state === 'failed') throw new OfferLabError(buildFailure(status, status?.result));
    onProgress(stepMessage(status?.result));
  }
  throw new OfferLabError('That bundle is taking longer than expected \u2014 check OfferLab in a moment');
}

/**
 * Picks in, a draft collab in the master team out, plus the link to open it.
 * `picks` are the picker's own entries: { domain, brandName, product }.
 *
 * One call does the whole thing. build_bundle_from_storefronts finds or creates each brand's team,
 * imports only the products this bundle asked for, takes them live, opens them to the active team
 * and builds the stack. The finder's job is the active team, the order, and the waiting.
 */
export async function createDraftBundle({ name, picks, presentingDomain, onProgress = () => {} }) {
  // The bundle belongs to the master team, and it is the team every brand's products are opened
  // to, so it has to be active before the build starts.
  const master = await masterTeamId();
  await callTool('set_active_team', { team_id: master });

  const ordered = presentingOrder(picks, presentingDomain);

  onProgress('Starting the build');
  // Every pick goes as a description with its storefront URL where it has one: the build takes
  // the storefront's product when the storefront lists it and creates it from the description
  // when it does not (unlisted since the crawl, found through Google Shopping, or a stand-in for
  // a brand with no catalog). An OfferLab that takes only URLs gets only those, and cannot be
  // given any of the others at all.
  const specs = state.buildTakesSpecs;
  const fromStorefront = pick => pick.storefront !== false;
  if (!specs && ordered.some(pick => !fromStorefront(pick))) {
    throw new OfferLabError('This OfferLab cannot build from products without a storefront yet');
  }
  const started = await callTool(BUILD_TOOL, specs
    ? { products: ordered.map(specFor), ...(name ? { name } : {}) }
    : { product_urls: ordered.map(pick => pick.product.url), ...(name ? { name } : {}) });
  if (!started?.action_id) throw new OfferLabError('OfferLab did not start that build');

  const result = await awaitBuild(started.action_id, onProgress);
  if (!result.builder_url) throw new OfferLabError('The bundle was built but OfferLab did not return a link to it');

  const domains = [...new Set(ordered.map(pick => pick.domain))];
  return {
    stackId: result.stack_id ?? null,
    url: result.builder_url,
    name: result.name || name,
    domains,
    brands: domains.map(domain => labelFor(ordered, domain)),
    products: ordered.map(pick => ({ title: pick.product.title, brand: labelFor(ordered, pick.domain) })),
    productCount: ordered.length
  };
}

function labelFor(picks, domain) {
  return picks.find(pick => pick.domain === domain)?.brandName || domain;
}

/** A pick as the build's spec: the brand's site, the product, and its storefront URL if it has one. */
function specFor(pick) {
  const { product } = pick;
  const price = Number(product.price);
  return {
    website: `https://${pick.domain}`,
    name: product.title,
    url: pick.storefront === false ? undefined : product.url,
    price: Number.isFinite(price) && price > 0 ? price : undefined,
    image_url: product.image || undefined,
    description: product.description || undefined
  };
}
