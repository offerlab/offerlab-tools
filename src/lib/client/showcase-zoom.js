/**
 * The board's motion: map-like zoom that scales what is there and re-deals when the gesture
 * settles, the glide after a drag, and the earn-back card's tilt on the tile under the pointer.
 */
import { G, board, isMobile, measure, relayout, render, setPan } from '$lib/client/showcase-board.js';

// The board zooms like a map: the gesture scales what is there, and when it settles the board is
// dealt again at the new size around the point under the pointer or between the fingers.
// A key press or a mouse notch eases over `tween` ms rather than jumping a whole step in a frame.
export const ZOOM = { min: 0.5, max: 2.4, key: 1.25, wheel: 0.01, notch: 25, settle: 140, tween: 160 };

// The earn-back card's feel: peak tilt at the edges, and the lift on engage.
const MAX_TILT = 9;
const HOVER_SCALE = 1.04;
const FRICTION = 0.92;

const clampZoom = z => Math.min(ZOOM.max, Math.max(ZOOM.min, z));

/**
 * A gesture scales the board on screen as `translate(x, y) scale(k)` from its top-left, one write
 * per frame, and deals nothing until it rests. The rects are read once here, at the start.
 */
export function startZoom() {
  if (board.zooming) return board.zooming;
  const rect = board.viewport.getBoundingClientRect();
  const live = { from: board.zoom, k: 1, x: 0, y: 0, rect, base: { x: 0, y: 0 }, factor: 1, shift: { x: 0, y: 0 }, anchor: null, frame: 0, timer: 0 };
  if (isMobile()) {
    // The board sits in the scrolling viewport; its transform is relative to where it lies.
    const el = board.el.getBoundingClientRect();
    live.base = { x: el.left - rect.left, y: el.top - rect.top };
    live.scroll = { top: board.viewport.scrollTop, rails: [...board.rows].map(([r, row]) => [r, row.rail.scrollLeft]) };
  } else {
    live.x = board.pan.x;
    live.y = board.pan.y;
  }
  board.zooming = live;
  board.el.style.transformOrigin = '0 0';
  // Flattens a phone's tiles into the board's one layer for the gesture (see styles.css).
  board.viewport.classList.add('is-zooming');
  return live;
}

/**
 * Queues a scale by `factor` about `anchor` (viewport coordinates), plus a `shift` for fingers
 * that move together, for the next frame. `settle` is how long a pause commits the zoom; null
 * leaves the commit to the caller.
 */
export function zoomBy(factor, anchor, { settle = ZOOM.settle, shift = null } = {}) {
  const live = startZoom();
  live.factor *= factor;
  live.anchor = anchor;
  if (shift) { live.shift.x += shift.x; live.shift.y += shift.y; }
  if (!live.frame) live.frame = requestAnimationFrame(zoomFrame);
  clearTimeout(live.timer);
  if (settle != null) live.timer = setTimeout(commitZoom, settle);
}

/** A key press or a mouse notch: the same factor, spread over a few frames with an ease-out. */
export function tweenZoom(factor, anchor) {
  const start = performance.now();
  let applied = 1;
  const step = now => {
    if (!board.zooming) return;
    const t = Math.min(1, (now - start) / ZOOM.tween);
    const target = factor ** (1 - (1 - t) ** 3);
    zoomBy(target / applied, anchor);
    applied = target;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Everything queued since the last frame, as one transform. Sub-pixel: rounding here jitters. */
function applyZoom(live) {
  live.frame = 0;
  const current = live.from * live.k;
  const f = clampZoom(current * live.factor) / current;
  const ax = live.anchor.x - live.base.x, ay = live.anchor.y - live.base.y;
  live.x = ax + (live.x - ax) * f + live.shift.x;
  live.y = ay + (live.y - ay) * f + live.shift.y;
  live.k *= f;
  live.factor = 1;
  live.shift = { x: 0, y: 0 };
  board.el.style.transform = `translate3d(${live.x}px, ${live.y}px, 0) scale(${live.k})`;
}

function zoomFrame() {
  const live = board.zooming;
  if (!live) return;
  applyZoom(live);
  if (isMobile()) return;
  // Zooming out shows more of the board than was dealt; fill it in as it comes into view, over
  // as many frames as it takes.
  live.dealing = false;
  render();
  if (live.dealing && !live.frame) live.frame = requestAnimationFrame(zoomFrame);
}

/**
 * The gesture has rested: the board takes the new size for real. The tiles already dealt keep
 * their covers and move to the new geometry, and the point under the anchor stays put, measured
 * in columns and shelves so the whole-pixel geometry cannot drift it.
 */
export function commitZoom() {
  const live = board.zooming;
  if (!live) return;
  cancelAnimationFrame(live.frame);
  clearTimeout(live.timer);
  if (live.anchor && (live.factor !== 1 || live.shift.x || live.shift.y)) applyZoom(live);
  board.zooming = null;
  board.viewport.classList.remove('is-zooming');
  board.el.style.transformOrigin = '';
  if (!live.anchor) return;
  const ax = live.anchor.x - live.base.x, ay = live.anchor.y - live.base.y;
  // The board point under the anchor, in the old geometry.
  const bx = (ax - live.x) / live.k, by = (ay - live.y) / live.k;
  const old = { colW: G.colW, shelfH: G.shelfH };
  board.zoom = clampZoom(live.from * live.k);
  measure();
  const sx = G.colW / old.colW, sy = G.shelfH / old.shelfH;
  relayout();
  if (isMobile()) {
    board.el.style.transform = '';
    render();
    board.viewport.scrollTop = live.scroll.top + by * sy - ay;
    // A phone's gutter does not scale, so a rail's point is carried over counted from its first cell.
    for (const [r, left] of live.scroll.rails) {
      const row = board.rows.get(r);
      if (row) row.rail.scrollLeft = G.inset + (bx + left - G.inset) * sx - ax;
    }
  } else {
    setPan(ax - bx * sx, ay - by * sy);
    render();
  }
}

/** The drag's momentum, bleeding off frame by frame until it is still. */
export function glide() {
  const tick = () => {
    // A zoom owns the board's transform until it settles, so it stops the glide.
    if (board.dragging || board.zooming) return;
    board.velocity.x *= FRICTION;
    board.velocity.y *= FRICTION;
    if (Math.abs(board.velocity.x) < 0.2 && Math.abs(board.velocity.y) < 0.2) return;
    setPan(board.pan.x + board.velocity.x, board.pan.y + board.velocity.y);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Writes the tile's tilt and glare for the pointer's last position, once per frame. */
export function tiltFrame() {
  const t = board.tilt;
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

export function untilt() {
  const t = board.tilt;
  if (!t) return;
  board.tilt = null;
  if (t.frame) cancelAnimationFrame(t.frame);
  t.tile.classList.remove('is-tilting');
  for (const name of ['--rx', '--ry', '--scale', '--glare-x', '--glare-y', '--glare']) t.tile.style.removeProperty(name);
}
