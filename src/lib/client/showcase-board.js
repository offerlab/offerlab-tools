/**
 * The Showcase's virtual board: shelves that run forever in every direction. Each row deals the
 * bundles in a shuffle seeded by its row number and repeats it, so the grid is unbounded, a
 * bundle recurs across it, and a shared link lays out the same way twice. Only the cells near the
 * viewport exist in the DOM; panning creates and drops them. Imperative by design.
 */
import { coverUrl, escape, TILE_COVER_WIDTH } from '$lib/client/showcase.svelte.js';

// Geometry, owned here and mirrored onto the section as custom properties so the CSS cannot drift.
// Each row is one continuous plank. A desktop's board is unbounded and pans in every direction,
// odd rows half a column over. A phone's shelves stand still and each scrolls sideways on its
// own: 2.25 columns across the viewport so the next tile is always cut off at the edge, a fixed
// number of bundles per shelf, the first one a gutter in from the left.
const DESKTOP = { tile: 220, gap: 32, plank: 18, air: 64, radius: 28 };
export const PHONE = { columns: 2.25, gap: 10, plank: 14, air: 44, radius: 20, perShelf: 8, gutter: 16 };
export const G = {};

const FADE_MS = 320;
const SWEEP_MS = 200;
const SEED = 0x9e3779b1;

/** The board's elements and its non-reactive state; filled by `initBoard` once mounted. */
export const board = {
  section: null,
  viewport: null,
  el: null,
  media: null,
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
  origin: null,
  renderQueued: false,
  tilt: null,
  placed: false
};

export const isMobile = () => board.media?.matches === true;

export function initBoard({ section, viewport, el }) {
  board.section = section;
  board.viewport = viewport;
  board.el = el;
  board.media = window.matchMedia('(max-width: 900px)');
}

export function measure() {
  const width = board.viewport.getBoundingClientRect().width || window.innerWidth;
  const z = board.zoom;
  if (isMobile()) {
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
  for (const [name, value] of Object.entries(vars)) board.section.style.setProperty(`--lib-${name}`, `${value}px`);
}

/* -------------------------------------------------------------------------- */
/* Tiles                                                                       */
/* -------------------------------------------------------------------------- */

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
  if (row.order?.length === board.visible.length) return row.order;
  const order = board.visible.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = mix(row.r, i) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  row.order = order;
  return order;
}

const mod = (a, b) => ((a % b) + b) % b;
const bundleAt = (row, c) => board.visible[orderFor(row)[mod(c, board.visible.length)]];

const rowOffset = r => (r & 1 ? G.colW / 2 : 0);

function rowFor(r) {
  let row = board.rows.get(r);
  if (row) return row;
  const el = document.createElement('div');
  el.className = 'library-shelf';
  el.style.transform = `translate3d(0, ${r * G.shelfH}px, 0)`;
  // Later rows paint over earlier ones so a plank's shadow falls behind the glow of the row below.
  el.style.zIndex = String(r + 1e6);
  el.innerHTML = '<div class="library-shelf-glow"></div><div class="library-shelf-shadow"></div><div class="library-shelf-slab"></div><div class="library-shelf-rail"></div>';
  row = { el, r, furniture: [...el.children].slice(0, 3), rail: el.lastElementChild, fresh: true };
  board.rows.set(r, row);
  board.el.appendChild(el);
  return row;
}

/** Creates what the viewport can see plus one cell of margin, drops the rest. */
export function render() {
  if (isMobile()) return renderShelves();
  const view = board.viewport.getBoundingClientRect();
  const x0 = -board.pan.x - G.colW, x1 = -board.pan.x + view.width + G.colW;
  const r0 = Math.floor(-board.pan.y / G.shelfH) - 1, r1 = Math.ceil((-board.pan.y + view.height) / G.shelfH) + 1;
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
      const bundle = board.visible.length ? bundleAt(row, c) : null;
      const current = board.cells.get(key);
      if (current && current.dataset.id === (bundle?.id ?? '')) continue;
      const tile = bundle ? makeTile(bundle) : makeGhost();
      const left = c * G.colW + rowOffset(r) + G.gap / 2;
      tile.style.left = `${left}px`;
      board.cells.set(key, tile);
      if (current) crossfade(current, tile, (left + board.pan.x) / view.width);
      row.rail.appendChild(tile);
    }
  }

  for (const [key, tile] of board.cells) if (!keep.has(key)) { tile.remove(); board.cells.delete(key); }
  for (const [r, row] of board.rows) if (r < r0 || r > r1) { row.el.remove(); board.rows.delete(r); }
}

/**
 * A phone's board: every visible bundle dealt once, in one shuffled order, a shelf at a time.
 * The shelves stack in the viewport, which scrolls down; each shelf's rail scrolls sideways on
 * its own. Odd shelves open half a column along so the stagger of the desktop board survives.
 * With nothing to show, enough shelves of glass to fill the viewport stand under the message.
 */
function renderShelves() {
  const view = board.viewport.getBoundingClientRect();
  const n = board.visible.length;
  const perShelf = n ? PHONE.perShelf : Math.ceil(PHONE.columns) + 1;
  const shelves = n ? Math.ceil(n / perShelf) : Math.ceil(view.height / G.shelfH) + 1;
  const order = n ? orderFor(board.deal) : [];
  const keep = new Set();
  board.el.style.height = `${shelves * G.shelfH}px`;

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
      const bundle = n ? board.visible[order[r * perShelf + c]] : null;
      const current = board.cells.get(key);
      if (current && current.dataset.id === (bundle?.id ?? '')) continue;
      const tile = bundle ? makeTile(bundle, true) : makeGhost();
      const left = c * G.colW + G.gap / 2 + G.inset;
      tile.style.left = `${left}px`;
      board.cells.set(key, tile);
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

  for (const [key, tile] of board.cells) if (!keep.has(key)) { tile.remove(); board.cells.delete(key); }
  for (const [r, row] of board.rows) if (r >= shelves) { row.el.remove(); board.rows.delete(r); }
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

export function scheduleRender() {
  if (board.renderQueued) return;
  board.renderQueued = true;
  requestAnimationFrame(() => { board.renderQueued = false; render(); });
}

export function clearBoard() {
  board.el.replaceChildren();
  board.el.style.height = '';
  board.el.style.transform = '';
  board.rows.clear();
  board.cells.clear();
}

/** Unbounded: the board has no edge to meet. */
export function setPan(x, y) {
  board.pan.x = x;
  board.pan.y = y;
  board.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  scheduleRender();
}

