/**
 * The search flow: from a domain in the omnibar to results on screen, through the store first
 * (a search with results is kept for good; ?refresh=1 runs it again; one that found nothing is
 * retried after 72 hours). The shared search (shared/search.js) does the work; this owns the UI
 * state around it, the URL, and the omnibars.
 */
import { tick } from 'svelte';
import * as search from '$lib/shared/search.js';
import { catalogForStore, httpApi, threadOf, TURN_LABELS } from '$lib/shared/search.js';
import { composerIntent, confidentBrand } from './composer.js';
import { app, showSection, getResults } from './state.svelte.js';
import * as store from './store.js';
import * as offerlab from './offerlab.js';
import { CONFIG, searchApi, extractDomain, generateId, isValidUrl } from './util.js';
import { getSearchFromUrl, updateUrlForSearch, clearSearchFromUrl, takeRefreshRequest } from './url.js';
import { addToSearchHistory, getFeedbackHistory } from './history.svelte.js';
import { whipOutTiles, resetTiles } from './tiles.svelte.js';
import { hideSocialPopover } from './popover.svelte.js';
import { restorePickerFromUrl } from './picker.svelte.js';
import { restorePitchFromUrl } from './pitch.svelte.js';

export const LOADING_MESSAGES = [
  'Researching your brand...',
  'Analyzing products, audience & market position...',
  'Finding complementary brands...',
  'Verifying product recommendations...',
  'Fetching product images...',
  'Finalizing results...'
];

// What a follow-up's divider says while the agent works, by step.
export const EXTEND_MESSAGES = {
  note: ['Reading your note...', 'Finding more brands...', 'Fetching product images...'],
  more: ['Reading the list so far...', 'Finding more brands...', 'Fetching product images...'],
  surprise: ['Looking for the pairing nobody saw coming...', 'Checking it is a real bundle...', 'Fetching product images...']
};

const EMPTY_SEARCH_EXPIRATION_MS = 72 * 60 * 60 * 1000;

// Shown when a step has been quiet for this long: the recommender can take a minute, and a
// screen that says nothing for that long reads as hung.
const SLOW_SEARCH_NOTICE_MS = 45000;
const SLOW_SEARCH_NOTICE = 'Still working. Researching a brand from scratch can take a minute or two...';

// Brands with no team in the demo environment yet, by domain (markBrandsNotSetUp).
export const notSetUp = $state({});

// The omnibars register themselves so the flow can set, clear, focus and quieten them.
const omnibars = {};
export function registerOmnibar(variant, api) {
  omnibars[variant] = api;
  return () => { if (omnibars[variant] === api) delete omnibars[variant]; };
}
export function hideAllSearchHistoryDropdowns() {
  Object.values(omnibars).forEach(bar => bar.hideHistory());
}
// The results bar rests empty, its placeholder inviting the next ask; the searched brand's card
// says what was searched. The domain lives in app.searchDomain for whoever needs it.
function showSearchedDomain(domain) {
  app.searchDomain = domain;
  omnibars.results?.setValue('');
  omnibars.results?.hidePlaceholder();
}

let searchAbortController = null;
let isSearchCancelled = false;

// Resolves when the search in flight has settled either way, so a note typed while the catalogs
// are still landing waits for the list it extends.
let settled = Promise.resolve();
let settleSearch = () => {};

let extendAbort = null;

export function goToLanding() {
  cancelExtend();
  clearSearchFromUrl();
  showSection('landing');
  resetTiles();
  omnibars.landing?.setValue('');
  // The field takes focus once the landing section is back on screen.
  tick().then(() => omnibars.landing?.focus());
}

/** Browser back to the landing page: the field keeps what was typed, and takes focus. */
export function returnToLanding() {
  showSection('landing');
  resetTiles();
  tick().then(() => omnibars.landing?.focus());
}

export function cancelSearch() {
  isSearchCancelled = true;
  if (searchAbortController) searchAbortController.abort();
  goToLanding();
}

/** The bar's stop control: a follow-up in flight is what stops; else the search. */
export function stopActivity() {
  if (app.extending) cancelExtend();
  else cancelSearch();
}

/** Drops the follow-up in flight and leaves the list as it was. */
export function cancelExtend() {
  if (!app.extending) return;
  const id = app.extending;
  extendAbort?.abort();
  app.turns = app.turns.filter(turn => turn.id !== id);
  app.extending = null;
  app.extendingText = '';
}

/** The Retry control: the searched domain, or what is in either omnibar, else back to the start. */
export function retrySearch() {
  const url = app.searchDomain || omnibars.landing?.getValue() || omnibars.results?.getValue();
  if (url) performSearch(url);
  else goToLanding();
}

async function getCachedResults(domain) {
  if (takeRefreshRequest()) return null;
  const cached = await store.loadSearch(domain, { products: CONFIG.CACHED_PRODUCTS_PER_BRAND });
  if (!cached) return null;
  if (cached.timestamp) {
    const age = Date.now() - cached.timestamp;
    if (cached.type === 'empty' && age > EMPTY_SEARCH_EXPIRATION_MS) return null;
  }
  return cached;
}

function buildFallbackSearchedBrand(domain) {
  const fullUrl = domain.startsWith('http') ? domain : `https://${domain}`;
  const displayName = domain.replace(/^(www\.)?/, '').split('.')[0];
  const friendlyName = displayName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return {
    name: friendlyName,
    url: fullUrl,
    description: `${friendlyName} is a brand selling online. Visit their website to explore their product range and categories.`
  };
}

/**
 * A brand can have a public catalog to pick from and still have no team in the demo environment,
 * in which case creating a bundle has to stand one up first. That is a minute or two with someone
 * watching, so the card says so before the click rather than after (OL-3831). Only for an
 * operator: a guest has no handoff to be warned about.
 */
async function markBrandsNotSetUp(brands) {
  if (!offerlab.isEnabled()) return;
  for (const brand of brands) {
    const domain = extractDomain(brand.url || '');
    try {
      const demo = await offerlab.demoBrand(domain);
      if (demo?.ready) continue;
      notSetUp[domain] = true;
    } catch {
      // The demo environment being unreachable is not worth marking every card over.
      return;
    }
  }
}

// `signal` cancels every request the search makes, so leaving the search stops it.
function discoverComplementaryBrands(url, { onProgress, onBrandsReady, onCatalog, signal }) {
  return Promise.all([getFeedbackHistory(), store.loadKnownPartners(extractDomain(url)), store.loadFrequentBrands()]).then(([feedback, knownPartners, frequentBrands]) =>
    search.discoverComplementaryBrands(url, {
      api: signal ? httpApi('', undefined, { signal }) : searchApi,
      feedback,
      knownPartners,
      frequentBrands,
      onProgress: (step) => onProgress(LOADING_MESSAGES[step] ?? LOADING_MESSAGES[0]),
      onBrandsReady,
      onCatalog,
      config: { catalogConcurrency: CONFIG.CATALOG_CONCURRENCY, serpFallbackBrands: CONFIG.SERP_FALLBACK_BRANDS }
    }));
}

// The shared search mutates its own brand objects; the cards render the reactive copies, so a
// catalog or social that lands is written onto the copy with the same domain.
function applyCatalog(brand) {
  const live = app.liveResults;
  if (!live) return;
  const domain = extractDomain(brand.url || '');
  const targets = [live.searchedBrand, ...(live.brands || [])].filter(b => b && extractDomain(b.url || '') === domain);
  for (const target of targets) {
    target.catalog = brand.catalog;
    if (brand.social !== undefined) target.social = brand.social;
  }
}

// The list's follow-ups, read off its brands: what a stored search brings back.
function syncTurns(brands) {
  app.turns = threadOf(brands).turns.map(({ turn }) => ({ ...turn, status: 'done', error: '' }));
}

function presentResults(domain, results, { fromUrlRestore }) {
  app.feedback = null;
  syncTurns(results?.brands);
  showSearchedDomain(domain);
  if (!fromUrlRestore) updateUrlForSearch(domain);
  showSection('results');
  // A pitch or a picker named in the URL comes back once the brands are on screen.
  restorePitchFromUrl();
  restorePickerFromUrl();
  return results;
}

export async function performSearch(url, { fromUrlRestore = false } = {}) {
  const domain = extractDomain(url);
  hideSocialPopover();
  cancelExtend();

  const cached = await getCachedResults(domain);
  if (cached) {
    app.searchId = cached.searchId || generateId();

    if (cached.type === 'results' && cached.brands) {
      const searchedBrand = cached.searchedBrand || buildFallbackSearchedBrand(domain);
      // Landing is on screen: let the tiles clear before the results replace them.
      if (!fromUrlRestore && app.view === 'landing') await whipOutTiles({ fast: true });
      app.liveResults = null;
      app.results = { brands: cached.brands, searchedBrand };
      presentResults(domain, app.results, { fromUrlRestore });
      markBrandsNotSetUp(app.results.brands);
      return;
    }

    if (cached.type === 'empty') {
      if (!fromUrlRestore && app.view === 'landing') await whipOutTiles({ fast: true });
      if (!fromUrlRestore) updateUrlForSearch(domain);
      showSection('empty');
      return;
    }
    // An error is not restored, so the search can be retried.
  }

  app.loading = { text: LOADING_MESSAGES[0], domain };
  isSearchCancelled = false;
  searchAbortController = new AbortController();
  settled = new Promise(resolve => { settleSearch = resolve; });

  // Only when there are tiles on screen to clear. A URL restore starts on the results view, and
  // playing the exit there held them over it for the length of the animation.
  if (!fromUrlRestore && app.view === 'landing') whipOutTiles();
  showSection('loading');
  showSearchedDomain(domain);
  addToSearchHistory(url);
  app.searchId = generateId();

  // Yield so the loading UI paints before we start. A timer, not requestAnimationFrame, which
  // never fires in a background tab and would stall the search until it's visible.
  await new Promise(resolve => setTimeout(resolve, 0));

  app.liveResults = null;
  let brandsShown = false;
  const searchId = app.searchId;

  // A step that stays quiet gets a note that the search is still going.
  let slowNotice = null;
  const armSlowNotice = () => {
    if (slowNotice) clearTimeout(slowNotice);
    slowNotice = setTimeout(() => { if (!isSearchCancelled) app.loading.text = SLOW_SEARCH_NOTICE; }, SLOW_SEARCH_NOTICE_MS);
  };
  armSlowNotice();

  try {
    const results = await discoverComplementaryBrands(url, {
      signal: searchAbortController.signal,
      onProgress: (text) => {
        if (isSearchCancelled) return;
        app.loading.text = text;
        armSlowNotice();
      },
      // Called as soon as brands are ready: the results page shows at once, catalogs to follow.
      onBrandsReady: ({ searchedBrand, brands }) => {
        if (isSearchCancelled) return;
        app.liveResults = { searchedBrand, brands };
        if (brands.length === 0) return;
        app.results = null;
        presentResults(domain, app.liveResults, { fromUrlRestore });
        brandsShown = true;
      },
      onCatalog: (brand) => { if (!isSearchCancelled) applyCatalog(brand); }
    });

    if (isSearchCancelled) return;

    if (!results.brands || results.brands.length === 0) {
      store.saveSearch(domain, { type: 'empty', searchId });
      if (!fromUrlRestore) updateUrlForSearch(domain);
      showSection('empty');
      return;
    }

    const brands = results.brands || [];
    if (!brandsShown) {
      app.liveResults = { searchedBrand: results.searchedBrand, brands };
      presentResults(domain, app.liveResults, { fromUrlRestore });
    }
    if (results.serpApiOutOfCredits) {
      console.warn('[performSearch] SERP API out of credits; brands without a public catalog show no products');
    }

    // The stand-ins arrive last, after the reactive copy was taken.
    if (results.searchedBrand?.standIns && app.liveResults.searchedBrand) {
      app.liveResults.searchedBrand.standIns = results.searchedBrand.standIns;
    }
    // The reactive copy is the one on screen; it becomes the search of record.
    app.results = app.liveResults;
    store.saveSearch(domain, {
      type: 'results',
      brands: brands.map(catalogForStore),
      searchedBrand: catalogForStore(results.searchedBrand),
      serpApiOutOfCredits: results.serpApiOutOfCredits || false,
      searchId
    });
  } catch (error) {
    if (isSearchCancelled || error?.name === 'AbortError') return;
    console.error('Search failed:', error);
    const errorMessage = error.message || 'Please try again in a moment.';
    store.saveSearch(domain, { type: 'error', errorMessage, searchId });
    app.errorMessage = errorMessage;
    if (!fromUrlRestore) updateUrlForSearch(domain);
    showSection('error');
  } finally {
    if (slowNotice) clearTimeout(slowNotice);
    settleSearch();
  }
}

/**
 * One more round on the list on screen: a note, "more like these" or "surprise me". The turn
 * shows on its divider at once and the brands it adds land under it, stamped with it so the
 * stored search carries the thread. A round that finds nothing or fails says so on the divider.
 */
export async function extendResults({ kind = 'note', text = '' } = {}) {
  await settled;
  const results = app.results;
  if (!results?.brands?.length || app.extending) return;
  const domain = app.searchDomain;
  app.turns.push({ id: generateId(), kind, text: kind === 'note' ? text.trim() : TURN_LABELS[kind], status: 'pending', error: '' });
  // The reactive copy: what the divider renders, and what the status below is written to.
  const turn = app.turns[app.turns.length - 1];
  app.extending = turn.id;
  app.extendingText = EXTEND_MESSAGES[kind]?.[0] || '';
  extendAbort = new AbortController();
  const { signal } = extendAbort;
  hideSocialPopover();
  tick().then(() => document.getElementById(`turn-${turn.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));

  try {
    const frequentBrands = await store.loadFrequentBrands();
    const added = await search.extendRecommendations(httpApi('', undefined, { signal }), {
      brandProfile: results.searchedBrand,
      brands: results.brands,
      kind,
      brief: text,
      frequentBrands,
      onProgress: (step) => { if (!signal.aborted) app.extendingText = EXTEND_MESSAGES[kind]?.[step] || ''; },
      config: { catalogConcurrency: CONFIG.CATALOG_CONCURRENCY, serpFallbackBrands: CONFIG.SERP_FALLBACK_BRANDS }
    });
    if (signal.aborted) return;
    if (!added.length) { turn.status = 'empty'; return; }
    const stamped = added.map(brand => ({ ...brand, turn: { id: turn.id, kind, text: turn.text } }));
    results.brands.push(...stamped);
    turn.status = 'done';
    markBrandsNotSetUp(stamped);
    store.saveSearch(domain, {
      type: 'results',
      brands: results.brands.map(catalogForStore),
      searchedBrand: catalogForStore(results.searchedBrand),
      searchId: app.searchId
    });
  } catch (error) {
    if (signal.aborted || error?.name === 'AbortError') return;
    console.error('Follow-up failed:', error);
    turn.status = 'failed';
    turn.error = error.message || 'Please try again in a moment.';
  } finally {
    if (app.extending === turn.id) {
      app.extending = null;
      app.extendingText = '';
    }
  }
}

/** Try again on a failed or empty divider: the same ask, the divider replaced. */
export function retryTurn(id) {
  const turn = app.turns.find(t => t.id === id);
  if (!turn || app.extending) return;
  app.turns = app.turns.filter(t => t.id !== id);
  extendResults({ kind: turn.kind, text: turn.text });
}

/** A note from the bar: the field empties back to its invitation, and the round starts. */
export function sendNote(text) {
  hideAllSearchHistoryDropdowns();
  showSearchedDomain(app.searchDomain);
  omnibars.results?.blur();
  extendResults({ kind: 'note', text });
}

/** Whether the bar has a list to extend: results on screen, which is the results view. */
function canTakeNote() {
  return app.view === 'results' && (getResults()?.brands?.length || 0) > 0;
}

/**
 * The results bar's submit: a web address (or a suggestion picked from the dropdown) searches;
 * a sentence is a note; one or two words are looked up and, when they are surely a brand, the
 * person is asked which they meant through `ask({ domain, text })`.
 */
export async function submitComposer(input, suggest, { ask }) {
  const typed = input.value.trim();
  if (!typed) return;
  if (!canTakeNote()) return submitSearch(input, suggest);
  const picked = suggest?.picked?.();
  const intent = picked ? 'search' : composerIntent(typed);
  if (intent === 'search') {
    hideAllSearchHistoryDropdowns();
    performSearch(picked || typed);
    return;
  }
  if (intent === 'lookup') {
    const wrapper = input.closest('.search-input-wrapper');
    if (wrapper?.classList.contains('is-resolving')) return;
    wrapper?.classList.add('is-resolving');
    let domain = null;
    try {
      domain = await confidentBrand(typed, { history: () => app.history.map(item => item.domain) });
    } finally {
      wrapper?.classList.remove('is-resolving');
    }
    // Typed on while it looked: that Enter no longer applies.
    if (input.value.trim() !== typed) return;
    if (domain) { ask({ domain, text: typed }); return; }
  }
  sendNote(typed);
}

/**
 * A domain searches at once. A name resolves first, the submit disc spinning meanwhile; a name
 * that resolves to nothing says so in the dropdown and leaves the text for the person to fix.
 */
export async function submitSearch(input, suggest) {
  const typed = input.value.trim();
  if (!typed) return;
  if (isValidUrl(typed)) {
    hideAllSearchHistoryDropdowns();
    performSearch(typed);
    return;
  }
  const wrapper = input.closest('.search-input-wrapper');
  if (wrapper?.classList.contains('is-resolving')) return;
  wrapper?.classList.add('is-resolving');
  try {
    const domain = await suggest.resolve();
    // Typed on while it looked: that Enter no longer applies.
    if (input.value.trim() !== typed) return;
    if (domain) {
      input.value = domain;
      hideAllSearchHistoryDropdowns();
      performSearch(domain);
    } else {
      suggest.showMiss(typed);
    }
  } finally {
    wrapper?.classList.remove('is-resolving');
  }
}

/** What the URL says to show, for the mode switch and the first paint. */
export function searchFromUrl() {
  const domain = getSearchFromUrl();
  return domain && isValidUrl(domain) ? domain : null;
}
