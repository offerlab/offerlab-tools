/**
 * The Showcase's data and filters: every published demo bundle from /library/snapshot.json and
 * nothing else (OL-3832, OL-4032). No OfferLab calls, no account.
 *
 * `showcase` is the reactive part the omnibox renders from; the bundles themselves stay plain,
 * since the board deals them imperatively and never watches them.
 */
import { param, replaceUrl } from '$lib/client/url.js';

const SNAPSHOT_URL = '/library/snapshot.json';
const BRANDS_URL = '/library/brands.json';

// Words a booth visitor types around the thing they mean, and the words they use for ours.
const STOPWORDS = new Set(('a an and or for with of to in on my me our some something that this is are i want need looking ' +
  'show find who someone anything any bundle bundles collab collabs kit box set brand brands like what do you have got').split(' '));
const SYNONYMS = {
  spirits: 'alcohol', liquor: 'alcohol', booze: 'alcohol', cocktail: 'alcohol', cocktails: 'alcohol',
  vitamins: 'supplements', vitamin: 'supplements', workout: 'fitness', gym: 'fitness', exercise: 'fitness',
  puppy: 'dog', pets: 'pet', toddler: 'kids', kid: 'kids', children: 'kids', child: 'kids',
  beverage: 'drink', beverages: 'drink', drinks: 'drink', makeup: 'beauty', cosmetics: 'beauty',
  haircare: 'hair', skincare: 'skin', grocery: 'food', groceries: 'food', healthy: 'clean',
  men: 'him', man: 'him', guys: 'him'
};
const PARAMS = { query: 'lq', category: 'cat', brand: 'brand', store: 'store' };

export const TILE_COVER_WIDTH = 480;
export const LIGHTBOX_COVER_WIDTH = 1200;
export const EYEBROW_CHIPS = 2;
export const TYPING_MS = 120;

export const showcase = $state({
  filters: { query: '', category: '', brand: '', store: '' },
  options: { categories: [], brands: [], stores: [] },
  // How many bundles the shelves hold, of how many there are.
  count: 0,
  total: 0,
  loaded: false,
  filtersOpen: false
});

// Plain, not proxied: the board reads these by the thousand while panning.
const data = { bundles: [], logos: {} };

/** The URL param names the mode switch clears when leaving the library. */
export function libraryFilterParams() {
  return PARAMS;
}

export const bundles = () => data.bundles;
export const findBundle = id => data.bundles.find(b => b.id === id);
export const logoFor = name => data.logos[name.toLowerCase()];

/* -------------------------------------------------------------------------- */
/* Data                                                                        */
/* -------------------------------------------------------------------------- */

export async function load() {
  const [snapshot, logos] = await Promise.all([
    fetch(SNAPSHOT_URL).then(r => r.json()),
    fetch(BRANDS_URL).then(r => (r.ok ? r.json() : {})).catch(() => ({}))
  ]);
  data.logos = logos;
  data.bundles = snapshot.bundles.filter(bundle => bundle.cover).map(bundle => ({
    ...bundle,
    // Every word of the bundle, stemmed once, so a query is a set lookup per term.
    tokens: new Set(words([bundle.name, ...bundle.brands, ...bundle.products,
      bundle.category.replace(/-/g, ' '), bundle.description].join(' ')).map(stem))
  }));
  showcase.options = {
    categories: snapshot.categories.filter(c => data.bundles.some(b => b.category === c)),
    brands: [...new Set(data.bundles.flatMap(b => b.brands))].sort((a, b) => a.localeCompare(b)),
    stores: [...new Set(data.bundles.map(b => b.store))]
  };
  showcase.total = data.bundles.length;
  showcase.loaded = true;
}

export const label = slug => slug.replace(/-and-/g, ' & ').replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());

/** The Shopify CDN sizes on request; a tile never needs the full hero the lightbox shows. */
export function coverUrl(url, width) {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('shopify.com')) u.searchParams.set('width', String(width));
    return u.toString();
  } catch {
    return url;
  }
}

export function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* -------------------------------------------------------------------------- */
/* Filtering                                                                   */
/* -------------------------------------------------------------------------- */

const words = text => text.toLowerCase().replace(/[’'"“”]/g, '').split(/[^a-z0-9+-]+/).filter(Boolean);
const stem = word => word.replace(/ies$/, 'y').replace(/(sses|shes|ches|xes)$/, m => m.slice(0, -2)).replace(/([^s])s$/, '$1');
const queryTerms = query => [...new Set(words(query).filter(w => !STOPWORDS.has(w)).map(w => SYNONYMS[w] || w).map(stem))];

function matchesFilters(bundle) {
  const { category, brand, store } = showcase.filters;
  if (category && bundle.category !== category) return false;
  if (store && bundle.store !== store) return false;
  if (brand && !bundle.brands.some(b => b.toLowerCase() === brand.toLowerCase())) return false;
  return true;
}

/**
 * The bundles that match the most of the query's terms: all of them when any bundle does, else
 * the best partial match, so "cold and flu" still finds the cold-season shelf. Nothing matching
 * even one term is the empty state.
 */
function search(bundles, query) {
  const terms = queryTerms(query);
  if (!terms.length) return bundles;
  const scored = bundles.map(bundle => ({ bundle, hits: terms.filter(term => bundle.tokens.has(term)).length }));
  const best = Math.max(0, ...scored.map(s => s.hits));
  return best ? scored.filter(s => s.hits === best).map(s => s.bundle) : [];
}

/** The bundles the current filters leave on the shelves; also records the count. */
export function visibleBundles() {
  const visible = search(data.bundles.filter(matchesFilters), showcase.filters.query);
  showcase.count = visible.length;
  return visible;
}

/** The popover's filters, in the order the chips show. A typed query stays in the box, not here. */
export function narrowedBy() {
  const { category, brand, store } = showcase.filters;
  return [
    category && { key: 'category', label: label(category) },
    brand && { key: 'brand', label: brand },
    store && { key: 'store', label: store }
  ].filter(Boolean);
}

export function readFiltersFromUrl() {
  for (const [key, name] of Object.entries(PARAMS)) showcase.filters[key] = param(name) || '';
}

export function writeFiltersToUrl() {
  replaceUrl(url => {
    for (const [key, name] of Object.entries(PARAMS)) {
      if (showcase.filters[key]) url.searchParams.set(name, showcase.filters[key]);
      else url.searchParams.delete(name);
    }
  });
}
