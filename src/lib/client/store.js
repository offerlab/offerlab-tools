/**
 * The browser's side of the data store. Everything the finder used to keep in localStorage
 * (searches and their catalogs, search history, feedback, OfferLab drafts) lives in Cloudflare
 * D1 behind /api/data/*; this module is the only place the app talks to it.
 *
 * Every call is fail-soft: when the store is unreachable, or no database is bound yet, it logs
 * once and answers with an empty value, so a search still runs and renders. It just is not
 * remembered.
 */

const BASE = '/api/data';

let warned = false;
function warnOnce(err) {
  if (warned) return;
  warned = true;
  console.warn('[Store] Data store unavailable; this session is not being persisted:', err?.message || err);
}

async function call(path, { method = 'GET', body, query, notFoundOk = false } = {}) {
  const url = new URL(`${BASE}/${path}`, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  // Only a lookup by key may answer 404; anywhere else it means the route itself is missing.
  if (response.status === 404 && notFoundOk) return null;
  if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}`);
  if (response.status === 204) return true;
  return response.json();
}

async function attempt(fallback, work) {
  try {
    return await work();
  } catch (err) {
    warnOnce(err);
    return fallback;
  }
}

/* -------------------------------------------------------------------------- */
/* Searches                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The stored search for a domain, or null. `products` caps the catalog products that come back
 * per brand; a brand with more has `catalog.truncated` set, and /api/catalog serves the rest.
 */
export function loadSearch(domain, { products } = {}) {
  return attempt(null, () => call(`searches/${encodeURIComponent(domain)}`, { query: { products }, notFoundOk: true }));
}

/** Stores a finished search: `{ type, searchId, searchedBrand, brands, serpApiOutOfCredits, errorMessage }`. */
export function saveSearch(domain, record) {
  return attempt(null, () => call(`searches/${encodeURIComponent(domain)}`, { method: 'PUT', body: record }));
}

/**
 * Applies a staff correction: `{ action, domain, searchDomain }` with the caller's OfferLab token.
 * Unlike the rest of this module it throws, because the person who clicked needs to know.
 */
export async function moderate(body, offerlabToken) {
  const response = await fetch('/api/moderation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${offerlabToken}` },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Moderation failed: HTTP ${response.status}`);
  return result;
}

/** Brands whose own search recommended this domain; empty when there are none or no store. */
export function loadKnownPartners(domain) {
  return attempt([], () => call(`partners/${encodeURIComponent(domain)}`));
}

/** The brands the finder recommends most, so a search reaches past them. */
export function loadFrequentBrands() {
  return attempt([], () => call('frequent'));
}

/* -------------------------------------------------------------------------- */
/* Search history                                                              */
/* -------------------------------------------------------------------------- */

/** The recent searches, or null when the store did not answer, so a caller can keep what it has. */
export function loadHistory(limit) {
  return attempt(null, () => call('history', { query: { limit } }));
}

export function addHistory(domain) {
  return attempt(false, () => call('history', { method: 'POST', body: { domain } }));
}

export function removeHistory(domain) {
  return attempt(false, () => call(`history/${encodeURIComponent(domain)}`, { method: 'DELETE' }));
}

export function clearHistory() {
  return attempt(false, () => call('history', { method: 'DELETE' }));
}

/* -------------------------------------------------------------------------- */
/* Feedback                                                                    */
/* -------------------------------------------------------------------------- */

export function loadFeedback(limit) {
  return attempt([], async () => (await call('feedback', { query: { limit } })) || []);
}

export function addFeedback({ searchId, inputUrl, rating, results }) {
  return attempt(false, () => call('feedback', { method: 'POST', body: { searchId, inputUrl, rating, results } }));
}

/* -------------------------------------------------------------------------- */
/* OfferLab drafts                                                             */
/* -------------------------------------------------------------------------- */

export function loadDrafts(searchedDomain) {
  return attempt([], async () => (await call(`drafts/${encodeURIComponent(searchedDomain)}`, { notFoundOk: true })) || []);
}

/** Remembers a draft and answers with the brand's drafts, newest first. */
export function saveDraft(searchedDomain, draft) {
  return attempt(null, () => call(`drafts/${encodeURIComponent(searchedDomain)}`, { method: 'PUT', body: draft }));
}

export function markDraftPublished(searchedDomain, stackId, publishedUrl) {
  return attempt(false, () => call(`drafts/${encodeURIComponent(searchedDomain)}/${encodeURIComponent(stackId)}`, { method: 'PATCH', body: { publishedUrl } }));
}

export function clearDrafts(searchedDomain) {
  return attempt(false, () => call(searchedDomain ? `drafts/${encodeURIComponent(searchedDomain)}` : 'drafts', { method: 'DELETE' }));
}
