/**
 * The Showcase board, built like a map. The shelves are laid out once, at their resting size, in
 * board coordinates, and a camera { x, y, k } shows them: screen = (x, y) + k * board. Every input
 * (drag, two-finger pinch, ctrl+wheel, Safari's gesture events, keys) moves the camera, and one
 * animation frame writes it as a single transform on the board's one layer. A gesture never lays
 * anything out; tiles are added or dropped only as the view nears the edge of what is dealt.
 *
 * A desktop's board runs forever in every direction, each row a seeded shuffle of the bundles,
 * odd rows half a column over. A phone's board is the bundles dealt once, eight to a shelf: the
 * camera moves up and down and zooms, and each shelf slides sideways on its own, as the native
 * scrollers it replaces did. The board knows tiles and shelves; what a click on a tile means
 * belongs to `onTile`.
 */

// Resting geometry. A phone's column is its viewport over 2.25, so the next tile is always cut off.
const DESKTOP = { tile: 220, gap: 32, plank: 18, air: 64, radius: 28 };
const PHONE = { columns: 2.25, gap: 10, plank: 14, air: 44, radius: 20, perShelf: 8, gutter: 16, foot: 104 };
// The zoom's range and feel. A key press or a mouse notch eases over `ease` ms.
const ZOOM = { min: 0.5, max: 2.4, key: 1.25, wheel: 0.01, notch: 25, ease: 180 };
// Quiet this long after the last movement is rest: the tiles are pruned and sharpened then.
const REST_MS = 250;
const DRAG_THRESHOLD = 6;
const FRICTION = 0.95;
// Past its end a shelf follows the finger this much, then eases back when let go.
const SHELF_STRETCH = 0.35;
const KEY_STEP = 160;
// Tiles dealt per frame, so no frame stalls on building DOM.
const DEAL_PER_FRAME = 24;
// Cover widths the CDN is asked for; a tile swaps up a size after a zoom in, never down.
const COVER_WIDTHS = [480, 800, 1200];
const FADE_MS = 320;
const SWEEP_MS = 200;
const SEED = 0x9e3779b1;
const MAX_TILT = 9;
const HOVER_SCALE = 1.04;

/** The mounted board's viewport and media query, for the lightbox to hand focus back and ask. */
export const board = { viewport: null, media: null };
export const isMobile = () => board.media?.matches === true;

export function createBoard({ section, viewport, el, media, coverUrl, escape, onTile }) {
  board.viewport = viewport;
  board.media = media;
  const G = {};
  const cam = { x: 0, y: 0, k: 1 };
  const shown = { x: NaN, y: NaN, k: NaN };
  const rows = new Map();
  const cells = new Map();
  const queue = new Map();
  // Shelves sliding on their own: gliding after a flick, or easing back inside their ends.
  const sliding = new Set();
  const pointers = new Map();
  const anims = [];
  const deal = { r: 0 };
  const view = { left: 0, top: 0, width: 0, height: 0 };
  let bundles = [];
  let dealt = null;
  let placed = false;
  let ready = false;
  let frame = 0;
  let lastMove = 0;
  let lastTick = 0;
  let rested = true;
  let zooming = false;
  let drag = null;
  let pinch = null;
  let glide = null;
  let gesture = null;
  let gestureQuietUntil = 0;
  let suppressClick = false;
  let tilt = null;
  const phone = () => media.matches;

  /* ------------------------------------------------------------------------ */
  /* Geometry                                                                  */
  /* ------------------------------------------------------------------------ */

  function layout() {
    const rect = viewport.getBoundingClientRect();
    Object.assign(view, { left: rect.left, top: rect.top, width: rect.width || window.innerWidth, height: rect.height || window.innerHeight });
    if (phone()) {
      G.colW = Math.round(view.width / PHONE.columns);
      G.gap = PHONE.gap;
      G.tile = G.colW - G.gap;
      Object.assign(G, { plank: PHONE.plank, air: PHONE.air, radius: PHONE.radius, inset: PHONE.gutter - PHONE.gap / 2 });
    } else {
      Object.assign(G, DESKTOP, { inset: 0 });
      G.colW = G.tile + G.gap;
    }
    G.shelfH = G.air + G.tile + G.plank;
    const vars = { tile: G.tile, gap: G.gap, plank: G.plank, air: G.air, shelf: G.shelfH, radius: G.radius };
    for (const [name, value] of Object.entries(vars)) section.style.setProperty(`--lib-${name}`, `${value}px`);
  }

  // A desktop's odd rows sit half a column along. A phone's shelves each slide sideways on their
  // own instead: a row's `s` is how far it has slid, in board px, and odd shelves open half a
  // column in. A desktop row keeps `s` at 0.
  const rowOffset = r => (!phone() && r & 1 ? G.colW / 2 : 0);
  const cellLeft = (r, c) => c * G.colW + rowOffset(r) + G.gap / 2 + G.inset;
  const shelves = () => (bundles.length ? Math.ceil(bundles.length / PHONE.perShelf) : Math.ceil(view.height / G.shelfH) + 1);
  const perShelf = () => (bundles.length ? PHONE.perShelf : Math.ceil(PHONE.columns) + 1);
  const shelfCount = r => (bundles.length ? Math.min(PHONE.perShelf, bundles.length - r * PHONE.perShelf) : perShelf());

  /** A phone's board edges: its tiles plus the gutter, and the footer's room under the last shelf. */
  function bounds() {
    return {
      left: 0,
      right: perShelf() * G.colW + G.inset + G.gap / 2 + PHONE.gutter,
      top: 0,
      bottom: shelves() * G.shelfH + PHONE.foot
    };
  }

  /**
   * Keeps a phone's camera on the shelves, top to bottom; pinned to the top when they are shorter
   * than the view. Sideways, each shelf keeps itself in view (`slideRange`).
   */
  function clamp() {
    if (!phone()) return;
    const b = bounds();
    const min = view.height - b.bottom * cam.k, max = -b.top * cam.k;
    cam.y = min >= max ? max : Math.min(max, Math.max(min, cam.y));
  }

  /** How far shelf `r` may slide at this zoom: its tiles plus the end gutter fill the view if they can. */
  function slideRange(r) {
    const end = shelfCount(r) * G.colW + G.inset + G.gap / 2 + PHONE.gutter;
    const min = cam.x / cam.k, max = end - (view.width - cam.x) / cam.k;
    return [min, Math.max(min, max)];
  }

  const outside = row => {
    const [min, max] = slideRange(row.r);
    return row.s < min ? row.s - min : row.s > max ? row.s - max : 0;
  };

  function placeRow(row) {
    const transform = `translate(${-row.s}px, ${row.r * G.shelfH}px)`;
    if (row.transform === transform) return;
    row.transform = transform;
    row.el.style.transform = transform;
  }

  /** A shelf let go: it glides on, stops at its end, and eases back if it was pulled past one. */
  function slide(row, dt) {
    if (row.v) {
      row.s += row.v * dt;
      row.v *= FRICTION ** (dt / 16);
      if (Math.abs(row.v) < 0.02 || outside(row)) row.v = 0;
    }
    if (!row.v) {
      const over = outside(row);
      row.s -= over * Math.min(1, 0.25 * (dt / 16));
      if (Math.abs(outside(row)) < 0.25) {
        row.s -= outside(row);
        sliding.delete(row);
      }
    }
    placeRow(row);
  }

  /* ------------------------------------------------------------------------ */
  /* Tiles                                                                     */
  /* ------------------------------------------------------------------------ */

  const coverWidth = () => {
    const want = G.tile * Math.max(1, cam.k) * (window.devicePixelRatio || 1);
    return COVER_WIDTHS.find(w => w * 1.15 >= want) || COVER_WIDTHS.at(-1);
  };

  // The blurred name scrim is two more copies of the cover. A phone always shows it; a desktop
  // only on hover, so it is added the first time a tile is hovered or focused.
  const scrimHtml = src => `
    <span class="library-tile-scrim" aria-hidden="true">
      <img class="library-tile-scrim-soft" src="${src}" alt="" decoding="async">
      <img class="library-tile-scrim-deep" src="${src}" alt="" decoding="async">
    </span>`;

  function makeTile(bundle) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'library-tile';
    tile.dataset.id = bundle.id;
    const width = coverWidth();
    tile.dataset.width = String(width);
    tile.setAttribute('aria-label', `${bundle.name}, ${bundle.brands.join(', ')}`);
    const src = escape(coverUrl(bundle.cover, width));
    tile.innerHTML = `<span class="library-tile-cover"><img src="${src}" alt="" decoding="async"></span>${phone() ? scrimHtml(src) : ''}<span class="library-tile-name">${escape(bundle.name)}</span>`;
    tile.querySelector('img').addEventListener('error', () => tile.classList.add('is-bare'), { once: true });
    return tile;
  }

  function ensureScrim(tile) {
    if (tile.querySelector('.library-tile-scrim') || tile.classList.contains('library-tile--ghost')) return;
    const src = tile.querySelector('.library-tile-cover img')?.getAttribute('src');
    if (!src) return;
    // Fresh, it would appear at full opacity; held at none for a frame so the hover fades it in.
    tile.classList.add('is-scrim-fresh');
    tile.querySelector('.library-tile-cover').insertAdjacentHTML('afterend', scrimHtml(escape(src)));
    requestAnimationFrame(() => requestAnimationFrame(() => tile.classList.remove('is-scrim-fresh')));
  }

  function makeGhost() {
    const tile = document.createElement('div');
    tile.className = 'library-tile library-tile--ghost';
    tile.dataset.id = '';
    return tile;
  }

  /** After a zoom in, a tile on screen fetches a larger cover and swaps to it once decoded. */
  function sharpen() {
    const width = coverWidth();
    const v = visibleRect(1);
    for (const [key, tile] of cells) {
      if (Number(tile.dataset.width) >= width || tile.classList.contains('library-tile--ghost')) continue;
      const [r, c] = key.split(':').map(Number);
      const x = cellLeft(r, c) - (rows.get(r)?.s || 0), y = r * G.shelfH;
      if (x + G.colW < v.x0 || x > v.x1 || y + G.shelfH < v.y0 || y > v.y1) continue;
      const bundle = bundleFor(r, c);
      if (!bundle) continue;
      tile.dataset.width = String(width);
      const src = coverUrl(bundle.cover, width);
      const next = new Image();
      next.src = src;
      next.decode().then(() => {
        if (!tile.isConnected) return;
        for (const img of tile.querySelectorAll('img')) img.src = src;
      }).catch(() => {});
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Dealing                                                                   */
  /* ------------------------------------------------------------------------ */

  function mix(row, col) {
    let h = (Math.imul(row, 73856093) ^ Math.imul(col, 19349663) ^ SEED) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }

  /** A seeded shuffle of the bundles for a row, so any row deals the same way on every visit. */
  function orderFor(row) {
    if (row.order?.length === bundles.length) return row.order;
    const order = bundles.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = mix(row.r, i) % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    row.order = order;
    return order;
  }

  const mod = (a, b) => ((a % b) + b) % b;

  function bundleFor(r, c) {
    if (!bundles.length) return null;
    if (phone()) return bundles[orderFor(deal)[r * PHONE.perShelf + c]];
    return bundles[orderFor(rows.get(r) || { r })[mod(c, bundles.length)]];
  }

  function rowFor(r) {
    let row = rows.get(r);
    if (row) return row;
    const node = document.createElement('div');
    node.className = 'library-shelf';
    // Later rows paint over earlier ones so a plank's shadow falls behind the glow of the row below.
    node.style.zIndex = String(r + 1e6);
    node.innerHTML = '<div class="library-shelf-glow"></div><div class="library-shelf-shadow"></div><div class="library-shelf-slab"></div><div class="library-shelf-rail"></div>';
    row = { el: node, r, furniture: [...node.children].slice(0, 3), rail: node.lastElementChild, span: '', s: phone() && r & 1 ? G.colW / 2 : 0, v: 0, transform: '' };
    if (phone()) row.s = Math.min(Math.max(row.s, slideRange(r)[0]), slideRange(r)[1]);
    placeRow(row);
    rows.set(r, row);
    el.appendChild(node);
    return row;
  }

  /** The board rectangle on screen, grown by `margin` cells. */
  function visibleRect(margin = 0) {
    return {
      x0: -cam.x / cam.k - margin * G.colW,
      x1: (view.width - cam.x) / cam.k + margin * G.colW,
      y0: -cam.y / cam.k - margin * G.shelfH,
      y1: (view.height - cam.y) / cam.k + margin * G.shelfH
    };
  }

  /** Everything a zoom out to the minimum could show from here, about any point in the view. */
  function reachRect() {
    const v = visibleRect();
    const w = view.width / ZOOM.min, h = view.height / ZOOM.min;
    // Two cells past it, so a gesture that goes to the minimum still has one in hand.
    return {
      x0: Math.min(v.x0, v.x1 - w) - 2 * G.colW,
      x1: Math.max(v.x1, v.x0 + w) + 2 * G.colW,
      y0: Math.min(v.y0, v.y1 - h) - 2 * G.shelfH,
      y1: Math.max(v.y1, v.y0 + h) + 2 * G.shelfH
    };
  }

  const inside = (a, b) => b && a.x0 >= b.x0 && a.x1 <= b.x1 && a.y0 >= b.y0 && a.y1 <= b.y1;

  /** Calls `fn(r, c)` for each cell that exists on the board inside `rect`. */
  function eachCell(rect, fn) {
    let r0 = Math.floor(rect.y0 / G.shelfH), r1 = Math.floor(rect.y1 / G.shelfH);
    if (phone()) { r0 = Math.max(0, r0); r1 = Math.min(shelves() - 1, r1); }
    for (let r = r0; r <= r1; r++) {
      let c0 = Math.floor((rect.x0 - rowOffset(r) - G.inset) / G.colW), c1 = Math.floor((rect.x1 - rowOffset(r) - G.inset) / G.colW);
      // A phone's shelf is eight tiles that slide on their own, so the whole shelf is dealt.
      if (phone()) { c0 = 0; c1 = shelfCount(r) - 1; }
      for (let c = c0; c <= c1; c++) fn(r, c);
    }
  }

  /** Queues every missing cell of `rect`, nearest the middle of the view first. */
  function dealRect(rect) {
    const v = visibleRect();
    const mx = (v.x0 + v.x1) / 2, my = (v.y0 + v.y1) / 2;
    const wanted = [];
    eachCell(rect, (r, c) => {
      const key = `${r}:${c}`;
      if (!cells.has(key) && !queue.has(key)) wanted.push([Math.hypot(cellLeft(r, c) - mx, r * G.shelfH - my), key, r, c]);
    });
    wanted.sort((a, b) => a[0] - b[0]);
    for (const [, key, r, c] of wanted) queue.set(key, [r, c]);
    dealt = dealt ? { x0: Math.min(dealt.x0, rect.x0), x1: Math.max(dealt.x1, rect.x1), y0: Math.min(dealt.y0, rect.y0), y1: Math.max(dealt.y1, rect.y1) } : { ...rect };
    spanFurniture();
  }

  /** The planks run past the dealt tiles in whole blocks, and are only rewritten when those change. */
  function spanFurniture() {
    const b = phone() ? bounds() : null;
    const block = G.colW * 4;
    const left = phone() ? b.left - view.width / ZOOM.min : Math.floor(dealt.x0 / block) * block;
    const right = phone() ? b.right + view.width / ZOOM.min : Math.ceil(dealt.x1 / block) * block;
    const span = `${left}:${right}`;
    eachRow(r => {
      const row = rowFor(r);
      if (row.span === span) return;
      row.span = span;
      for (const part of row.furniture) {
        part.style.left = `${left}px`;
        part.style.width = `${right - left}px`;
      }
    });
  }

  function eachRow(fn) {
    let r0 = Math.floor(dealt.y0 / G.shelfH), r1 = Math.floor(dealt.y1 / G.shelfH);
    if (phone()) { r0 = 0; r1 = shelves() - 1; }
    for (let r = r0; r <= r1; r++) fn(r);
  }

  /** Builds up to `budget` queued tiles, only those inside `rect` when one is given. */
  function build(budget, rect = null) {
    for (const [key, [r, c]] of queue) {
      if (budget <= 0) return;
      if (rect) {
        const x = cellLeft(r, c), y = r * G.shelfH;
        if (x + G.colW < rect.x0 || x > rect.x1 || y + G.shelfH < rect.y0 || y > rect.y1) continue;
      }
      budget--;
      queue.delete(key);
      if (cells.has(key)) continue;
      const row = rowFor(r);
      const bundle = bundleFor(r, c);
      const tile = bundle ? makeTile(bundle) : makeGhost();
      tile.style.left = `${cellLeft(r, c)}px`;
      cells.set(key, tile);
      row.rail.appendChild(tile);
    }
  }

  /** At rest: the tiles and rows well outside reach are dropped, and what reach needs is queued. */
  function prune() {
    const reach = reachRect();
    const keep = { x0: reach.x0 - 4 * G.colW, x1: reach.x1 + 4 * G.colW, y0: reach.y0 - 3 * G.shelfH, y1: reach.y1 + 3 * G.shelfH };
    const keys = new Set();
    eachCell(keep, (r, c) => keys.add(`${r}:${c}`));
    for (const [key, tile] of cells) if (!keys.has(key)) { tile.remove(); cells.delete(key); }
    for (const key of queue.keys()) if (!keys.has(key)) queue.delete(key);
    const r0 = Math.floor(keep.y0 / G.shelfH), r1 = Math.floor(keep.y1 / G.shelfH);
    // A phone keeps every shelf's plank; its rows are few and the camera can reach them all.
    for (const [r, row] of rows) if (phone() ? r >= shelves() : r < r0 || r > r1) { row.el.remove(); rows.delete(r); }
    dealt = null;
    dealRect(reach);
  }

  /**
   * The bundles changed: every dealt cell whose bundle is different fades to the new one, in a
   * sweep across the view; cells that no longer exist go.
   */
  function redeal() {
    deal.order = null;
    for (const row of rows.values()) row.order = null;
    const valid = new Set();
    if (phone()) eachCell({ x0: -Infinity, x1: Infinity, y0: -Infinity, y1: Infinity }, (r, c) => valid.add(`${r}:${c}`));
    for (const [key, current] of [...cells]) {
      const [r, c] = key.split(':').map(Number);
      if (phone() && !valid.has(key)) { current.remove(); cells.delete(key); continue; }
      const bundle = bundleFor(r, c);
      if (current.dataset.id === (bundle?.id ?? '')) continue;
      const tile = bundle ? makeTile(bundle) : makeGhost();
      const left = cellLeft(r, c);
      tile.style.left = `${left}px`;
      cells.set(key, tile);
      crossfade(current, tile, (cam.x + (left - (rows.get(r)?.s || 0)) * cam.k) / view.width);
      rowFor(r).rail.appendChild(tile);
    }
    for (const [r, row] of rows) if (phone() && r >= shelves()) { row.el.remove(); rows.delete(r); sliding.delete(row); }
    // A shelf that now holds fewer bundles eases back inside its end.
    if (phone()) for (const row of rows.values()) if (outside(row)) sliding.add(row);
    queue.clear();
    for (const row of rows.values()) row.span = '';
    clamp();
    prune();
    build(Infinity, visibleRect(1));
  }

  /**
   * A cell whose bundle changed fades the new cover in over the old one, in a sweep from the left
   * of the view to the right. Opacity only; the new cover waits to be decoded so nothing fades in
   * blank.
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

  /* ------------------------------------------------------------------------ */
  /* The camera                                                                */
  /* ------------------------------------------------------------------------ */

  const clampK = k => Math.min(ZOOM.max, Math.max(ZOOM.min, k));

  /** Scales about a point in viewport coordinates. */
  function zoomAbout(ax, ay, factor) {
    const k = clampK(cam.k * factor);
    const f = k / cam.k;
    if (f === 1) return;
    cam.x = ax - (ax - cam.x) * f;
    cam.y = ay - (ay - cam.y) * f;
    cam.k = k;
    if (!zooming) {
      zooming = true;
      untilt();
    }
  }

  function panBy(dx, dy) {
    cam.x += dx;
    cam.y += dy;
  }

  /** A key press or a mouse notch: the same change, spread over a few frames with an ease-out. */
  function ease(kind, amount, anchor) {
    anims.push({ kind, amount, anchor, start: performance.now(), done: 0 });
    wake();
  }

  function stopMotion() {
    glide = null;
    anims.length = 0;
  }

  function wake() {
    rested = false;
    if (!frame) frame = requestAnimationFrame(tick);
  }

  function tick(now) {
    frame = 0;
    const dt = Math.min(64, lastTick ? now - lastTick : 16);
    lastTick = now;
    for (let i = anims.length - 1; i >= 0; i--) {
      const a = anims[i];
      const t = Math.min(1, (now - a.start) / ZOOM.ease);
      const e = 1 - (1 - t) ** 3;
      if (a.kind === 'zoom') {
        const target = a.amount ** e;
        zoomAbout(a.anchor.x, a.anchor.y, target / (a.done || 1));
        a.done = target;
      } else {
        const d = e - a.done;
        panBy(a.amount.x * d, a.amount.y * d);
        a.done = e;
      }
      if (t >= 1) anims.splice(i, 1);
    }
    if (glide) {
      panBy(glide.x * dt, glide.y * dt);
      const decay = FRICTION ** (dt / 16);
      glide.x *= decay;
      glide.y *= decay;
      if (Math.hypot(glide.x, glide.y) < 0.02) glide = null;
    }
    const free = { x: cam.x, y: cam.y };
    clamp();
    // A glide that meets a phone's edge stops along that edge.
    if (glide && cam.x !== free.x) glide.x = 0;
    if (glide && cam.y !== free.y) glide.y = 0;
    for (const row of sliding) if (row !== drag?.row) slide(row, dt);
    if (cam.x !== shown.x || cam.y !== shown.y || cam.k !== shown.k) {
      write();
      lastMove = now;
    }
    // Mid-gesture, tiles are dealt only when the view nears the edge of what is dealt.
    if (!inside(visibleRect(1), dealt)) dealRect(reachRect());
    const moving = pointers.size || anims.length || glide || gesture || sliding.size || now - lastMove < REST_MS;
    // While the board moves only tiles about to show are built; the rest of the reach waits for rest.
    build(DEAL_PER_FRAME, moving ? visibleRect(1) : null);
    if (moving || queue.size) {
      frame = requestAnimationFrame(tick);
      return;
    }
    lastTick = 0;
    rest();
  }

  function write() {
    el.style.transform = `translate3d(${cam.x}px, ${cam.y}px, 0) scale(${cam.k})`;
    shown.x = cam.x; shown.y = cam.y; shown.k = cam.k;
  }

  /** The gesture is over: whole device pixels, a sharp raster, the reach dealt, larger covers. */
  function rest() {
    if (rested) return;
    rested = true;
    const dpr = window.devicePixelRatio || 1;
    // A pinch moved a phone's camera sideways; that becomes each shelf's own slide, so the shelves
    // stay where they are on screen and the camera goes back to their left edge.
    if (phone() && cam.x) {
      for (const row of rows.values()) {
        row.s -= cam.x / cam.k;
        if (outside(row)) sliding.add(row);
      }
      cam.x = 0;
    }
    cam.x = Math.round(cam.x * dpr) / dpr;
    cam.y = Math.round(cam.y * dpr) / dpr;
    write();
    if (phone()) for (const row of rows.values()) placeRow(row);
    if (zooming) {
      zooming = false;
      // The layer kept its old scale through the zoom; without the hint for a frame it is drawn
      // again at the new one, and keeps that once the hint is back.
      viewport.classList.add('is-sharpening');
      requestAnimationFrame(() => requestAnimationFrame(() => viewport.classList.remove('is-sharpening')));
    }
    prune();
    sharpen();
    if ((queue.size || sliding.size) && !frame) frame = requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------------------ */
  /* Input                                                                     */
  /* ------------------------------------------------------------------------ */

  const listeners = [];
  const on = (target, type, handler, opts) => {
    target.addEventListener(type, handler, opts);
    listeners.push([target, type, handler, opts]);
  };
  const local = event => ({ x: event.clientX - view.left, y: event.clientY - view.top });
  const touching = () => [...pointers.values()].some(p => p.type === 'touch');

  function startPinch() {
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    if (drag) {
      drag.moved = true;
      // A shelf the first finger was sliding is let go where it is, and eases inside its ends later.
      if (drag.row) sliding.add(drag.row);
      drag.row = null;
      drag.mode = phone() ? 'y' : 'free';
    }
  }

  /** The phone shelf under a point in the viewport, if there is one. */
  function shelfAt(y) {
    const r = Math.floor((y - cam.y) / cam.k / G.shelfH);
    return r >= 0 && r < shelves() ? rows.get(r) : null;
  }

  on(viewport, 'pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.target.closest('.library-omni, .library-lightbox')) return;
    if (pointers.size >= 2) return;
    // Wherever the page moved it since the last rest, the pointer is measured from here.
    if (!pointers.size) Object.assign(view, (({ left, top }) => ({ left, top }))(viewport.getBoundingClientRect()));
    const p = local(event);
    pointers.set(event.pointerId, { ...p, type: event.pointerType });
    stopMotion();
    if (pointers.size === 1) {
      suppressClick = false;
      drag = { id: event.pointerId, sx: p.x, sy: p.y, lx: p.x, ly: p.y, t: performance.now(), vx: 0, vy: 0, moved: false, mode: null, row: null };
      // A finger on a gliding shelf stops it, as it would a native scroller.
      const row = phone() && shelfAt(p.y);
      if (row) row.v = 0;
    } else {
      untilt();
      startPinch();
    }
    wake();
  });

  on(viewport, 'pointermove', event => {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;
    const p = local(event);
    pointer.x = p.x;
    pointer.y = p.y;
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      if (pinch.dist > 0) zoomAbout(pinch.cx, pinch.cy, dist / pinch.dist);
      panBy(cx - pinch.cx, cy - pinch.cy);
      Object.assign(pinch, { dist, cx, cy });
      wake();
      return;
    }
    if (!drag || drag.id !== event.pointerId) return;
    if (!drag.moved) {
      const dx = p.x - drag.sx, dy = p.y - drag.sy;
      if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
      drag.moved = true;
      // On a phone the drag's start decides it: mostly sideways slides the shelf under the finger
      // on its own, anything else moves the board up and down. A desktop's board pans freely.
      drag.mode = 'free';
      if (phone()) {
        drag.row = Math.abs(dx) > Math.abs(dy) ? shelfAt(drag.sy) : null;
        drag.mode = drag.row ? 'shelf' : 'y';
        if (drag.row) { drag.row.v = 0; sliding.add(drag.row); }
      }
      // Captured only now: capturing on pointerdown would retarget a tap's click to the viewport.
      // A finger is captured by the page already.
      if (event.pointerType !== 'touch') viewport.setPointerCapture(event.pointerId);
      viewport.classList.add('is-dragging');
      untilt();
      drag.lx = p.x; drag.ly = p.y;
    }
    const now = performance.now();
    const dx = drag.mode === 'y' ? 0 : p.x - drag.lx, dy = drag.mode === 'shelf' ? 0 : p.y - drag.ly;
    const dt = Math.max(1, now - drag.t);
    // A short running average, so the glide carries the flick and not one jittery sample.
    drag.vx = drag.vx * 0.6 + (dx / dt) * 0.4;
    drag.vy = drag.vy * 0.6 + (dy / dt) * 0.4;
    drag.lx = p.x; drag.ly = p.y; drag.t = now;
    if (drag.mode === 'shelf') {
      const step = -dx / cam.k;
      drag.row.s += outside(drag.row) ? step * SHELF_STRETCH : step;
      placeRow(drag.row);
    } else panBy(dx, dy);
    wake();
  });

  const release = event => {
    if (!pointers.delete(event.pointerId)) return;
    if (viewport.hasPointerCapture?.(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    if (pointers.size === 1) {
      // One finger of a pinch lifted: the other carries on as a drag, from where it is.
      pinch = null;
      const [[id, p]] = [...pointers];
      drag = { id, sx: p.x, sy: p.y, lx: p.x, ly: p.y, t: performance.now(), vx: 0, vy: 0, moved: true, mode: phone() ? 'y' : 'free', row: null };
    } else if (!pointers.size) {
      pinch = null;
      viewport.classList.remove('is-dragging');
      if (drag?.moved) {
        suppressClick = true;
        const fresh = performance.now() - drag.t < 60;
        if (drag.row) {
          // The shelf glides on by itself; the board stays put.
          drag.row.v = fresh && !outside(drag.row) ? -drag.vx / cam.k : 0;
          sliding.add(drag.row);
        } else if (fresh && Math.hypot(drag.vx, drag.vy) > 0.1) glide = { x: drag.vx, y: drag.vy };
      }
      drag = null;
    }
    wake();
  };
  on(viewport, 'pointerup', release);
  on(viewport, 'pointercancel', release);

  // The click that ends a drag is the drag's own, not a tap on the tile under it.
  on(viewport, 'click', event => {
    if (suppressClick) { event.stopPropagation(); event.preventDefault(); suppressClick = false; return; }
    const tile = event.target.closest('.library-tile');
    if (tile && !tile.classList.contains('library-tile--ghost')) onTile(tile.dataset.id, tile);
  }, true);

  // A trackpad pinch in Chrome or Firefox, and ctrl or cmd with a wheel, zoom about the pointer.
  // A plain wheel pans.
  on(viewport, 'wheel', event => {
    event.preventDefault();
    // Measured once, when a gesture starts from rest, never on each event of it.
    if (rested && !pointers.size) Object.assign(view, (({ left, top }) => ({ left, top }))(viewport.getBoundingClientRect()));
    const p = local(event);
    glide = null;
    if (event.ctrlKey || event.metaKey) {
      // Safari may send a pinch as gesture events and ctrl+wheel both; the gesture owns it.
      if (gesture || performance.now() < gestureQuietUntil) return;
      const delta = Math.max(-ZOOM.notch, Math.min(ZOOM.notch, event.deltaY));
      const factor = Math.exp(-delta * ZOOM.wheel);
      // A trackpad sends small deltas; a mouse notch is 100 at once, held to a step and eased.
      if (event.deltaMode || Math.abs(event.deltaY) >= 50) ease('zoom', factor, p);
      else zoomAbout(p.x, p.y, factor);
    } else {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.height : 1;
      panBy(-event.deltaX * unit, -event.deltaY * unit);
    }
    wake();
  }, { passive: false });

  // Safari on a Mac sends a trackpad pinch as gesture events, and zooms the page unless they are
  // cancelled. `scale` runs from 1 at the gesture's start. Fingers on glass are the pointers' own.
  on(viewport, 'gesturestart', event => {
    // Cancelled either way, so the page itself never zooms under the board.
    event.preventDefault();
    if (touching()) return;
    Object.assign(view, (({ left, top }) => ({ left, top }))(viewport.getBoundingClientRect()));
    stopMotion();
    gesture = { scale: 1 };
  });
  on(viewport, 'gesturechange', event => {
    event.preventDefault();
    if (!gesture || touching()) return;
    const p = local(event);
    zoomAbout(p.x, p.y, event.scale / gesture.scale);
    gesture.scale = event.scale;
    wake();
  });
  on(viewport, 'gestureend', event => {
    event.preventDefault();
    if (!gesture) return;
    gesture = null;
    // The ctrl+wheel tail of the same pinch, if this Safari sends one, is not a second zoom.
    gestureQuietUntil = performance.now() + 150;
    wake();
  });

  on(viewport, 'keydown', event => {
    if (event.target !== viewport && !event.target.closest?.('.library-tile')) return;
    const center = { x: view.width / 2, y: view.height / 2 };
    if (event.key === '=' || event.key === '+') { event.preventDefault(); ease('zoom', ZOOM.key, center); return; }
    if (event.key === '-' || event.key === '_') { event.preventDefault(); ease('zoom', 1 / ZOOM.key, center); return; }
    const step = { ArrowLeft: [KEY_STEP, 0], ArrowRight: [-KEY_STEP, 0], ArrowUp: [0, KEY_STEP], ArrowDown: [0, -KEY_STEP] }[event.key];
    if (!step) return;
    event.preventDefault();
    ease('pan', { x: step[0], y: step[1] });
  });

  /* ------------------------------------------------------------------------ */
  /* The earn-back card's tilt: the tile under the pointer tilts toward it     */
  /* ------------------------------------------------------------------------ */

  on(viewport, 'pointerover', event => {
    if (event.pointerType !== 'mouse' || pointers.size) return;
    const tile = event.target.closest('.library-tile');
    if (!tile || tile === tilt?.tile || tile.classList.contains('library-tile--ghost')) return;
    untilt();
    ensureScrim(tile);
    tilt = { tile, rect: tile.getBoundingClientRect(), frame: 0, event };
    tile.classList.add('is-tilting');
    tiltFrame();
  });
  on(viewport, 'pointermove', event => {
    if (!tilt || event.pointerType !== 'mouse') return;
    if (drag?.moved || zooming) { untilt(); return; }
    tilt.event = event;
    if (!tilt.frame) tilt.frame = requestAnimationFrame(tiltFrame);
  });
  on(viewport, 'pointerout', event => {
    if (tilt && event.target.closest('.library-tile') === tilt.tile && !tilt.tile.contains(event.relatedTarget)) untilt();
  });
  on(viewport, 'focusin', event => {
    const tile = event.target.closest?.('.library-tile');
    if (tile) ensureScrim(tile);
  });

  function tiltFrame() {
    const t = tilt;
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
    const t = tilt;
    if (!t) return;
    tilt = null;
    if (t.frame) cancelAnimationFrame(t.frame);
    t.tile.classList.remove('is-tilting');
    for (const name of ['--rx', '--ry', '--scale', '--glare-x', '--glare-y', '--glare']) t.tile.style.removeProperty(name);
  }

  /* ------------------------------------------------------------------------ */
  /* The board's own life                                                      */
  /* ------------------------------------------------------------------------ */

  /** Row 0 opens across the middle of a desktop with a tile centered; a phone opens at its start. */
  function place() {
    cam.k = 1;
    if (phone()) { cam.x = 0; cam.y = 0; }
    else { cam.x = Math.round((view.width - G.colW) / 2); cam.y = Math.round(view.height / 2 - G.air - G.tile / 2); }
    placed = true;
  }

  function clear() {
    el.replaceChildren();
    rows.clear();
    cells.clear();
    queue.clear();
    dealt = null;
  }

  /** New bundles to show. The camera stays where it is, so a filter changes what is on the shelves. */
  function setBundles(next) {
    bundles = next;
    ready = true;
    layout();
    if (!placed) place();
    redeal();
    write();
    rested = false;
    rest();
  }

  /** The view changed size: a phone's columns follow its width, so it is dealt again. */
  function resize({ replace = false } = {}) {
    stopMotion();
    const before = G.colW;
    layout();
    if (!ready) return;
    if (replace || G.colW !== before) {
      clear();
      if (replace) place();
    }
    clamp();
    write();
    prune();
    build(Infinity, visibleRect(1));
    rested = false;
    rest();
  }

  const onMedia = () => resize({ replace: true });
  media.addEventListener('change', onMedia);

  return {
    setBundles,
    resize,
    // The view is shown again after being hidden, possibly at another size.
    show() { resize(); },
    destroy() {
      cancelAnimationFrame(frame);
      media.removeEventListener('change', onMedia);
      for (const [target, type, handler, opts] of listeners) target.removeEventListener(type, handler, opts);
    }
  };
}
