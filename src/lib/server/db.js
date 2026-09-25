/**
 * The finder's data store, on Cloudflare D1.
 *
 * Every function takes a D1-shaped database first: `prepare(sql).bind(...).first()/all()/run()`
 * and `batch([...])`. On Pages that is `env.DB`; the Express dev server passes the SQLite
 * adapter from shared/sqlite-d1.js, which speaks the same subset. Runtime-neutral otherwise.
 *
 * Schema: migrations/0001_init.sql; the well-trodden list's stored answer, 0006_frequent_brands.sql.
 */
import { normalizeDomain } from '$lib/shared/catalog.js';
import { HIDDEN_CATALOG, isProductsHidden, moderationFor } from './moderation.js';

/** How many products a stored search hands back per brand unless the caller asks for more. */
export const DEFAULT_PRODUCTS_PER_BRAND = 24;
/** The recent searches the omnibar dropdown lists. */
export const DEFAULT_HISTORY_LIMIT = 10;
/** How much of the feedback corpus the recommender reads back. */
export const DEFAULT_FEEDBACK_LIMIT = 100;
/** Brands from past searches handed to the recommender as known partners. */
export const DEFAULT_KNOWN_PARTNERS = 8;
/** Drafts kept per searched brand, newest first. */
export const DRAFTS_PER_BRAND = 20;
/** The well-trodden set: brands recommended in at least this many of the last N searches. */
export const FREQUENT_SEARCHES = 100;
export const FREQUENT_MIN = 3;
export const DEFAULT_FREQUENT_LIMIT = 25;
/** How long a counted list is served before the next caller counts again. */
export const FREQUENT_TTL_MS = 30 * 60 * 1000;
/** The most a counted list keeps: the data route's cap on `limit`. */
export const FREQUENT_KEPT = 100;

/** "https://www.Graza.co/pages/x" -> "graza.co": the key every table shares. */
export function canonicalDomain(input) {
  return normalizeDomain(input).replace(/^www\./, '');
}

function parse(json, fallback = null) {
  if (json == null) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

/* -------------------------------------------------------------------------- */
/* Catalogs and socials: one row per crawled domain                             */
/* -------------------------------------------------------------------------- */

const EMPTY_CATALOG = (domain) => ({ status: 'none', domain, storeUrl: null, count: 0, products: [] });

/** The stored catalog for a domain, or null. Products are the whole list. */
export async function getCatalog(db, domain) {
  const key = canonicalDomain(domain);
  if (!key) return null;
  // Staff hid this brand's products: served empty, and fresh, so nothing crawls it again.
  if (await isProductsHidden(db, key)) return { ...HIDDEN_CATALOG(key), fetchedAt: Date.now() };
  const row = await db.prepare('SELECT payload, fetched_at FROM catalogs WHERE domain = ?').bind(key).first();
  if (!row) return null;
  const catalog = parse(row.payload);
  return catalog ? { ...catalog, fetchedAt: row.fetched_at } : null;
}

/**
 * Stores a crawled catalog. An error is not a catalog: it is left out so the next request
 * crawls again rather than remembering a timeout.
 */
export async function putCatalog(db, domain, catalog, now = Date.now()) {
  const key = canonicalDomain(domain);
  if (!key || !catalog || catalog.status === 'error' || catalog.hidden) return false;
  if (await isProductsHidden(db, key)) return false;
  const { fetchedAt, cached, stale, truncated, ...record } = catalog;
  const products = Array.isArray(record.products) ? record.products : [];
  if (!products.length) {
    const existing = await db.prepare('SELECT status, count FROM catalogs WHERE domain = ?').bind(key).first();
    if (keepStoredSerp(existing, record)) return false;
  }
  const payload = JSON.stringify({ ...record, count: record.count || products.length, products });
  await db.prepare(
    `INSERT INTO catalogs (domain, status, count, payload, fetched_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET status = excluded.status, count = excluded.count, payload = excluded.payload, fetched_at = excluded.fetched_at`
  ).bind(key, record.status, products.length, payload, now).run();
  return true;
}

export async function getSocials(db, domain) {
  const key = canonicalDomain(domain);
  if (!key) return null;
  const row = await db.prepare('SELECT payload, fetched_at FROM socials WHERE domain = ?').bind(key).first();
  if (!row) return null;
  const socials = parse(row.payload);
  return socials ? { ...socials, fetchedAt: row.fetched_at } : null;
}

export async function putSocials(db, domain, result, now = Date.now()) {
  const key = canonicalDomain(domain);
  if (!key || !result || result.status === 'error') return false;
  const { fetchedAt, cached, stale, ...record } = result;
  await db.prepare(
    `INSERT INTO socials (domain, status, payload, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET status = excluded.status, payload = excluded.payload, fetched_at = excluded.fetched_at`
  ).bind(key, record.status, JSON.stringify(record), now).run();
  return true;
}

/* -------------------------------------------------------------------------- */
/* Searches: the searched brand, its recommendations, and their catalogs        */
/* -------------------------------------------------------------------------- */

// `limit` null or undefined is the whole list; 0 is none of it.
function trimProducts(catalog, limit) {
  const products = Array.isArray(catalog.products) ? catalog.products : [];
  if (limit == null || limit < 0 || products.length <= limit) return { ...catalog, products, truncated: false };
  return { ...catalog, products: products.slice(0, limit), truncated: true };
}

/**
 * A stored search as the app cached it: `{ type, searchId, searchedBrand, brands,
 * serpApiOutOfCredits, errorMessage, timestamp }`, or null when the domain was never searched.
 * Each brand carries its catalog from the catalogs table, trimmed to `products` items with
 * `truncated` set when there are more; /api/catalog serves the whole thing.
 */
export async function getSearch(db, domain, { products = DEFAULT_PRODUCTS_PER_BRAND } = {}) {
  const key = canonicalDomain(domain);
  if (!key) return null;
  const search = await db.prepare('SELECT * FROM searches WHERE domain = ?').bind(key).first();
  if (!search) return null;

  const { results: brandRows } = await db.prepare(
    'SELECT position, domain, brand FROM search_brands WHERE search_domain = ? ORDER BY position'
  ).bind(key).all();

  // The searched brand's catalog was crawled under the url its profile named, which may not be
  // the domain that was typed.
  const searchedBrand = parse(search.searched_brand);
  const searchedKey = canonicalDomain(searchedBrand?.url || '') || key;
  const domains = [...new Set([key, searchedKey, ...brandRows.map(row => row.domain)])].filter(Boolean);
  const moderation = await moderationFor(db, key, domains);
  const catalogs = new Map();
  if (domains.length) {
    const placeholders = domains.map(() => '?').join(', ');
    const { results } = await db.prepare(`SELECT domain, payload FROM catalogs WHERE domain IN (${placeholders})`).bind(...domains).all();
    for (const row of results) catalogs.set(row.domain, parse(row.payload));
  }
  const catalogFor = (brandDomain) => moderation.hidden.has(brandDomain)
    ? HIDDEN_CATALOG(brandDomain)
    : trimProducts(catalogs.get(brandDomain) || EMPTY_CATALOG(brandDomain), products);

  return {
    type: search.status,
    searchId: search.search_id,
    errorMessage: search.error_message || undefined,
    searchedBrand: searchedBrand ? { ...searchedBrand, catalog: catalogFor(searchedKey) } : null,
    brands: brandRows.filter(row => !moderation.removed.has(row.domain))
      .map(row => ({ ...parse(row.brand, {}), catalog: catalogFor(row.domain) })),
    serpApiOutOfCredits: Boolean(search.serp_out_of_credits),
    timestamp: search.updated_at
  };
}

/**
 * Stores a finished search. Brands are kept without their catalogs; a catalog that arrives with
 * products (the Google Shopping fallback, which is only ever assembled in the browser) is
 * written to the catalogs table, where /api/catalog already put the Shopify ones.
 */
export async function putSearch(db, domain, record, now = Date.now()) {
  const key = canonicalDomain(domain);
  if (!key) throw new Error('A search needs a domain');
  const type = ['results', 'empty', 'error'].includes(record?.type) ? record.type : 'error';
  const searchId = String(record?.searchId || `${now}`);
  const offered = type === 'results' && Array.isArray(record.brands) ? record.brands : [];
  const { removed } = await moderationFor(db, key, []);
  const brands = offered.filter(brand => !removed.has(canonicalDomain(brand?.url || '')));

  const statements = [
    db.prepare(
      `INSERT INTO searches (domain, search_id, status, error_message, searched_brand, serp_out_of_credits, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET search_id = excluded.search_id, status = excluded.status,
         error_message = excluded.error_message, searched_brand = excluded.searched_brand,
         serp_out_of_credits = excluded.serp_out_of_credits, updated_at = excluded.updated_at`
    ).bind(
      key, searchId, type, record?.errorMessage || null,
      record?.searchedBrand ? JSON.stringify(withoutCatalog(record.searchedBrand)) : null,
      record?.serpApiOutOfCredits ? 1 : 0, now, now
    ),
    db.prepare('DELETE FROM search_brands WHERE search_domain = ?').bind(key)
  ];

  brands.forEach((brand, position) => {
    const brandDomain = canonicalDomain(brand?.url || '');
    statements.push(
      db.prepare('INSERT INTO search_brands (search_domain, position, domain, brand) VALUES (?, ?, ?, ?)')
        .bind(key, position, brandDomain, JSON.stringify(withoutCatalog(brand)))
    );
  });

  await db.batch(statements);

  const crawled = [record?.searchedBrand, ...brands].filter(brand => brand?.catalog?.products?.length);
  for (const brand of crawled) {
    await putCatalog(db, brand.url || brand.catalog.domain, brand.catalog, now);
  }
  return { domain: key, searchId, timestamp: now };
}

/**
 * The brands whose own search recommended this domain, newest first, with the reasons and
 * bundle idea given then: `[{ domain, name, url, reasons, bundleIdea }]`. The recommender reads
 * these back, so every search grows the graph the next one starts from.
 */
export async function listKnownPartners(db, domain, limit = DEFAULT_KNOWN_PARTNERS) {
  const key = canonicalDomain(domain);
  if (!key) return [];
  const { results } = await db.prepare(
    `SELECT s.domain AS domain, s.searched_brand AS searched_brand, sb.brand AS brand
       FROM search_brands sb JOIN searches s ON s.domain = sb.search_domain
      WHERE sb.domain = ? AND sb.search_domain != ? AND s.status = 'results'
      ORDER BY s.updated_at DESC LIMIT ?`
  ).bind(key, key, limit).all();
  return results.map(row => {
    const searched = parse(row.searched_brand, {}) || {};
    const recommendation = parse(row.brand, {}) || {};
    return {
      domain: row.domain,
      name: searched.name || row.domain,
      url: searched.url || `https://${row.domain}`,
      reasons: Array.isArray(recommendation.reasons) ? recommendation.reasons : [],
      bundleIdea: recommendation.bundleIdea || null
    };
  });
}

/**
 * The brands the finder recommends most, across its last searches: the recommender's habits,
 * handed back to it so a search reaches past them. [{ domain, name, searches }], most first.
 *
 * Every search asks, so the answer is kept in frequent_brands (migrations/0006) and served until
 * it is FREQUENT_TTL_MS old; the next caller after that counts again. A few searches more or less
 * out of the last hundred barely moves the list. At most FREQUENT_KEPT brands are kept.
 */
export async function listFrequentBrands(db, { searches = FREQUENT_SEARCHES, min = FREQUENT_MIN, limit = DEFAULT_FREQUENT_LIMIT } = {}, now = Date.now()) {
  const id = `${searches}:${min}`;
  const stored = await withFrequentTable(() => db.prepare('SELECT brands, computed_at FROM frequent_brands WHERE id = ?').bind(id).first(), null);
  let brands = stored && now - stored.computed_at < FREQUENT_TTL_MS ? parse(stored.brands) : null;
  if (!Array.isArray(brands)) {
    brands = await countFrequentBrands(db, searches, min);
    await withFrequentTable(() => db.prepare(
      `INSERT INTO frequent_brands (id, brands, computed_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET brands = excluded.brands, computed_at = excluded.computed_at`
    ).bind(id, JSON.stringify(brands), now).run(), null);
  }
  return brands.slice(0, limit);
}

// The count starts from the last `searches` searches (the searches_recent index) and looks up
// only their brands. CROSS JOIN pins that order: with a plain JOIN SQLite walked all of
// search_brands by domain and every search besides. Reads stay near searches × brands per search
// however large the tables grow. Migration 0006 backfills with the same query.
async function countFrequentBrands(db, searches, min) {
  const { results } = await db.prepare(
    `SELECT sb.domain AS domain, MAX(json_extract(sb.brand, '$.name')) AS name, COUNT(DISTINCT sb.search_domain) AS searches
       FROM (SELECT domain FROM searches WHERE status = 'results' ORDER BY updated_at DESC LIMIT ?) recent
      CROSS JOIN search_brands sb ON sb.search_domain = recent.domain
      GROUP BY sb.domain
     HAVING searches >= ?
      ORDER BY searches DESC, sb.domain
      LIMIT ?`
  ).bind(searches, min, FREQUENT_KEPT).all();
  return (results || []).map(row => ({ domain: row.domain, name: row.name || row.domain, searches: row.searches }));
}

// A deploy that lands before migration 0006 has no frequent_brands table: the list is then
// counted on every call, as it was before.
async function withFrequentTable(query, fallback) {
  try {
    return await query();
  } catch (err) {
    if (/no such table: frequent_brands/i.test(err?.message || '')) return fallback;
    throw err;
  }
}

function withoutCatalog(brand) {
  if (!brand || typeof brand !== 'object') return brand;
  const { catalog, ...rest } = brand;
  return rest;
}

/* -------------------------------------------------------------------------- */
/* Search history                                                              */
/* -------------------------------------------------------------------------- */

export async function listHistory(db, limit = DEFAULT_HISTORY_LIMIT) {
  const { results } = await db.prepare(
    'SELECT domain, searched_at FROM search_history ORDER BY searched_at DESC LIMIT ?'
  ).bind(limit).all();
  return results.map(row => ({ domain: row.domain, url: row.domain, timestamp: row.searched_at }));
}

export async function touchHistory(db, domain, now = Date.now()) {
  const key = canonicalDomain(domain);
  if (!key) return false;
  await db.prepare(
    'INSERT INTO search_history (domain, searched_at) VALUES (?, ?) ON CONFLICT(domain) DO UPDATE SET searched_at = excluded.searched_at'
  ).bind(key, now).run();
  return true;
}

export async function removeHistory(db, domain) {
  const key = canonicalDomain(domain);
  if (!key) return false;
  await db.prepare('DELETE FROM search_history WHERE domain = ?').bind(key).run();
  return true;
}

export async function clearHistory(db) {
  await db.prepare('DELETE FROM search_history').run();
}

/* -------------------------------------------------------------------------- */
/* Feedback                                                                    */
/* -------------------------------------------------------------------------- */

/** The latest `limit` entries, oldest first, as the recommender's prompt wants them. */
export async function listFeedback(db, limit = DEFAULT_FEEDBACK_LIMIT) {
  const { results } = await db.prepare(
    'SELECT search_id, search_domain, rating, results, created_at FROM feedback ORDER BY created_at DESC, id DESC LIMIT ?'
  ).bind(limit).all();
  return results.reverse().map(row => ({
    searchId: row.search_id,
    inputUrl: row.search_domain,
    rating: row.rating,
    results: parse(row.results, []),
    timestamp: row.created_at
  }));
}

export async function addFeedback(db, { searchId, inputUrl, rating, results }, now = Date.now()) {
  if (!['positive', 'negative'].includes(rating)) throw new Error('rating must be positive or negative');
  const named = (Array.isArray(results) ? results : []).map(r => ({ name: r?.name ?? null, url: r?.url ?? null }));
  await db.prepare(
    'INSERT INTO feedback (search_id, search_domain, rating, results, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(searchId || null, canonicalDomain(inputUrl) || null, rating, JSON.stringify(named), now).run();
  return true;
}

/* -------------------------------------------------------------------------- */
/* OfferLab drafts, per searched brand                                         */
/* -------------------------------------------------------------------------- */

function draftFromRow(row) {
  const draft = parse(row.draft, {});
  return {
    ...draft,
    stackId: row.stack_id,
    publishedUrl: row.published_url || draft.publishedUrl || undefined,
    createdAt: new Date(row.created_at).toISOString()
  };
}

export async function listDrafts(db, searchedDomain, limit = DRAFTS_PER_BRAND) {
  const key = canonicalDomain(searchedDomain);
  if (!key) return [];
  const { results } = await db.prepare(
    'SELECT stack_id, draft, published_url, created_at FROM drafts WHERE searched_domain = ? ORDER BY created_at DESC LIMIT ?'
  ).bind(key, limit).all();
  return results.map(draftFromRow);
}

/** Same stack twice is a rebuild, not a second draft: the newer record replaces the older one. */
export async function putDraft(db, searchedDomain, draft, now = Date.now()) {
  const key = canonicalDomain(searchedDomain);
  const stackId = String(draft?.stackId || '');
  if (!key || !stackId) return null;
  const { publishedUrl, createdAt, ...record } = draft;
  await db.prepare(
    `INSERT INTO drafts (stack_id, searched_domain, draft, published_url, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(stack_id) DO UPDATE SET searched_domain = excluded.searched_domain, draft = excluded.draft,
       published_url = COALESCE(excluded.published_url, drafts.published_url), created_at = excluded.created_at`
  ).bind(stackId, key, JSON.stringify({ ...record, stackId }), publishedUrl || null, now).run();
  return listDrafts(db, key);
}

export async function setDraftPublishedUrl(db, stackId, publishedUrl) {
  if (!stackId) return false;
  await db.prepare('UPDATE drafts SET published_url = ? WHERE stack_id = ?').bind(publishedUrl || null, String(stackId)).run();
  return true;
}

export async function deleteDrafts(db, searchedDomain) {
  const key = canonicalDomain(searchedDomain);
  if (key) await db.prepare('DELETE FROM drafts WHERE searched_domain = ?').bind(key).run();
  else await db.prepare('DELETE FROM drafts').run();
  return true;
}

/* -------------------------------------------------------------------------- */
/* Freshness: when a stored crawl is served instead of crawling again          */
/* -------------------------------------------------------------------------- */

/** A catalog with products holds for a day; a store with no public catalog is looked at again sooner. */
export const CATALOG_TTL_MS = { shopify: 24 * 60 * 60 * 1000, serp: 24 * 60 * 60 * 1000, none: 6 * 60 * 60 * 1000 };
export const SOCIALS_TTL_MS = { found: 7 * 24 * 60 * 60 * 1000, none: 24 * 60 * 60 * 1000 };

export function isFresh(stored, ttls, now = Date.now()) {
  if (!stored || typeof stored.fetchedAt !== 'number') return false;
  const ttl = ttls[stored.status];
  return typeof ttl === 'number' && now - stored.fetchedAt < ttl;
}

/**
 * Google Shopping found products the storefront does not publish, so a crawl that finds none is
 * not news: the stored catalog stays, marked stale, until a search refreshes it through SERP.
 */
export function keepStoredSerp(stored, crawled) {
  return stored?.status === 'serp' && stored.count > 0 && !(crawled?.products?.length);
}

/**
 * The crawl proxies' one pattern: serve the stored copy while it is fresh, otherwise crawl and
 * store the result. `defer` (Pages' waitUntil) lets the write happen after the response; without
 * it the write is awaited. `keep(stored, crawled)` says when a crawl should not replace the row,
 * in which case the stored copy is served with `stale` set. Without a db it just crawls.
 */
export async function readThrough({ db, domain, get, put, ttl, crawl, refresh = false, keep = null, defer = null }) {
  let stored = null;
  if (db && !refresh) {
    stored = await get(db, domain).catch(err => {
      console.warn(`[Store] read failed for ${domain}: ${err.message}`);
      return null;
    });
    if (isFresh(stored, ttl)) return { ...stored, cached: true };
  }

  const crawled = await crawl(domain);
  if (stored && keep && keep(stored, crawled)) return { ...stored, cached: true, stale: true };

  if (db) {
    const write = put(db, domain, crawled).catch(err => console.warn(`[Store] write failed for ${domain}: ${err.message}`));
    if (defer) defer(write); else await write;
  }
  return crawled;
}
