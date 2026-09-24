/**
 * The finder's UI state, shared by every component (Svelte 5 runes).
 *
 * `view` is which section is on screen; the sections render themselves from it, and +page.svelte
 * mirrors it onto the body (`showing-results`). `results` is the search once it is complete and
 * stored; `liveResults` is the search in flight from the moment its brands are on screen, so a
 * card's button pressed before the catalogs are in still finds its brand.
 */
export const VIEWS = ['landing', 'loading', 'results', 'picker', 'empty', 'error', 'library'];

export const app = $state({
  view: 'landing',
  // The search on screen: { brands, searchedBrand }.
  results: null,
  liveResults: null,
  searchId: null,
  // The domain in the results omnibar; feedback records it as the searched input.
  searchDomain: '',
  loading: { text: '', domain: '' },
  errorMessage: '',
  // Recent searches, newest first: [{ domain, url, timestamp }].
  history: [],
  // The signed-in OfferLab account (offerlab.js keeps the credentials; this is for rendering).
  account: null,
  // An OfferLab developer, signed in: the finder's staff, who may correct its results.
  staff: false,
  // The rating given on the results on screen: null | 'positive' | 'negative'.
  feedback: null
});

export function getResults() {
  return app.results || app.liveResults;
}

/** Puts one section on screen. The finder's views and the library are exclusive. */
export function showSection(name) {
  if (!VIEWS.includes(name)) throw new Error(`Unknown section: ${name}`);
  app.view = name;
}

export function isStaff() {
  return app.staff === true;
}

/** The brand in the results whose site is `domain`. */
export function brandForDomain(domain) {
  return getResults()?.brands?.find(b => domainOf(b.url || '') === domain) || null;
}

function domainOf(url) {
  try {
    const full = url.startsWith('http') ? url : 'https://' + url;
    return new URL(full).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
  }
}
