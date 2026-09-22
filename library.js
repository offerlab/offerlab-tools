/**
 * The collabs library: every published demo bundle on shelves that run forever in every direction,
 * from library/snapshot.json and nothing else (OL-3832, OL-4032). No OfferLab calls, no account.
 *
 * The board is virtual. A cell (row, column) maps to a bundle through a stable hash, so the grid
 * is unbounded, a bundle recurs across it, and a shared link lays out the same way twice. Only the
 * cells near the viewport exist in the DOM; panning creates and drops them.
 */
import { icon } from './icons.js';

const SNAPSHOT_URL = 'library/snapshot.json';
const MOBILE = window.matchMedia('(max-width: 900px)');
const PARAMS = { query: 'lq', category: 'cat', brand: 'brand', store: 'store' };

// Geometry, owned here and mirrored onto the section as custom properties so the CSS cannot drift.
// A shelf is a run of planks; each plank carries PER_PLANK tiles; odd rows sit half a plank over.
const TILE = 220;
const GAP = 32;
const PER_PLANK = 5;
const OVERHANG = 56;
const PLANK_GAP = 160;
const PLANK_H = 18;
const AIR = 64;
const PLANK_W = PER_PLANK * TILE + (PER_PLANK - 1) * GAP + 2 * OVERHANG;
const SEG_W = PLANK_W + PLANK_GAP;
const SHELF_H = AIR + TILE + PLANK_H;
const TILE_COVER_WIDTH = 480;
const SEED = 0x9e3779b1;

const KEY_STEP = 160;
const FRICTION = 0.92;
const DRAG_THRESHOLD = 6;

const state = {
  bundles: [],
  categories: [],
  filters: { query: '', category: '', brand: '', store: '' },
  visible: [],
  pan: { x: 0, y: 0 },
  velocity: { x: 0, y: 0 },
  rows: new Map(),
  cells: new Map(),
  planks: new Map(),
  dragging: false,
  moved: false,
  suppressClick: false,
  pointerId: null,
  renderQueued: false,
  lastTile: null,
  loaded: false,
  placed: false
};

const dom = {};

export async function initLibrary() {
  dom.section = document.getElementById('librarySection');
  if (!dom.section) return;
  dom.viewport = document.getElementById('libraryViewport');
  dom.board = document.getElementById('libraryBoard');
  dom.grid = document.getElementById('libraryGrid');
  dom.form = document.getElementById('libraryForm');
  dom.input = document.getElementById('libraryInput');
  dom.filterBtn = document.getElementById('libraryFilterBtn');
  dom.popover = document.getElementById('libraryFilters');
  dom.count = document.getElementById('libraryCount');
  dom.empty = document.getElementById('libraryEmpty');
  dom.lightbox = document.getElementById('libraryLightbox');

  const geometry = { tile: TILE, gap: GAP, plank: PLANK_H, 'plank-w': PLANK_W, overhang: OVERHANG, air: AIR, shelf: SHELF_H };
  for (const [name, value] of Object.entries(geometry)) dom.section.style.setProperty(`--lib-${name}`, `${value}px`);

  bindViewport();
  bindOmnibox();
  bindLightbox();
  window.addEventListener('resize', () => { if (state.loaded) render(); });
  MOBILE.addEventListener('change', () => { if (state.loaded) apply(); });
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

function makeTile(bundle) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'library-tile';
  tile.dataset.id = bundle.id;
  tile.setAttribute('aria-label', `${bundle.name}, ${bundle.brands.join(', ')}`);
  tile.innerHTML = `
    <span class="library-tile-cover"><img src="${escape(coverUrl(bundle.cover, TILE_COVER_WIDTH))}" alt="" decoding="async"></span>
    <span class="library-tile-name">${escape(bundle.name)}</span>`;
  tile.querySelector('img').addEventListener('error', () => tile.classList.add('is-bare'), { once: true });
  return tile;
}

/* -------------------------------------------------------------------------- */
/* The virtual board                                                           */
/* -------------------------------------------------------------------------- */

function mix(row, col) {
  let h = (Math.imul(row, 73856093) ^ Math.imul(col, 19349663) ^ SEED) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Which bundle a cell holds. A hash rather than a shuffle so that any cell, however far out, has
 * an answer without a table, and the same answer on the next visit. A cell that would repeat its
 * left or upper neighbor takes the next bundle instead.
 */
function bundleAt(row, col) {
  const n = state.visible.length;
  let i = mix(row, col) % n;
  if (n > 2 && (i === mix(row, col - 1) % n || i === mix(row - 1, col) % n)) i = (i + 1) % n;
  return state.visible[i];
}

const rowOffset = r => (r & 1 ? SEG_W / 2 : 0);
const tileX = i => OVERHANG + i * (TILE + GAP);

function rowFor(r) {
  let row = state.rows.get(r);
  if (row) return row;
  const el = document.createElement('div');
  el.className = 'library-shelf';
  el.style.transform = `translate3d(0, ${r * SHELF_H}px, 0)`;
  // Later rows paint over earlier ones so a plank's shadow falls behind the glow of the row below.
  el.style.zIndex = String(r + 1e6);
  row = { el, r };
  state.rows.set(r, row);
  dom.board.appendChild(el);
  return row;
}

function plankFor(row, s) {
  const key = `${row.r}:${s}`;
  let plank = state.planks.get(key);
  if (plank) return plank;
  plank = document.createElement('div');
  plank.className = 'library-plank';
  plank.style.left = `${s * SEG_W + rowOffset(row.r)}px`;
  plank.innerHTML = '<div class="library-plank-glow"></div><div class="library-plank-shadow"></div><div class="library-plank-slab"></div>';
  state.planks.set(key, plank);
  row.el.appendChild(plank);
  return plank;
}

/** Creates what the viewport can see plus one cell of margin, drops the rest. */
function render() {
  if (MOBILE.matches || !state.visible.length) return;
  const view = dom.viewport.getBoundingClientRect();
  const x0 = -state.pan.x - SEG_W, x1 = -state.pan.x + view.width + SEG_W;
  const r0 = Math.floor(-state.pan.y / SHELF_H) - 1, r1 = Math.ceil((-state.pan.y + view.height) / SHELF_H) + 1;
  const keepCells = new Set(), keepPlanks = new Set();

  for (let r = r0; r <= r1; r++) {
    const row = rowFor(r);
    const s0 = Math.floor((x0 - rowOffset(r)) / SEG_W), s1 = Math.floor((x1 - rowOffset(r)) / SEG_W);
    for (let s = s0; s <= s1; s++) {
      keepPlanks.add(`${r}:${s}`);
      const plank = plankFor(row, s);
      for (let i = 0; i < PER_PLANK; i++) {
        const c = s * PER_PLANK + i;
        const key = `${r}:${c}`;
        keepCells.add(key);
        if (state.cells.has(key)) continue;
        const tile = makeTile(bundleAt(r, c));
        tile.style.left = `${tileX(i)}px`;
        state.cells.set(key, tile);
        plank.appendChild(tile);
      }
    }
  }

  for (const [key, tile] of state.cells) if (!keepCells.has(key)) { tile.remove(); state.cells.delete(key); }
  for (const [key, plank] of state.planks) if (!keepPlanks.has(key)) { plank.remove(); state.planks.delete(key); }
  for (const [r, row] of state.rows) if (r < r0 || r > r1) { row.el.remove(); state.rows.delete(r); }
}

function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => { state.renderQueued = false; render(); });
}

function clearBoard() {
  dom.board.replaceChildren();
  state.rows.clear();
  state.cells.clear();
  state.planks.clear();
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
  const n = state.visible.length;
  dom.count.textContent = n === state.bundles.length ? `${n} bundles` : `${n} of ${state.bundles.length}`;
  dom.empty.classList.toggle('hidden', n > 0);
  dom.filterBtn.classList.toggle('is-active', !!(state.filters.category || state.filters.brand || state.filters.store));
  writeFiltersToUrl();

  clearBoard();
  dom.grid.replaceChildren();
  if (!n) return;
  if (MOBILE.matches) {
    // A phone scrolls the visible bundles once each, no repeats.
    dom.grid.replaceChildren(...state.visible.map(makeTile));
    return;
  }
  // The first plank of row 0 opens centered; after that the pan is kept, so a filter changes what
  // is on the shelves and not where you are.
  if (!state.placed) {
    const view = dom.viewport.getBoundingClientRect();
    state.pan = { x: Math.round((view.width - PLANK_W) / 2), y: Math.round(view.height / 2 - AIR - TILE / 2) };
    state.placed = true;
  }
  setPan(state.pan.x, state.pan.y);
  render();
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
/* Panning: drag, wheel, keys                                                  */
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
    // Capturing on pointerdown would retarget the click to the viewport instead of the tile, so
    // the capture waits for a real drag.
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

/** Unbounded: the board has no edge to meet. */
function setPan(x, y) {
  state.pan.x = x;
  state.pan.y = y;
  dom.board.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  scheduleRender();
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
  dom.grid.addEventListener('click', event => {
    const tile = event.target.closest('.library-tile');
    if (tile) openLightbox(tile.dataset.id, tile);
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
  // The tile may have been dropped out of the window while the lightbox was open.
  (state.lastTile?.isConnected ? state.lastTile : dom.viewport).focus();
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
