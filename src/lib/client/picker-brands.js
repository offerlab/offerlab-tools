/**
 * The brands on the picker's rail: adding, swapping and removing columns, and the ?pick= URL
 * that names them.
 */
import { extractDomain, fetchCatalog } from './util.js';
import { getResults } from './state.svelte.js';
import { pushUrl, PICK_PARAM } from './url.js';
import { picker, entryFor, sellerEntry, view, conceptsRendered } from './picker-state.svelte.js';
import { refreshConceptsCopy } from './picker-concepts.js';

/**
 * Only a brand with a public storefront catalog can be built with: the build imports each pick
 * from its storefront, and a Google Shopping result has no storefront to import from (every
 * such build failed with "google.com: no public catalog found"). Those brands can still be
 * pitched; they just have no Create bundle and are not offered on the rail.
 */
export function canBuildWith(brand) {
  return brand?.catalog?.status === 'shopify' && (brand.catalog.products?.length || 0) > 0;
}

// Every brand on the rail but the searched one, which the search itself names; when a partner
// leads instead, it is in here too, so the rail comes back the same from the URL.
export function pushPickUrl() {
  const searched = extractDomain(getResults()?.searchedBrand?.url || '');
  pushUrl(url => url.searchParams.set(PICK_PARAM, picker.brands.filter(e => e.domain !== searched).map(e => e.domain).join(',')));
}

// A stored search carries a trimmed catalog per brand; the picker wants the whole thing.
export async function ensureFullCatalog(brand) {
  const catalog = brand.catalog;
  if (catalog.status !== 'shopify') return;
  if (!catalog.truncated && catalog.products.length >= catalog.count) return;
  const fresh = await fetchCatalog(extractDomain(brand.url || ''));
  if (fresh.status === 'shopify' && fresh.products.length) brand.catalog = fresh;
}

function forgetConcepts() {
  picker.concepts = [];
  picker.conceptsSummary = '';
  picker.activeConcept = -1;
  picker.conceptsStatus = 'idle';
}

function dropPicksFor(domain) {
  [...picker.selection.keys()].filter(key => key.startsWith(`${domain}:`)).forEach(key => picker.selection.delete(key));
}

export async function addBrand(brand) {
  const domain = extractDomain(brand.url || '');
  if (!domain || !canBuildWith(brand)) return;
  const existing = entryFor(domain);
  if (existing) {
    view.scrollToColumn(domain);
    return;
  }
  picker.brands.push({ domain, brand });
  pushPickUrl();
  refreshConceptsCopy();
  await conceptsRendered({ reveal: true, swap: true });
  // The new column arrives past the right edge once there are more than two, so page to it.
  view.scrollToColumn(domain);
  await ensureFullCatalog(entryFor(domain).brand);
}

// Swaps one column's brand for another, keeping its position on the rail. The old brand's
// picks go with it; the rest of the selection stands.
export async function replaceBrand(domain, brand) {
  const entry = entryFor(domain);
  const nextDomain = extractDomain(brand.url || '');
  if (!entry || !nextDomain || !canBuildWith(brand) || nextDomain === domain) return;
  if (entryFor(nextDomain)) {
    view.scrollToColumn(nextDomain);
    return;
  }

  dropPicksFor(domain);
  entry.domain = nextDomain;
  entry.brand = brand;
  // The concepts referenced the old catalog, so they start over.
  forgetConcepts();

  pushPickUrl();
  refreshConceptsCopy();
  await conceptsRendered({ reveal: true, swap: true });
  view.scrollToColumn(nextDomain);
  await ensureFullCatalog(entryFor(nextDomain).brand);
}

export function removeBrand(domain) {
  if (domain === sellerEntry()?.domain) return;
  picker.brands = picker.brands.filter(e => e.domain !== domain);
  dropPicksFor(domain);
  // Concepts referenced that catalog; start those over.
  forgetConcepts();
  pushPickUrl();
  refreshConceptsCopy();
}

// Brands from the results list that can be added: buildable and not already a column.
export function addableBrands() {
  const taken = new Set(picker.brands.map(e => e.domain));
  return (getResults()?.brands || []).filter(b => canBuildWith(b) && !taken.has(extractDomain(b.url || '')));
}

export function brandNameFromDomain(domain) {
  return domain.replace(/^www\./, '').split('.')[0].replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
