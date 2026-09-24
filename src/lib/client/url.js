/**
 * The finder's state in the URL: ?q= for the search, ?pitch= for the open pitch, ?pick= for the
 * picker, ?view=library for the Showcase (with its own filter params), ?refresh=1 to search again.
 *
 * Writes go through SvelteKit's shallow routing so its history bookkeeping stays intact; reads
 * are plain, so they work from any module. Back/forward is handled by the page's popstate listener.
 */
import { pushState, replaceState } from '$app/navigation';

export const SEARCH_PARAM = 'q';
export const PITCH_PARAM = 'pitch';
export const PICK_PARAM = 'pick';
export const MODE_PARAM = 'view';
export const REFRESH_PARAM = 'refresh';

export function currentUrl() {
  return new URL(window.location.href);
}

export function param(name) {
  const value = new URLSearchParams(window.location.search).get(name);
  return value ? value.trim() : null;
}

/** Pushes a history entry with the URL edited in place. */
export function pushUrl(edit, state = {}) {
  const url = currentUrl();
  edit(url);
  try {
    pushState(url, state);
  } catch {
    // Before SvelteKit's router is up (the first paint's URL restore), the browser's own API
    // with SvelteKit's state object keeps its bookkeeping intact.
    history.pushState(history.state, '', url.toString());
  }
}

/** Replaces the current entry with the URL edited in place. */
export function replaceUrl(edit) {
  const url = currentUrl();
  edit(url);
  try {
    replaceState(url, {});
  } catch {
    history.replaceState(history.state, '', url.toString());
  }
}

export function getSearchFromUrl() {
  return param(SEARCH_PARAM);
}

export function updateUrlForSearch(domain) {
  pushUrl(url => url.searchParams.set(SEARCH_PARAM, domain), { q: domain });
}

export function clearSearchFromUrl() {
  replaceUrl(url => {
    url.searchParams.delete(SEARCH_PARAM);
    url.searchParams.delete(PITCH_PARAM);
    url.searchParams.delete(PICK_PARAM);
  });
}

export function getPitchFromUrl() {
  return param(PITCH_PARAM);
}

export function modeFromUrl() {
  return param(MODE_PARAM) === 'library' ? 'library' : 'finder';
}

// Read once: dropped from the URL so the next search in the session uses the store again.
export function takeRefreshRequest() {
  if (param(REFRESH_PARAM) !== '1') return false;
  replaceUrl(url => url.searchParams.delete(REFRESH_PARAM));
  return true;
}
