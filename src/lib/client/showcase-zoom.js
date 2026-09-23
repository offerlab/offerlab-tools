/**
 * The board's motion: map-like zoom that scales what is there and re-deals when the gesture
 * settles, the glide after a drag, and the earn-back card's tilt on the tile under the pointer.
 */
import { board, clearBoard, isMobile, measure, render, setPan } from '$lib/client/showcase-board.js';

// The board zooms like a map: the gesture scales what is there, and when it settles the board is
// dealt again at the new size around the point under the pointer or between the fingers.
export const ZOOM = { min: 0.5, max: 2.4, key: 1.25, wheel: 0.01, notch: 25, settle: 140 };

// The earn-back card's feel: peak tilt at the edges, and the lift on engage.
const MAX_TILT = 9;
const HOVER_SCALE = 1.04;
const FRICTION = 0.92;

const clampZoom = z => Math.min(ZOOM.max, Math.max(ZOOM.min, z));

/**
 * Scales the board on screen by `factor` about `anchor` (viewport coordinates), on top of any
 * zoom still in flight, and arranges for the board to be dealt again once the gesture rests.
 */
export function zoomBy(factor, anchor, { settle = ZOOM.settle } = {}) {
  const live = board.zooming || { from: board.zoom, to: board.zoom, anchor, timer: 0, scroll: null };
  live.to = clampZoom(live.to * factor);
  live.anchor = anchor;
  if (!live.scroll && isMobile()) {
    // What the viewport and each rail were scrolled to when the pinch began, so the commit can
    // put the same point back under the fingers.
    live.scroll = { top: board.viewport.scrollTop, rails: [...board.rows].map(([r, row]) => [r, row.rail.scrollLeft]) };
  }
  board.zooming = live;
  const k = live.to / live.from;
  if (isMobile()) {
    const rect = board.el.getBoundingClientRect();
    const view = board.viewport.getBoundingClientRect();
    board.el.style.transformOrigin = `${anchor.x + view.left - rect.left}px ${anchor.y + view.top - rect.top}px`;
    board.el.style.transform = `scale(${k})`;
  } else {
    board.el.style.transformOrigin = '0 0';
    board.el.style.transform = `translate3d(${Math.round(anchor.x - (anchor.x - board.pan.x) * k)}px, ${Math.round(anchor.y - (anchor.y - board.pan.y) * k)}px, 0) scale(${k})`;
  }
  clearTimeout(live.timer);
  if (settle) live.timer = setTimeout(commitZoom, settle);
  else commitZoom();
}

/** The gesture has rested: the board takes the new size for real, about the same anchor. */
export function commitZoom() {
  const live = board.zooming;
  if (!live) return;
  board.zooming = null;
  clearTimeout(live.timer);
  const k = live.to / live.from;
  board.zoom = live.to;
  board.el.style.transformOrigin = '';
  board.el.style.transform = '';
  measure();
  clearBoard();
  if (isMobile()) {
    render();
    const { anchor, scroll } = live;
    board.viewport.scrollTop = (scroll.top + anchor.y) * k - anchor.y;
    for (const [r, left] of scroll.rails) {
      const row = board.rows.get(r);
      if (row) row.rail.scrollLeft = (left + anchor.x) * k - anchor.x;
    }
  } else {
    setPan(live.anchor.x - (live.anchor.x - board.pan.x) * k, live.anchor.y - (live.anchor.y - board.pan.y) * k);
    render();
  }
}

/** The drag's momentum, bleeding off frame by frame until it is still. */
export function glide() {
  const tick = () => {
    if (board.dragging) return;
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
