/**
 * Search history and feedback, on D1 through store.js. The dropdown and the omnibar's
 * suggestions read history synchronously, so the store's copy is mirrored in `app.history`:
 * refreshed at start, whenever it changes, and each time a dropdown opens.
 */
import { app } from './state.svelte.js';
import * as store from './store.js';
import { CONFIG, extractDomain } from './util.js';

// Refreshes can overlap (the dropdown opening while an add settles); only the latest one lands.
let historyRefresh = 0;

export async function refreshSearchHistory() {
  const request = ++historyRefresh;
  const fresh = await store.loadHistory(CONFIG.MAX_SEARCH_HISTORY);
  // No answer from the store keeps what is on screen; a refresh that was overtaken is dropped.
  if (!fresh || request !== historyRefresh) return app.history;
  const same = fresh.length === app.history.length && fresh.every((item, i) => item.domain === app.history[i].domain);
  if (!same) app.history = fresh;
  return app.history;
}

export function addToSearchHistory(url) {
  const domain = extractDomain(url);
  // Shown at once; the store's answer settles the order behind it.
  app.history = [{ domain, url: domain, timestamp: Date.now() }, ...app.history.filter(item => item.domain !== domain)]
    .slice(0, CONFIG.MAX_SEARCH_HISTORY);
  store.addHistory(domain).then(() => refreshSearchHistory());
}

export function clearSearchHistory() {
  app.history = [];
  store.clearHistory().then(() => refreshSearchHistory());
}

export function removeFromSearchHistory(domain) {
  app.history = app.history.filter(item => item.domain !== domain);
  store.removeHistory(domain).then(() => refreshSearchHistory());
}

export function getFeedbackHistory() {
  return store.loadFeedback();
}

export function saveFeedback(searchId, inputUrl, results, rating) {
  return store.addFeedback({
    searchId,
    inputUrl,
    rating,
    results: results.map(r => ({ name: r.name, url: r.url }))
  });
}
