/**
 * Bundle picker: one catalog column per brand (the searched brand first, then partners),
 * multi-select across them, and Gemini bundle concepts. Tiles and the floating selection
 * tray follow the main app's collab-builder catalog picker (OL-3571).
 *
 * This is what the rest of the finder calls; the state lives in picker-state.svelte.js and the
 * markup in components/Picker.svelte.
 */
import { extractDomain } from './util.js';
import { app, getResults, showSection } from './state.svelte.js';
import { pushUrl, replaceUrl, param, currentUrl, PICK_PARAM } from './url.js';
import { picker, runtime, resetState, view } from './picker-state.svelte.js';
import { canBuildWith, pushPickUrl, ensureFullCatalog } from './picker-brands.js';
import { refreshConceptsCopy } from './picker-concepts.js';
import { hideAddPopover, hideUrlDialog } from './picker-add.js';

export { canBuildWith };

export function isPickerOpen() {
  return app.view === 'picker';
}

export function openPicker(partner, { skipUrlUpdate = false } = {}) {
  return openPickerWith([partner], { skipUrlUpdate });
}

/**
 * The first column presents the bundle. That is the searched brand when it has a public catalog;
 * when it has none (a headless storefront, no products.json) the partner clicked leads instead,
 * and the searched brand is simply not on the rail, so a build never dead-ends on it.
 */
async function openPickerWith(partners, { skipUrlUpdate = false } = {}) {
  const seller = getResults()?.searchedBrand;
  const lead = seller && canBuildWith(seller) ? [seller] : [];
  const usable = partners.filter(canBuildWith);
  if (usable.length === 0) return false;

  resetState();
  picker.brands = [...lead, ...usable].map(brand => ({ domain: extractDomain(brand.url || ''), brand }));
  if (!skipUrlUpdate) pushPickUrl();

  view.reveal();
  refreshConceptsCopy();
  showSection('picker');
  window.scrollTo({ top: 0 });

  // A stored search carries a trimmed catalog per brand; the picker wants the whole thing.
  await Promise.all(picker.brands.map(entry => ensureFullCatalog(entry.brand)));
  return true;
}

export function closePicker() {
  if (runtime.abort) runtime.abort.abort();
  if (currentUrl().searchParams.has(PICK_PARAM)) {
    pushUrl(url => url.searchParams.delete(PICK_PARAM));
  }
  hideAddPopover();
  hideUrlDialog();
  resetState();
  showSection('results');
}

// Browser back/forward: the URL is the source of truth for whether the picker is open.
export function syncPickerWithUrl() {
  const pick = param(PICK_PARAM);
  if (!pick && isPickerOpen()) {
    resetState();
    showSection('results');
  } else if (pick && !isPickerOpen()) {
    restorePickerFromUrl();
  }
}

// After results render, reopen the picker with the partners named in the URL.
export function restorePickerFromUrl() {
  const pick = param(PICK_PARAM);
  const brands = getResults()?.brands;
  if (!pick || !brands) return;
  const wanted = pick.split(',').filter(Boolean);
  const matches = wanted.map(domain => brands.find(b => extractDomain(b.url || '') === domain)).filter(canBuildWith);
  if (matches.length) {
    openPickerWith(matches, { skipUrlUpdate: true });
  } else {
    replaceUrl(url => url.searchParams.delete(PICK_PARAM));
  }
}
