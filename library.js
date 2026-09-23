/**
 * The collabs library: every published demo bundle on shelves that run forever in every direction,
 * from library/snapshot.json and nothing else (OL-3832, OL-4032). No OfferLab calls, no account.
 *
 * The board is virtual. Each row deals the bundles in a shuffle seeded by its row number and
 * repeats it, so the grid is unbounded, a bundle recurs across it, and a shared link lays out the
 * same way twice. Only the cells near the viewport exist in the DOM; panning creates and drops them.
 */
import { icon } from './icons.js';
import { createBoard } from './library-board.js';

// The live read; the committed snapshot stands in when it fails.
const LIBRARY_URL = '/api/library';
const SNAPSHOT_URL = 'library/snapshot.json';
// A bundle put on the store's Online Store channel shows up within this while the Showcase is open.
const REFRESH_MS = 45000;
const BRANDS_URL = 'library/brands.json';

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
const MOBILE = window.matchMedia('(max-width: 900px)');
const PARAMS = { query: 'lq', category: 'cat', brand: 'brand', store: 'store' };

const EYEBROW_CHIPS = 2;
const TYPING_MS = 120;
const FLIP_MS = 650;
// Closing is the plainer move: the card scales back onto the shelf, no turn.
const CLOSE_MS = 380;
const TILE_COVER_WIDTH = 480;
const LIGHTBOX_COVER_WIDTH = 1200;

const state = {
  bundles: [],
  categories: [],
  filters: { query: '', category: '', brand: '', store: '' },
  visible: [],
  lastTile: null,
  logos: {},
  loaded: false
};

// The shelves themselves: dealing, the camera and every gesture live in library-board.js.
let board = null;

const dom = {};

export async function initLibrary() {
  dom.section = document.getElementById('librarySection');
  if (!dom.section) return;
  dom.viewport = document.getElementById('libraryViewport');
  dom.board = document.getElementById('libraryBoard');
  dom.form = document.getElementById('libraryForm');
  dom.input = document.getElementById('libraryInput');
  dom.filterBtn = document.getElementById('libraryFilterBtn');
  dom.popover = document.getElementById('libraryFilters');
  dom.eyebrow = document.getElementById('libraryEyebrow');
  dom.eyebrowChips = document.getElementById('libraryEyebrowChips');
  dom.empty = document.getElementById('libraryEmpty');
  dom.emptyTitle = document.getElementById('libraryEmptyTitle');
  dom.lightbox = document.getElementById('libraryLightbox');
  // Out of the section, whose stacking context would keep it under the fixed header.
  document.body.appendChild(dom.lightbox);

  board = createBoard({
    section: dom.section,
    viewport: dom.viewport,
    el: dom.board,
    media: MOBILE,
    coverUrl,
    escape,
    onTile: openLightbox
  });
  bindOmnibox();
  bindLightbox();
  window.addEventListener('resize', () => board.resize());
}

/** Called by app.js when the mode switches in; loads on first use. */
export async function showLibrary() {
  dom.section.classList.remove('hidden');
  board.show();
  if (!state.loaded) await load();
  readFiltersFromUrl();
  apply();
  watchForNewBundles();
}

export function hideLibrary() {
  dom.section.classList.add('hidden');
  closeLightbox();
  closeFilters();
  stopWatching();
}

export function libraryFilterParams() {
  return PARAMS;
}

/* -------------------------------------------------------------------------- */
/* Data                                                                        */
/* -------------------------------------------------------------------------- */

async function load() {
  const [snapshot, logos] = await Promise.all([
    fetchLibrary(),
    fetch(BRANDS_URL).then(r => (r.ok ? r.json() : {})).catch(() => ({}))
  ]);
  state.logos = logos;
  take(snapshot);
  state.loaded = true;
}

async function fetchLibrary() {
  try {
    const response = await fetch(LIBRARY_URL, { cache: 'no-store' });
    if (response.ok) return await response.json();
  } catch { /* the snapshot below */ }
  return fetch(SNAPSHOT_URL).then(r => r.json());
}

function take(snapshot) {
  state.bundles = snapshot.bundles.filter(bundle => bundle.cover).map(bundle => ({
    ...bundle,
    // Every word of the bundle, stemmed once, so a query is a set lookup per term.
    tokens: new Set(words([bundle.name, ...bundle.brands, ...bundle.products,
      bundle.category.replace(/-/g, ' '), bundle.description].join(' ')).map(stem))
  }));
  state.categories = snapshot.categories.filter(c => state.bundles.some(b => b.category === c));
  renderFilterOptions();
}

/* A bundle published from OfferLab reaches the store's listing when it goes on the Online Store
   channel, and the live read reflects that at once. While the Showcase is open it is re-read on
   a timer and whenever the tab comes back into view, which is the moment after the channel was
   turned on in the Shopify admin. The board is dealt again only when the set of bundles changed,
   and never over an open lightbox. */
function watchForNewBundles() {
  if (state.watching) return;
  state.watching = true;
  const check = async () => {
    if (document.hidden || !state.watching) return;
    const snapshot = await fetchLibrary().catch(() => null);
    if (!snapshot || !state.watching) return;
    const ids = snapshot.bundles.map(bundle => bundle.id).join('\n');
    if (ids === state.bundles.map(bundle => bundle.id).join('\n')) return;
    if (!dom.lightbox.classList.contains('hidden')) return;
    take(snapshot);
    apply();
  };
  state.refreshTimer = setInterval(check, REFRESH_MS);
  state.onVisible = () => { if (!document.hidden) check(); };
  document.addEventListener('visibilitychange', state.onVisible);
}

function stopWatching() {
  state.watching = false;
  clearInterval(state.refreshTimer);
  document.removeEventListener('visibilitychange', state.onVisible);
}

const label = slug => slug.replace(/-and-/g, ' & ').replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());

function renderFilterOptions() {
  const brands = [...new Set(state.bundles.flatMap(b => b.brands))].sort((a, b) => a.localeCompare(b));
  const stores = [...new Set(state.bundles.map(b => b.store))];
  fillSelect('libraryCategory', state.categories.map(c => [c, label(c)]), 'All categories');
  fillSelect('libraryBrand', brands.map(b => [b, b]), 'All brands');
  fillSelect('libraryStore', stores.map(s => [s, s]), 'All stores');
  document.getElementById('libraryStoreField').hidden = stores.length < 2;
}

function fillSelect(id, options, allLabel) {
  const select = document.getElementById(id);
  select.innerHTML = `<option value="">${allLabel}</option>` +
    options.map(([value, text]) => `<option value="${escape(value)}">${escape(text)}</option>`).join('');
}

/* -------------------------------------------------------------------------- */
/* Tiles                                                                       */
/* -------------------------------------------------------------------------- */

/** The Shopify CDN sizes on request; a tile never needs the full hero the lightbox shows. */
function coverUrl(url, width) {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('shopify.com')) u.searchParams.set('width', String(width));
    return u.toString();
  } catch {
    return url;
  }
}

/* -------------------------------------------------------------------------- */
/* Filtering                                                                   */
/* -------------------------------------------------------------------------- */

const words = text => text.toLowerCase().replace(/[’'"“”]/g, '').split(/[^a-z0-9+-]+/).filter(Boolean);
const stem = word => word.replace(/ies$/, 'y').replace(/(sses|shes|ches|xes)$/, m => m.slice(0, -2)).replace(/([^s])s$/, '$1');
const queryTerms = query => [...new Set(words(query).filter(w => !STOPWORDS.has(w)).map(w => SYNONYMS[w] || w).map(stem))];

function matchesFilters(bundle) {
  const { category, brand, store } = state.filters;
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

function apply() {
  state.visible = search(state.bundles.filter(matchesFilters), state.filters.query);
  const n = state.visible.length;
  renderEyebrow(n);
  renderEmpty(n);
  dom.filterBtn.classList.toggle('is-active', !!(state.filters.category || state.filters.brand || state.filters.store));
  writeFiltersToUrl();
  board.setBundles(state.visible);
}

/** The popover's filters, in the order the chips show. A typed query stays in the box, not here. */
function narrowedBy() {
  const { category, brand, store } = state.filters;
  return [
    category && { key: 'category', label: label(category) },
    brand && { key: 'brand', label: brand },
    store && { key: 'store', label: store }
  ].filter(Boolean);
}

/**
 * Only while a popover filter narrows the shelves: the count, a chip per filter with its own
 * remove, the rest folded into "+n more" that opens the popover, and Clear on the far right.
 */
function renderEyebrow(n) {
  const applied = narrowedBy();
  dom.eyebrow.classList.toggle('hidden', !applied.length);
  const chips = applied.slice(0, EYEBROW_CHIPS).map(({ key, label }) => `
    <span class="library-chip">${escape(label)}
      <button type="button" class="library-chip-remove" data-remove="${key}" aria-label="Remove ${escape(label)}">${icon('cross-large', { size: 10 })}</button>
    </span>`);
  const more = applied.length - EYEBROW_CHIPS;
  if (more > 0) chips.push(`<button type="button" class="library-chip library-chip--more" data-action="library-more">+${more} more</button>`);
  dom.eyebrowChips.innerHTML = `<span class="library-eyebrow-count">${n} of ${state.bundles.length}</span>${chips.join('')}`;
}

/** The shelves stay up, dealt with glass placeholders; the message sits on a blur over them. */
function renderEmpty(n) {
  dom.empty.classList.toggle('hidden', n > 0);
  if (n) return;
  dom.emptyTitle.textContent = `Nothing on the shelf for ${narrowedBy().map(f => f.label).join(' · ')}`;
}

function removeFilter(key) {
  state.filters[key] = '';
  dom.popover.querySelector(`[data-filter="${key}"]`).value = '';
  apply();
}

function readFiltersFromUrl() {
  const params = new URLSearchParams(location.search);
  for (const [key, param] of Object.entries(PARAMS)) state.filters[key] = params.get(param) || '';
  dom.input.value = state.filters.query;
  document.getElementById('libraryCategory').value = state.filters.category;
  document.getElementById('libraryBrand').value = state.filters.brand;
  document.getElementById('libraryStore').value = state.filters.store;
}

function writeFiltersToUrl() {
  const url = new URL(location.href);
  for (const [key, param] of Object.entries(PARAMS)) {
    if (state.filters[key]) url.searchParams.set(param, state.filters[key]);
    else url.searchParams.delete(param);
  }
  history.replaceState(history.state, '', url.toString());
}

function clearFilters() {
  state.filters = { query: '', category: '', brand: '', store: '' };
  dom.input.value = '';
  dom.popover.querySelectorAll('select').forEach(select => { select.value = ''; });
  apply();
}

/* -------------------------------------------------------------------------- */
/* The omnibox and its filter popover                                          */
/* -------------------------------------------------------------------------- */

function bindOmnibox() {
  dom.form.addEventListener('submit', event => event.preventDefault());
  // A pause in typing deals once; every keystroke would deal a shelf of covers for "c", "co"...
  dom.input.addEventListener('input', () => {
    clearTimeout(state.typing);
    state.typing = setTimeout(() => { state.filters.query = dom.input.value.trim(); apply(); }, TYPING_MS);
  });
  dom.filterBtn.addEventListener('click', () => (dom.popover.classList.contains('hidden') ? openFilters() : closeFilters()));
  dom.popover.addEventListener('change', event => {
    const select = event.target.closest('select');
    if (!select) return;
    state.filters[select.dataset.filter] = select.value;
    apply();
  });
  dom.section.addEventListener('click', event => {
    if (event.target.closest('[data-action="library-clear"]')) clearFilters();
    else if (event.target.closest('[data-action="library-more"]')) openFilters();
    else if (event.target.closest('[data-remove]')) removeFilter(event.target.closest('[data-remove]').dataset.remove);
  });
  document.addEventListener('click', event => {
    if (dom.popover.classList.contains('hidden')) return;
    if (!event.target.closest('#libraryFilters, #libraryFilterBtn, [data-action="library-more"]')) closeFilters();
  });
}

function openFilters() {
  dom.popover.classList.remove('hidden');
  dom.filterBtn.setAttribute('aria-expanded', 'true');
}

function closeFilters() {
  dom.popover.classList.add('hidden');
  dom.filterBtn.setAttribute('aria-expanded', 'false');
}

/* -------------------------------------------------------------------------- */
/* The lightbox                                                                */
/* -------------------------------------------------------------------------- */

function bindLightbox() {
  // Anywhere but the cover and the details is the backdrop, and the backdrop closes.
  dom.lightbox.addEventListener('click', event => {
    if (event.target.closest('[data-action="library-close"]') || !event.target.closest('.library-lightbox-cover, .library-lightbox-body')) closeLightbox();
  });
  document.addEventListener('keydown', event => {
    if (dom.lightbox.classList.contains('hidden')) return;
    if (event.key === 'Escape') { event.preventDefault(); closeLightbox(); return; }
    if (event.key === 'Tab') trapFocus(event);
  });
}

function openLightbox(id, tile) {
  const bundle = state.bundles.find(b => b.id === id);
  if (!bundle) return;
  state.lastTile = tile;
  const card = dom.lightbox.querySelector('.library-lightbox-card');
  // The close control lives beside the card, not in it: a transformed card is the containing
  // block of anything fixed inside it, and the control would ride the flip, then jump.
  if (!dom.lightbox.querySelector('.library-lightbox-close')) {
    dom.lightbox.insertAdjacentHTML('beforeend', `<button type="button" class="icon-button library-lightbox-close" data-action="library-close" aria-label="Close">${icon('cross-large', { size: 16 })}</button>`);
  }
  card.innerHTML = `
    <div class="library-lightbox-cover"><img src="${escape(coverUrl(bundle.cover, TILE_COVER_WIDTH))}" alt=""></div>
    <div class="library-lightbox-body">
      <p class="library-lightbox-collab">
        <span class="library-lightbox-stack" aria-hidden="true">${bundle.brands.map(brandMark).join('')}</span>
        <span class="library-lightbox-names">${bundle.brands.map(escape).join(' x ')}</span>
      </p>
      <h2 class="library-lightbox-title" id="libraryLightboxTitle">${escape(bundle.name)}</h2>
      <ul class="library-lightbox-chips"><li>${escape(label(bundle.category))}</li></ul>
      ${bundle.products.length ? `<p class="library-lightbox-products">${escape(bundle.products.join(', '))}</p>` : ''}
      <a class="btn btn--lg btn--elevated library-lightbox-open" href="${escape(bundle.pdpUrl)}" target="_blank" rel="noopener">
        Open the bundle ${icon('arrow-up-right', { size: 16 })}
      </a>
    </div>`;
  // The card flies with the cover the tile already has; the sharp one replaces it once it lands.
  const sharp = new Image();
  sharp.onload = () => { if (state.lastTile === tile) card.querySelector('.library-lightbox-cover img').src = sharp.src; };
  sharp.src = coverUrl(bundle.cover, LIGHTBOX_COVER_WIDTH);
  clearTimeout(state.closing);
  dom.lightbox.classList.remove('hidden', 'is-closing');
  // The card starts at the tile's size where the cover stood and flies forward, turning a full
  // circle as it grows; the close control pops in last, once the card has landed.
  // Measured untransformed: the card's resting style is already scaled down.
  card.style.transition = 'none';
  card.style.transform = 'none';
  const from = liftOrigin(tile, card, { turn: true });
  if (from) {
    card.style.transformOrigin = from.origin;
    card.style.transform = from.transform;
    tile.classList.add('is-lifted');
  } else {
    card.style.transform = '';
  }
  void card.offsetWidth;
  card.style.transition = '';
  requestAnimationFrame(() => {
    dom.lightbox.classList.add('is-open');
    card.style.transform = '';
  });
  dom.lightbox.querySelector('.library-lightbox-open').focus();
}

/** A brand's avatar from the team database, or its initial where the team has none. */
function brandMark(name) {
  const logo = state.logos[name.toLowerCase()];
  return logo
    ? `<span class="library-lightbox-avatar"><img src="library/${escape(logo)}" alt=""></span>`
    : `<span class="library-lightbox-avatar">${escape(name.trim().charAt(0).toUpperCase())}</span>`;
}

/**
 * The transform that puts the card's cover over the tile at the tile's size, about the cover's
 * center, and the origin that makes it so; turned a full circle away when `turn`. Null on a phone.
 */
function liftOrigin(tile, card, { turn = false } = {}) {
  if (MOBILE.matches || !tile?.isConnected) return null;
  const t = tile.getBoundingClientRect();
  const cover = card.querySelector('.library-lightbox-cover').getBoundingClientRect();
  const c = card.getBoundingClientRect();
  const scale = t.width / cover.width;
  const ox = cover.left - c.left + cover.width / 2;
  const oy = cover.top - c.top + cover.height / 2;
  const tx = t.left + t.width / 2 - (c.left + ox);
  const ty = t.top + t.height / 2 - (c.top + oy);
  return {
    origin: `${ox.toFixed(1)}px ${oy.toFixed(1)}px`,
    transform: `perspective(1400px) translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${scale.toFixed(4)})${turn ? ' rotateY(-360deg)' : ''}`
  };
}

function closeLightbox() {
  if (dom.lightbox.classList.contains('hidden') || dom.lightbox.classList.contains('is-closing')) return;
  const card = dom.lightbox.querySelector('.library-lightbox-card');
  const tile = state.lastTile;
  const to = liftOrigin(tile, card);
  dom.lightbox.classList.remove('is-open');
  dom.lightbox.classList.add('is-closing');
  if (to) {
    card.style.transformOrigin = to.origin;
    card.style.transform = to.transform;
  }
  state.closing = setTimeout(() => {
    dom.lightbox.classList.add('hidden');
    dom.lightbox.classList.remove('is-closing');
    card.style.transform = '';
    card.style.transformOrigin = '';
    tile?.classList.remove('is-lifted');
    // The tile may have been dropped out of the window while the lightbox was open.
    (tile?.isConnected ? tile : dom.viewport).focus();
  }, to ? CLOSE_MS : 250);
}

function trapFocus(event) {
  const focusable = [...dom.lightbox.querySelectorAll('a[href], button')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
