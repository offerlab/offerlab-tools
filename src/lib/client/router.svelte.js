/**
 * What the URL says to show, and the two modes. Switching modes is a navigation, so it pushes.
 * Leaving the library drops its filters from the URL; leaving the finder keeps ?q= so the search
 * is still there on the way back. Back/forward goes through the page's popstate handler.
 */
import { app, showSection } from './state.svelte.js';
import { modeFromUrl, getPitchFromUrl, pushUrl, MODE_PARAM } from './url.js';
import { performSearch, searchFromUrl, goToLanding } from './search.svelte.js';
import { resetTiles } from './tiles.svelte.js';
import { libraryFilterParams } from './showcase.svelte.js';
import { syncPickerWithUrl } from './picker.svelte.js';
import { isPitchOpen, closePitchModalSilently, restorePitchFromUrl } from './pitch.svelte.js';

export function switchMode(mode) {
  if (mode === modeFromUrl()) return;
  pushUrl(url => {
    if (mode === 'library') {
      url.searchParams.set(MODE_PARAM, 'library');
    } else {
      url.searchParams.delete(MODE_PARAM);
      Object.values(libraryFilterParams()).forEach(param => url.searchParams.delete(param));
    }
  }, { mode });
  routeFromUrl();
}

export function routeFromUrl() {
  if (modeFromUrl() === 'library') {
    showSection('library');
    return;
  }
  const domain = searchFromUrl();
  if (!domain) {
    showSection('landing');
    resetTiles();
  } else if (app.results?.brands) {
    showSection('results');
  } else {
    performSearch(domain, { fromUrlRestore: true });
  }
}

/** The first paint: the library wins over a search, so ?view=library&q=... opens the library. */
export function routeInitial() {
  const domain = searchFromUrl();
  if (modeFromUrl() === 'library') showSection('library');
  else if (domain) performSearch(domain, { fromUrlRestore: true });
}

/** Browser back/forward: the URL is the source of truth for every layer. */
export function onPopState() {
  if (modeFromUrl() === 'library') {
    showSection('library');
    return;
  }
  const domain = searchFromUrl();
  const pitchParam = getPitchFromUrl();
  syncPickerWithUrl();

  if (!pitchParam && isPitchOpen()) {
    closePitchModalSilently();
  } else if (pitchParam && app.results?.brands) {
    restorePitchFromUrl();
  }

  if (domain) {
    performSearch(domain, { fromUrlRestore: true });
  } else if (!getSearchParam()) {
    goToLanding();
  }
}

function getSearchParam() {
  return new URLSearchParams(window.location.search).get('q');
}
