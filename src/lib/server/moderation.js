/**
 * Corrections staff make to what the finder shows. Schema: migrations/0003_moderation.sql.
 *
 * Hiding a brand's products clears its stored catalog and makes shared/db.js serve it empty from
 * then on, so no search looks for its products again. Removing a recommendation drops the brand
 * from that one search, and the search leaves it out if it runs again.
 */

import { normalizeDomain } from '$lib/shared/catalog.js';

// db.js's canonicalDomain, restated because db.js reads these tables and imports this module.
function canonical(domain) {
  return normalizeDomain(domain).replace(/^www\./, '');
}

/** The catalog served for a brand whose products staff hid. */
export const HIDDEN_CATALOG = (domain) => ({ status: 'none', domain, storeUrl: null, count: 0, products: [], hidden: true });

export async function hideProducts(db, domain, now = Date.now()) {
  const key = canonical(domain);
  if (!key) throw new Error('A brand needs a domain');
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO moderation (kind, search_domain, domain, created_at) VALUES ('products', '', ?, ?)`).bind(key, now),
    db.prepare('DELETE FROM catalogs WHERE domain = ?').bind(key)
  ]);
  return { domain: key };
}

export async function showProducts(db, domain) {
  const key = canonical(domain);
  if (!key) throw new Error('A brand needs a domain');
  await db.prepare(`DELETE FROM moderation WHERE kind = 'products' AND domain = ?`).bind(key).run();
  return { domain: key };
}

export async function removeRecommendation(db, searchDomain, domain, now = Date.now()) {
  const search = canonical(searchDomain);
  const key = canonical(domain);
  if (!search || !key) throw new Error('Removing a recommendation needs the search and the brand');
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO moderation (kind, search_domain, domain, created_at) VALUES ('recommendation', ?, ?, ?)`).bind(search, key, now),
    db.prepare('DELETE FROM search_brands WHERE search_domain = ? AND domain = ?').bind(search, key)
  ]);
  return { searchDomain: search, domain: key };
}

// A products row's search_domain is always '', and saying so lets both lookups below take the
// primary key all the way to the domain instead of reading every products row.
export async function isProductsHidden(db, domain) {
  const key = canonical(domain);
  if (!key) return false;
  const row = await readModeration(() => db.prepare(`SELECT 1 AS hidden FROM moderation WHERE kind = 'products' AND search_domain = '' AND domain = ?`).bind(key).first(), null);
  return Boolean(row);
}

// Every catalog read goes through here, so a deploy that lands before its migration must not
// break them: with no table yet, nothing is moderated.
async function readModeration(query, fallback) {
  try {
    return await query();
  } catch (err) {
    if (/no such table: moderation/i.test(err?.message || '')) return fallback;
    throw err;
  }
}

/** For a search: which of these brands have hidden products, and which were removed from it. */
export async function moderationFor(db, searchDomain, domains) {
  const keys = [...new Set(domains.map(canonical).filter(Boolean))];
  const hidden = new Set();
  const removed = new Set();
  const search = canonical(searchDomain);
  const marks = keys.map(() => '?').join(', ');
  const { results } = await readModeration(() => db.prepare(
    `SELECT kind, domain FROM moderation
      WHERE (kind = 'recommendation' AND search_domain = ?)${keys.length ? ` OR (kind = 'products' AND search_domain = '' AND domain IN (${marks}))` : ''}`
  ).bind(search, ...keys).all(), { results: [] });
  for (const row of results) (row.kind === 'products' ? hidden : removed).add(row.domain);
  return { hidden, removed };
}
