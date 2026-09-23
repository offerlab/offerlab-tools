/**
 * The collabs library: every published demo bundle on shelves that run forever in every direction,
 * from library/snapshot.json and nothing else (OL-3832, OL-4032). No OfferLab calls, no account.
 *
 * The board is virtual. Each row deals the bundles in a shuffle seeded by its row number and
 * repeats it, so the grid is unbounded, a bundle recurs across it, and a shared link lays out the
 * same way twice. Only the cells near the viewport exist in the DOM; panning creates and drops them.
 */
import { icon } from './icons.js';

const SNAPSHOT_URL = 'library/snapshot.json';
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

// Geometry, owned here and mirrored onto the section as custom properties so the CSS cannot drift.
// Each row is one continuous plank. A desktop's board is unbounded and pans in every direction,
// odd rows half a column over. A phone's shelves stand still and each scrolls sideways on its
// own: 2.25 columns across the viewport so the next tile is always cut off at the edge, a fixed
// number of bundles per shelf, the first one a gutter in from the left.
const DESKTOP = { tile: 220, gap: 32, plank: 18, air: 64, radius: 28 };
const PHONE = { columns: 2.25, gap: 10, plank: 14, air: 44, radius: 20, perShelf: 8, gutter: 16 };
// The board zooms like a map: the gesture scales what is there, and when it settles the board is
// dealt again at the new size around the point under the pointer or between the fingers.
const ZOOM = { min: 0.5, max: 2.4, key: 1.25, wheel: 0.01, notch: 25, settle: 140 };
const G = {};

function measure() {
  const width = dom.viewport.getBoundingClientRect().width || window.innerWidth;
  const z = state.zoom;
  if (MOBILE.matches) {
    G.colW = Math.round(width / (PHONE.columns / z));
    G.gap = PHONE.gap;
    G.tile = G.colW - G.gap;
    G.plank = Math.round(PHONE.plank * z);
    G.air = Math.round(PHONE.air * z);
    G.radius = Math.round(PHONE.radius * z);
    G.inset = PHONE.gutter - G.gap / 2;
  } else {
    for (const key of ['tile', 'gap', 'plank', 'air', 'radius']) G[key] = Math.round(DESKTOP[key] * z);
    G.colW = G.tile + G.gap;
  }
  G.shelfH = G.air + G.tile + G.plank;
  const vars = { tile: G.tile, gap: G.gap, plank: G.plank, air: G.air, shelf: G.shelfH, radius: G.radius };
  for (const [name, value] of Object.entries(vars)) dom.section.style.setProperty(`--lib-${name}`, `${value}px`);
}
const TILE_COVER_WIDTH = 480;
const EYEBROW_CHIPS = 2;
const FADE_MS = 320;
const SWEEP_MS = 200;
const TYPING_MS = 120;
// The earn-back card's feel: peak tilt at the edges, and the lift on engage.
const MAX_TILT = 9;
const HOVER_SCALE = 1.04;
const FLIP_MS = 650;
// Closing is the plainer move: the card scales back onto the shelf, no turn.
const CLOSE_MS = 380;
const LIGHTBOX_COVER_WIDTH = 1200;
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
  deal: { r: 0 },
  zoom: 1,
  zooming: null,
  dragging: false,
  moved: false,
  suppressClick: false,
  pointerId: null,
  renderQueued: false,
  lastTile: null,
  logos: {},
  tilt: null,
  loaded: false,
  placed: false
};

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

  measure();
  bindViewport();
  bindOmnibox();
  bindLightbox();
  // A new size means new cell positions, so the board is dealt again where it stands.
  const remeasure = () => { measure(); if (state.loaded) { clearBoard(); render(); } };
  window.addEventListener('resize', remeasure);
  MOBILE.addEventListener('change', remeasure);
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
  const [snapshot, logos] = await Promise.all([
    fetch(SNAPSHOT_URL).then(r => r.json()),
    fetch(BRANDS_URL).then(r => (r.ok ? r.json() : {})).catch(() => ({}))
  ]);
  state.logos = logos;
  state.bundles = snapshot.bundles.filter(bundle => bundle.cover).map(bundle => ({
    ...bundle,
    // Every word of the bundle, stemmed once, so a query is a set lookup per term.
    tokens: new Set(words([bundle.name, ...bundle.brands, ...bundle.products,
      bundle.category.replace(/-/g, ' '), bundle.description].join(' ')).map(stem))
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

/** `lazy` for a board that is dealt whole: the covers load as they scroll into view. */
function makeTile(bundle, lazy = false) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'library-tile';
  tile.dataset.id = bundle.id;
  tile.setAttribute('aria-label', `${bundle.name}, ${bundle.brands.join(', ')}`);
  const src = escape(coverUrl(bundle.cover, TILE_COVER_WIDTH));
  const loading = lazy ? ' loading="lazy"' : '';
  tile.innerHTML = `
    <span class="library-tile-cover"><img src="${src}" alt="" decoding="async"${loading}></span>
    <span class="library-tile-scrim" aria-hidden="true">
      <img class="library-tile-scrim-soft" src="${src}" alt="" decoding="async"${loading}>
      <img class="library-tile-scrim-deep" src="${src}" alt="" decoding="async"${loading}>
    </span>
    <span class="library-tile-name">${escape(bundle.name)}</span>`;
  tile.querySelector('img').addEventListener('error', () => tile.classList.add('is-bare'), { once: true });
  return tile;
}

function makeGhost() {
  const tile = document.createElement('div');
  tile.className = 'library-tile library-tile--ghost';
  tile.dataset.id = '';
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
 * Each row deals the visible bundles in its own shuffled order and repeats it, so a bundle shows
 * up once per lap of the row and never twice in a row. The shuffle is seeded by the row number,
 * so any row, however far out, deals the same way on the next visit.
 */
function orderFor(row) {
  if (row.order?.length === state.visible.length) return row.order;
  const order = state.visible.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = mix(row.r, i) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  row.order = order;
  return order;
}

const mod = (a, b) => ((a % b) + b) % b;
const bundleAt = (row, c) => state.visible[orderFor(row)[mod(c, state.visible.length)]];

const rowOffset = r => (r & 1 ? G.colW / 2 : 0);

function rowFor(r) {
  let row = state.rows.get(r);
  if (row) return row;
  const el = document.createElement('div');
  el.className = 'library-shelf';
  el.style.transform = `translate3d(0, ${r * G.shelfH}px, 0)`;
  // Later rows paint over earlier ones so a plank's shadow falls behind the glow of the row below.
  el.style.zIndex = String(r + 1e6);
  el.innerHTML = '<div class="library-shelf-glow"></div><div class="library-shelf-shadow"></div><div class="library-shelf-slab"></div><div class="library-shelf-rail"></div>';
  row = { el, r, furniture: [...el.children].slice(0, 3), rail: el.lastElementChild, fresh: true };
  state.rows.set(r, row);
  dom.board.appendChild(el);
  return row;
}

/** Creates what the viewport can see plus one cell of margin, drops the rest. */
function render() {
  if (MOBILE.matches) return renderShelves();
  const view = dom.viewport.getBoundingClientRect();
  const x0 = -state.pan.x - G.colW, x1 = -state.pan.x + view.width + G.colW;
  const r0 = Math.floor(-state.pan.y / G.shelfH) - 1, r1 = Math.ceil((-state.pan.y + view.height) / G.shelfH) + 1;
  const keep = new Set();

  for (let r = r0; r <= r1; r++) {
    const row = rowFor(r);
    for (const part of row.furniture) {
      part.style.left = `${x0}px`;
      part.style.width = `${x1 - x0}px`;
    }
    const c0 = Math.floor((x0 - rowOffset(r)) / G.colW), c1 = Math.floor((x1 - rowOffset(r)) / G.colW);
    for (let c = c0; c <= c1; c++) {
      const key = `${r}:${c}`;
      keep.add(key);
      const bundle = state.visible.length ? bundleAt(row, c) : null;
      const current = state.cells.get(key);
      if (current && current.dataset.id === (bundle?.id ?? '')) continue;
      const tile = bundle ? makeTile(bundle) : makeGhost();
      const left = c * G.colW + rowOffset(r) + G.gap / 2;
      tile.style.left = `${left}px`;
      state.cells.set(key, tile);
      if (current) crossfade(current, tile, (left + state.pan.x) / view.width);
      row.rail.appendChild(tile);
    }
  }

  for (const [key, tile] of state.cells) if (!keep.has(key)) { tile.remove(); state.cells.delete(key); }
  for (const [r, row] of state.rows) if (r < r0 || r > r1) { row.el.remove(); state.rows.delete(r); }
}

/**
 * A phone's board: every visible bundle dealt once, in one shuffled order, a shelf at a time.
 * The shelves stack in the viewport, which scrolls down; each shelf's rail scrolls sideways on
 * its own. Odd shelves open half a column along so the stagger of the desktop board survives.
 * With nothing to show, enough shelves of glass to fill the viewport stand under the message.
 */
function renderShelves() {
  const view = dom.viewport.getBoundingClientRect();
  const n = state.visible.length;
  const perShelf = n ? PHONE.perShelf : Math.ceil(PHONE.columns) + 1;
  const shelves = n ? Math.ceil(n / perShelf) : Math.ceil(view.height / G.shelfH) + 1;
  const order = n ? orderFor(state.deal) : [];
  const keep = new Set();
  dom.board.style.height = `${shelves * G.shelfH}px`;

  for (let r = 0; r < shelves; r++) {
    const row = rowFor(r);
    for (const part of row.furniture) {
      part.style.left = '0';
      part.style.width = '100%';
    }
    const count = n ? Math.min(perShelf, n - r * perShelf) : perShelf;
    for (let c = 0; c < count; c++) {
      const key = `${r}:${c}`;
      keep.add(key);
      const bundle = n ? state.visible[order[r * perShelf + c]] : null;
      const current = state.cells.get(key);
      if (current && current.dataset.id === (bundle?.id ?? '')) continue;
      const tile = bundle ? makeTile(bundle, true) : makeGhost();
      const left = c * G.colW + G.gap / 2 + G.inset;
      tile.style.left = `${left}px`;
      state.cells.set(key, tile);
      if (current) crossfade(current, tile, left / view.width);
      row.rail.appendChild(tile);
    }
    // The rail's scroll width is its tiles' reach; the gutter past the last one is this stop.
    row.rail.style.setProperty('--rail-end', `${count * G.colW + G.inset + G.gap / 2 + PHONE.gutter}px`);
    if (row.fresh) {
      row.fresh = false;
      if (r & 1) row.rail.scrollLeft = G.colW / 2;
    }
  }

  for (const [key, tile] of state.cells) if (!keep.has(key)) { tile.remove(); state.cells.delete(key); }
  for (const [r, row] of state.rows) if (r >= shelves) { row.el.remove(); state.rows.delete(r); }
}

/**
 * A cell whose bundle changed fades the new cover in over the old one, in a sweep from the left
 * of the viewport to the right. Opacity only, so the compositor does the work; the new cover
 * waits to be decoded so nothing fades in blank. The old tile leaves the cell map at once, so a
 * filter typed over a fade simply starts the next one on top.
 */
function crossfade(leaving, entering, sweep) {
  const delay = Math.round(Math.max(0, Math.min(1, sweep)) * SWEEP_MS);
  entering.classList.add('is-entering');
  leaving.classList.add('is-leaving');
  leaving.style.transitionDelay = `${delay}ms`;
  const img = entering.querySelector('img');
  const decoded = img ? img.decode().catch(() => {}) : Promise.resolve();
  decoded.then(() => setTimeout(() => {
    requestAnimationFrame(() => entering.classList.remove('is-entering'));
    setTimeout(() => leaving.remove(), FADE_MS + delay);
  }, delay));
}

function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => { state.renderQueued = false; render(); });
}

function clearBoard() {
  dom.board.replaceChildren();
  dom.board.style.height = '';
  dom.board.style.transform = '';
  state.rows.clear();
  state.cells.clear();
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

  // A phone's shelves stand where they are; only what is on them changes.
  if (MOBILE.matches) return render();

  // Row 0 opens across the middle with a tile centered; after that the pan is kept, so a filter
  // changes what is on the shelves and not where you are.
  if (!state.placed) {
    const view = dom.viewport.getBoundingClientRect();
    state.pan = { x: Math.round((view.width - G.colW) / 2), y: Math.round(view.height / 2 - G.air - G.tile / 2) };
    state.placed = true;
  }
  setPan(state.pan.x, state.pan.y);
  render();
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
/* Panning: drag, wheel, keys                                                  */
/* -------------------------------------------------------------------------- */

function bindViewport() {
  const view = dom.viewport;

  // A phone scrolls its shelves natively: no drag, no wheel, no keys of the board's own.
  view.addEventListener('pointerdown', event => {
    if (event.button !== 0 || MOBILE.matches) return;
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

  // The earn-back card's tilt and glare, delegated: the tile under the pointer tilts toward it and
  // catches the light under it. The rect is cached per interaction and the vars are written once
  // per frame, so the hot path is compositor transforms and one gradient.
  view.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch') return;
    const tile = event.target.closest('.library-tile');
    if (!tile || tile === state.tilt?.tile || tile.classList.contains('library-tile--ghost')) return;
    untilt();
    state.tilt = { tile, rect: tile.getBoundingClientRect(), frame: 0, event };
    tile.classList.add('is-tilting');
    tiltFrame();
  });
  view.addEventListener('pointermove', event => {
    if (!state.tilt || state.dragging) { if (state.dragging) untilt(); return; }
    state.tilt.event = event;
    if (!state.tilt.frame) state.tilt.frame = requestAnimationFrame(tiltFrame);
  });
  view.addEventListener('pointerout', event => {
    if (state.tilt && event.target.closest('.library-tile') === state.tilt.tile && !state.tilt.tile.contains(event.relatedTarget)) untilt();
  });

  // A pinch on a trackpad arrives as a wheel with ctrlKey, as does ctrl and the wheel; either
  // zooms about the pointer. A plain wheel pans.
  view.addEventListener('wheel', event => {
    if (MOBILE.matches) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const rect = view.getBoundingClientRect();
      // A trackpad pinch arrives in small deltas; a mouse notch is 100 at once and is held to a step.
      const delta = Math.max(-ZOOM.notch, Math.min(ZOOM.notch, event.deltaY));
      zoomBy(Math.exp(-delta * ZOOM.wheel), { x: event.clientX - rect.left, y: event.clientY - rect.top });
      return;
    }
    setPan(state.pan.x - event.deltaX, state.pan.y - event.deltaY);
  }, { passive: false });

  view.addEventListener('keydown', event => {
    if (event.key === '=' || event.key === '+' || event.key === '-' || event.key === '_') {
      event.preventDefault();
      const rect = view.getBoundingClientRect();
      zoomBy(event.key === '-' || event.key === '_' ? 1 / ZOOM.key : ZOOM.key, { x: rect.width / 2, y: rect.height / 2 }, { settle: 0 });
      return;
    }
    const step = { ArrowLeft: [KEY_STEP, 0], ArrowRight: [-KEY_STEP, 0], ArrowUp: [0, KEY_STEP], ArrowDown: [0, -KEY_STEP] }[event.key];
    if (!step || MOBILE.matches) return;
    event.preventDefault();
    setPan(state.pan.x + step[0], state.pan.y + step[1]);
  });

  bindPinch(view);
}

/* -------------------------------------------------------------------------- */
/* Zoom                                                                        */
/* -------------------------------------------------------------------------- */

const clampZoom = z => Math.min(ZOOM.max, Math.max(ZOOM.min, z));

/**
 * Scales the board on screen by `factor` about `anchor` (viewport coordinates), on top of any
 * zoom still in flight, and arranges for the board to be dealt again once the gesture rests.
 */
function zoomBy(factor, anchor, { settle = ZOOM.settle } = {}) {
  const live = state.zooming || { from: state.zoom, to: state.zoom, anchor, timer: 0, scroll: null };
  live.to = clampZoom(live.to * factor);
  live.anchor = anchor;
  if (!live.scroll && MOBILE.matches) {
    // What the viewport and each rail were scrolled to when the pinch began, so the commit can
    // put the same point back under the fingers.
    live.scroll = { top: dom.viewport.scrollTop, rails: [...state.rows].map(([r, row]) => [r, row.rail.scrollLeft]) };
  }
  state.zooming = live;
  const k = live.to / live.from;
  if (MOBILE.matches) {
    const board = dom.board.getBoundingClientRect();
    const view = dom.viewport.getBoundingClientRect();
    dom.board.style.transformOrigin = `${anchor.x + view.left - board.left}px ${anchor.y + view.top - board.top}px`;
    dom.board.style.transform = `scale(${k})`;
  } else {
    dom.board.style.transformOrigin = '0 0';
    dom.board.style.transform = `translate3d(${Math.round(anchor.x - (anchor.x - state.pan.x) * k)}px, ${Math.round(anchor.y - (anchor.y - state.pan.y) * k)}px, 0) scale(${k})`;
  }
  clearTimeout(live.timer);
  if (settle) live.timer = setTimeout(commitZoom, settle);
  else commitZoom();
}

/** The gesture has rested: the board takes the new size for real, about the same anchor. */
function commitZoom() {
  const live = state.zooming;
  if (!live) return;
  state.zooming = null;
  clearTimeout(live.timer);
  const k = live.to / live.from;
  state.zoom = live.to;
  dom.board.style.transformOrigin = '';
  dom.board.style.transform = '';
  measure();
  clearBoard();
  if (MOBILE.matches) {
    render();
    const { anchor, scroll } = live;
    dom.viewport.scrollTop = (scroll.top + anchor.y) * k - anchor.y;
    for (const [r, left] of scroll.rails) {
      const row = state.rows.get(r);
      if (row) row.rail.scrollLeft = (left + anchor.x) * k - anchor.x;
    }
  } else {
    setPan(live.anchor.x - (live.anchor.x - state.pan.x) * k, live.anchor.y - (live.anchor.y - state.pan.y) * k);
    render();
  }
}

/** Two fingers on a phone: the board scales between them, and is dealt again when they lift. */
function bindPinch(view) {
  let pinch = null;
  const span = touches => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  const middle = touches => {
    const rect = view.getBoundingClientRect();
    return { x: (touches[0].clientX + touches[1].clientX) / 2 - rect.left, y: (touches[0].clientY + touches[1].clientY) / 2 - rect.top };
  };
  view.addEventListener('touchstart', event => {
    if (event.touches.length !== 2) return;
    pinch = { span: span(event.touches) };
  }, { passive: true });
  view.addEventListener('touchmove', event => {
    if (!pinch || event.touches.length !== 2) return;
    event.preventDefault();
    const now = span(event.touches);
    const factor = now / pinch.span;
    pinch.span = now;
    zoomBy(factor, middle(event.touches), { settle: 400 });
  }, { passive: false });
  const end = event => {
    if (!pinch || event.touches.length >= 2) return;
    pinch = null;
    commitZoom();
  };
  view.addEventListener('touchend', end);
  view.addEventListener('touchcancel', end);
}

function tiltFrame() {
  const t = state.tilt;
  if (!t) return;
  t.frame = 0;
  const x = Math.min(1, Math.max(0, (t.event.clientX - t.rect.left) / t.rect.width));
  const y = Math.min(1, Math.max(0, (t.event.clientY - t.rect.top) / t.rect.height));
  const style = t.tile.style;
  style.setProperty('--ry', `${((x - 0.5) * 2 * MAX_TILT).toFixed(2)}deg`);
  style.setProperty('--rx', `${((0.5 - y) * 2 * MAX_TILT).toFixed(2)}deg`);
  style.setProperty('--scale', String(HOVER_SCALE));
  style.setProperty('--glare-x', `${(x * 100).toFixed(1)}%`);
  style.setProperty('--glare-y', `${(y * 100).toFixed(1)}%`);
  style.setProperty('--glare', '1');
}

function untilt() {
  const t = state.tilt;
  if (!t) return;
  state.tilt = null;
  if (t.frame) cancelAnimationFrame(t.frame);
  t.tile.classList.remove('is-tilting');
  for (const name of ['--rx', '--ry', '--scale', '--glare-x', '--glare-y', '--glare']) t.tile.style.removeProperty(name);
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
