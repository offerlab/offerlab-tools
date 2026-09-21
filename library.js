/**
 * The collabs library: every published demo bundle on a draggable shelf, from library/snapshot.json
 * and nothing else (OL-3832, OL-4032). No OfferLab calls, no account; a guest at a booth gets it.
 */
import { icon } from './icons.js';

const SNAPSHOT_URL = 'library/snapshot.json';
const SHELVES = 4;
const KEY_STEP = 160;
const FRICTION = 0.92;
const DRAG_THRESHOLD = 6;
const MOBILE = window.matchMedia('(max-width: 900px)');

const PARAMS = { query: 'lq', category: 'cat', brand: 'brand', store: 'store' };
const TILE_COVER_WIDTH = 480;
const COVER_MARGIN = 600;

const state = {
  bundles: [],
  categories: [],
  filters: { query: '', category: '', brand: '', store: '' },
  visible: [],
  pan: { x: 0, y: 0 },
  bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  velocity: { x: 0, y: 0 },
  dragging: false,
  moved: false,
  lastTile: null,
  loaded: false
};

const dom = {};

export async function initLibrary() {
  dom.section = document.getElementById('librarySection');
  if (!dom.section) return;
  dom.viewport = document.getElementById('libraryViewport');
  dom.board = document.getElementById('libraryBoard');
  dom.shelves = [...dom.board.querySelectorAll('.library-shelf-row')];
  dom.form = document.getElementById('libraryForm');
  dom.input = document.getElementById('libraryInput');
  dom.filterBtn = document.getElementById('libraryFilterBtn');
  dom.popover = document.getElementById('libraryFilters');
  dom.count = document.getElementById('libraryCount');
  dom.empty = document.getElementById('libraryEmpty');
  dom.lightbox = document.getElementById('libraryLightbox');

  bindViewport();
  bindOmnibox();
  bindLightbox();
  dom.viewport.addEventListener('scroll', scheduleReveal, { passive: true });
  window.addEventListener('resize', () => { if (state.loaded) layout(); });
}

/** Called by app.js when the mode switches in; loads on first use. */
export async function showLibrary() {
  dom.section.classList.remove('hidden');
  if (!state.loaded) await load();
  readFiltersFromUrl();
  apply();
}

export function hideLibrary() {
  dom.section.classList.add('hidden');
  closeLightbox();
  closeFilters();
}

export function libraryFilterParams() {
  return PARAMS;
}

/* -------------------------------------------------------------------------- */
/* Data                                                                        */
/* -------------------------------------------------------------------------- */

async function load() {
  const response = await fetch(SNAPSHOT_URL);
  const snapshot = await response.json();
  state.bundles = snapshot.bundles.map(bundle => ({
    ...bundle,
    // One lowercased haystack per bundle, built once, so typing filters without re-joining.
    haystack: [bundle.name, bundle.anchorBrand, ...bundle.brands, ...bundle.products, bundle.category.replace(/-/g, ' ')]
      .join(' • ').toLowerCase()
  }));
  state.categories = snapshot.categories.filter(c => state.bundles.some(b => b.category === c));
  renderFilterOptions();
  renderTiles();
  state.loaded = true;
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
/* Tiles and shelves                                                           */
/* -------------------------------------------------------------------------- */

function renderTiles() {
  state.bundles.forEach(bundle => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'library-tile';
    tile.dataset.id = bundle.id;
    tile.setAttribute('aria-label', `${bundle.name}, ${bundle.brands.join(', ')}`);
    tile.innerHTML = `
      <span class="library-tile-cover"><img data-src="${escape(coverUrl(bundle.cover, TILE_COVER_WIDTH))}" alt="" decoding="async"></span>
      <span class="library-tile-name">${escape(bundle.name)}</span>`;
    tile.querySelector('img').addEventListener('error', () => tile.classList.add('is-bare'), { once: true });
    bundle.tile = tile;
  });
}

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

/** Visible bundles dealt across the shelves in turn, so a filter leaves the board balanced. */
function placeTiles() {
  dom.shelves.forEach(row => row.replaceChildren());
  state.visible.forEach((bundle, index) => dom.shelves[index % SHELVES].appendChild(bundle.tile));
  dom.board.querySelectorAll('.library-shelf').forEach((shelf, i) => {
    shelf.hidden = !dom.shelves[i].childElementCount;
  });
}

/* A cover loads the first time its tile comes within COVER_MARGIN of the viewport. Measured
   directly: the board is a transformed layer in a clipped viewport that never scrolls on desktop,
   which neither native lazy loading nor an observer reported reliably. */
function revealCovers() {
  state.revealQueued = false;
  const view = dom.viewport.getBoundingClientRect();
  const left = view.left - COVER_MARGIN, right = view.right + COVER_MARGIN;
  const top = view.top - COVER_MARGIN, bottom = view.bottom + COVER_MARGIN;
  for (const bundle of state.visible) {
    const img = bundle.tile.querySelector('img');
    if (img.src) continue;
    const r = bundle.tile.getBoundingClientRect();
    if (r.right > left && r.left < right && r.bottom > top && r.top < bottom) img.src = img.dataset.src;
  }
}

function scheduleReveal() {
  if (state.revealQueued) return;
  state.revealQueued = true;
  requestAnimationFrame(revealCovers);
}

/* -------------------------------------------------------------------------- */
/* Filtering                                                                   */
/* -------------------------------------------------------------------------- */

function matches(bundle) {
  const { query, category, brand, store } = state.filters;
  if (category && bundle.category !== category) return false;
  if (store && bundle.store !== store) return false;
  if (brand && !bundle.brands.some(b => b.toLowerCase() === brand.toLowerCase())) return false;
  if (query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.every(term => bundle.haystack.includes(term))) return false;
  }
  return true;
}

function apply() {
  state.visible = state.bundles.filter(matches);
  placeTiles();
  const n = state.visible.length;
  dom.count.textContent = n === state.bundles.length ? `${n} bundles` : `${n} of ${state.bundles.length}`;
  dom.empty.classList.toggle('hidden', n > 0);
  dom.board.classList.toggle('hidden', n === 0);
  dom.filterBtn.classList.toggle('is-active', !!(state.filters.category || state.filters.brand || state.filters.store));
  writeFiltersToUrl();
  layout({ recentre: true });
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
  dom.input.addEventListener('input', () => { state.filters.query = dom.input.value.trim(); apply(); });
  dom.filterBtn.addEventListener('click', () => (dom.popover.classList.contains('hidden') ? openFilters() : closeFilters()));
  dom.popover.addEventListener('change', event => {
    const select = event.target.closest('select');
    if (!select) return;
    state.filters[select.dataset.filter] = select.value;
    apply();
  });
  dom.section.addEventListener('click', event => {
    if (event.target.closest('[data-action="library-clear"]')) clearFilters();
  });
  document.addEventListener('click', event => {
    if (dom.popover.classList.contains('hidden')) return;
    if (!event.target.closest('#libraryFilters') && !event.target.closest('#libraryFilterBtn')) closeFilters();
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
/* The board: drag, wheel, keys, bounds                                        */
/* -------------------------------------------------------------------------- */

function bindViewport() {
  const view = dom.viewport;

  view.addEventListener('pointerdown', event => {
    if (MOBILE.matches || event.button !== 0) return;
    if (event.target.closest('.library-omni, .library-lightbox')) return;
    state.dragging = true;
    state.moved = false;
    state.suppressClick = false;
    state.velocity = { x: 0, y: 0 };
    state.origin = { x: event.clientX - state.pan.x, y: event.clientY - state.pan.y, lastX: event.clientX, lastY: event.clientY, t: performance.now() };
    state.pointerId = event.pointerId;
  });

  view.addEventListener('pointermove', event => {
    if (!state.dragging) return;
    const now = performance.now();
    const dt = Math.max(1, now - state.origin.t);
    state.velocity = { x: (event.clientX - state.origin.lastX) / dt * 16, y: (event.clientY - state.origin.lastY) / dt * 16 };
    state.origin.lastX = event.clientX; state.origin.lastY = event.clientY; state.origin.t = now;
    const x = event.clientX - state.origin.x;
    const y = event.clientY - state.origin.y;
    if (!state.moved && Math.hypot(x - state.pan.x, y - state.pan.y) > DRAG_THRESHOLD) {
      state.moved = true;
      view.setPointerCapture(state.pointerId);
      view.classList.add('is-dragging');
    }
    if (state.moved) setPan(x, y);
  });

  // The click that follows a drag's pointerup is the drag's own; the flag it consumes is set here
  // and cleared on the next pointerdown, so it can never swallow a later, separate click.
  const release = () => {
    if (!state.dragging) return;
    state.dragging = false;
    view.classList.remove('is-dragging');
    if (view.hasPointerCapture?.(state.pointerId)) view.releasePointerCapture(state.pointerId);
    state.suppressClick = state.moved;
    if (state.moved) glide();
  };
  view.addEventListener('pointerup', release);
  view.addEventListener('pointercancel', release);

  // A drag that moved is not a click on whatever it ended over.
  view.addEventListener('click', event => {
    if (state.suppressClick) { event.stopPropagation(); event.preventDefault(); state.suppressClick = false; return; }
    const tile = event.target.closest('.library-tile');
    if (tile) openLightbox(tile.dataset.id, tile);
  }, true);

  view.addEventListener('wheel', event => {
    if (MOBILE.matches) return;
    event.preventDefault();
    setPan(state.pan.x - event.deltaX, state.pan.y - event.deltaY);
  }, { passive: false });

  view.addEventListener('keydown', event => {
    if (MOBILE.matches) return;
    const step = { ArrowLeft: [KEY_STEP, 0], ArrowRight: [-KEY_STEP, 0], ArrowUp: [0, KEY_STEP], ArrowDown: [0, -KEY_STEP] }[event.key];
    if (!step) return;
    event.preventDefault();
    setPan(state.pan.x + step[0], state.pan.y + step[1]);
  });
}

function glide() {
  const tick = () => {
    if (state.dragging) return;
    state.velocity.x *= FRICTION;
    state.velocity.y *= FRICTION;
    if (Math.abs(state.velocity.x) < 0.2 && Math.abs(state.velocity.y) < 0.2) return;
    setPan(state.pan.x + state.velocity.x, state.pan.y + state.velocity.y);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function setPan(x, y) {
  const { minX, maxX, minY, maxY } = state.bounds;
  state.pan.x = Math.min(maxX, Math.max(minX, x));
  state.pan.y = Math.min(maxY, Math.max(minY, y));
  dom.board.style.transform = `translate3d(${Math.round(state.pan.x)}px, ${Math.round(state.pan.y)}px, 0)`;
  scheduleReveal();
}

/**
 * The board may be dragged until its far edge meets the viewport's, and no further. Smaller than
 * the viewport on an axis, it sits centred and does not move on that axis.
 */
function layout({ recentre = false } = {}) {
  if (MOBILE.matches) { dom.board.style.transform = ''; revealCovers(); return; }
  const view = dom.viewport.getBoundingClientRect();
  const board = { w: dom.board.scrollWidth, h: dom.board.scrollHeight };
  const slackX = view.width - board.w;
  const slackY = view.height - board.h;
  state.bounds = {
    minX: Math.min(0, slackX), maxX: Math.max(0, slackX),
    minY: Math.min(0, slackY), maxY: Math.max(0, slackY)
  };
  if (recentre) setPan(slackX / 2, slackY / 2);
  else setPan(state.pan.x, state.pan.y);
  revealCovers();
}

/* -------------------------------------------------------------------------- */
/* The lightbox                                                                */
/* -------------------------------------------------------------------------- */

function bindLightbox() {
  dom.lightbox.addEventListener('click', event => {
    if (event.target === dom.lightbox || event.target.closest('[data-action="library-close"]')) closeLightbox();
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
  dom.lightbox.querySelector('.library-lightbox-card').innerHTML = `
    <button type="button" class="icon-button library-lightbox-close" data-action="library-close" aria-label="Close">${icon('cross-large', { size: 16 })}</button>
    <div class="library-lightbox-cover"><img src="${escape(bundle.cover)}" alt=""></div>
    <div class="library-lightbox-body">
      <p class="library-lightbox-eyebrow">${escape(label(bundle.category))} · ${escape(bundle.store)}</p>
      <h2 class="library-lightbox-title" id="libraryLightboxTitle">${escape(bundle.name)}</h2>
      <ul class="library-lightbox-brands">${bundle.brands.map(b => `<li>${escape(b)}</li>`).join('')}</ul>
      ${bundle.products.length ? `<p class="library-lightbox-products">${escape(bundle.products.join(', '))}</p>` : ''}
      <a class="btn btn--lg btn--primary library-lightbox-open" href="${escape(bundle.pdpUrl)}" target="_blank" rel="noopener">
        Open the bundle ${icon('arrow-up-right', { size: 16 })}
      </a>
    </div>`;
  dom.lightbox.classList.remove('hidden');
  requestAnimationFrame(() => dom.lightbox.classList.add('is-open'));
  dom.lightbox.querySelector('.library-lightbox-open').focus();
}

function closeLightbox() {
  if (dom.lightbox.classList.contains('hidden')) return;
  dom.lightbox.classList.remove('is-open');
  dom.lightbox.classList.add('hidden');
  state.lastTile?.focus();
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
