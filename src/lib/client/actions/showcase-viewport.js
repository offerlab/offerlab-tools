/**
 * `use:viewportGestures={{ onTile }}` on the library viewport: drag, wheel and keys pan the
 * desktop board, ctrl+wheel and two fingers zoom it, the tile under the pointer tilts, and a
 * click on a tile (never the one that ends a drag) hands the tile to `onTile`.
 */
import { board, isMobile, setPan } from '$lib/client/showcase-board.js';
import { commitZoom, glide, startZoom, tiltFrame, tweenZoom, untilt, ZOOM, zoomBy } from '$lib/client/showcase-zoom.js';

const KEY_STEP = 160;
const DRAG_THRESHOLD = 6;

export function viewportGestures(view, options) {
  let { onTile } = options;
  const listeners = [];
  const on = (type, handler, opts) => {
    view.addEventListener(type, handler, opts);
    listeners.push([type, handler, opts]);
  };

  // A phone scrolls its shelves natively: no drag, no wheel, no keys of the board's own.
  on('pointerdown', event => {
    if (event.button !== 0 || isMobile()) return;
    if (event.target.closest('.library-omni, .library-lightbox')) return;
    commitZoom();
    board.dragging = true;
    board.moved = false;
    board.suppressClick = false;
    board.velocity = { x: 0, y: 0 };
    board.origin = { x: event.clientX - board.pan.x, y: event.clientY - board.pan.y, lastX: event.clientX, lastY: event.clientY, t: performance.now() };
    board.pointerId = event.pointerId;
  });

  on('pointermove', event => {
    if (!board.dragging) return;
    const now = performance.now();
    const dt = Math.max(1, now - board.origin.t);
    board.velocity = { x: (event.clientX - board.origin.lastX) / dt * 16, y: (event.clientY - board.origin.lastY) / dt * 16 };
    board.origin.lastX = event.clientX; board.origin.lastY = event.clientY; board.origin.t = now;
    const x = event.clientX - board.origin.x;
    const y = event.clientY - board.origin.y;
    // Capturing on pointerdown would retarget the click to the viewport instead of the tile, so
    // the capture waits for a real drag.
    if (!board.moved && Math.hypot(x - board.pan.x, y - board.pan.y) > DRAG_THRESHOLD) {
      board.moved = true;
      view.setPointerCapture(board.pointerId);
      view.classList.add('is-dragging');
    }
    if (board.moved) setPan(x, y);
  });

  // The click that follows a drag's pointerup is the drag's own; the flag it consumes is set here
  // and cleared on the next pointerdown, so it can never swallow a later, separate click.
  const release = () => {
    if (!board.dragging) return;
    board.dragging = false;
    view.classList.remove('is-dragging');
    if (view.hasPointerCapture?.(board.pointerId)) view.releasePointerCapture(board.pointerId);
    board.suppressClick = board.moved;
    if (board.moved) glide();
  };
  on('pointerup', release);
  on('pointercancel', release);

  on('click', event => {
    if (board.suppressClick) { event.stopPropagation(); event.preventDefault(); board.suppressClick = false; return; }
    const tile = event.target.closest('.library-tile');
    if (tile) onTile(tile.dataset.id, tile);
  }, true);

  // The earn-back card's tilt and glare, delegated: the tile under the pointer tilts toward it and
  // catches the light under it. The rect is cached per interaction and the vars are written once
  // per frame, so the hot path is compositor transforms and one gradient.
  on('pointerover', event => {
    if (event.pointerType === 'touch') return;
    const tile = event.target.closest('.library-tile');
    if (!tile || tile === board.tilt?.tile || tile.classList.contains('library-tile--ghost')) return;
    untilt();
    board.tilt = { tile, rect: tile.getBoundingClientRect(), frame: 0, event };
    tile.classList.add('is-tilting');
    tiltFrame();
  });
  on('pointermove', event => {
    if (!board.tilt || board.dragging) { if (board.dragging) untilt(); return; }
    board.tilt.event = event;
    if (!board.tilt.frame) board.tilt.frame = requestAnimationFrame(tiltFrame);
  });
  on('pointerout', event => {
    if (board.tilt && event.target.closest('.library-tile') === board.tilt.tile && !board.tilt.tile.contains(event.relatedTarget)) untilt();
  });

  // A pinch on a trackpad arrives as a wheel with ctrlKey, as does ctrl and the wheel; either
  // zooms about the pointer. A plain wheel pans.
  on('wheel', event => {
    if (isMobile()) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      // Safari may send a pinch as gesture events and ctrl+wheel both; the gesture owns it.
      if (board.gesture || performance.now() < board.gestureQuietUntil) return;
      const { rect } = startZoom();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      // A trackpad pinch arrives in small deltas; a mouse notch is 100 at once, held to a step and eased.
      const delta = Math.max(-ZOOM.notch, Math.min(ZOOM.notch, event.deltaY));
      const factor = Math.exp(-delta * ZOOM.wheel);
      if (event.deltaMode || Math.abs(event.deltaY) >= 50) tweenZoom(factor, anchor);
      else zoomBy(factor, anchor);
      return;
    }
    commitZoom();
    setPan(board.pan.x - event.deltaX, board.pan.y - event.deltaY);
  }, { passive: false });

  on('keydown', event => {
    if (event.key === '=' || event.key === '+' || event.key === '-' || event.key === '_') {
      event.preventDefault();
      const { rect } = startZoom();
      tweenZoom(event.key === '-' || event.key === '_' ? 1 / ZOOM.key : ZOOM.key, { x: rect.width / 2, y: rect.height / 2 });
      return;
    }
    const step = { ArrowLeft: [KEY_STEP, 0], ArrowRight: [-KEY_STEP, 0], ArrowUp: [0, KEY_STEP], ArrowDown: [0, -KEY_STEP] }[event.key];
    if (!step || isMobile()) return;
    event.preventDefault();
    commitZoom();
    setPan(board.pan.x + step[0], board.pan.y + step[1]);
  });

  bindPinch(view, on);

  return {
    update(next) { onTile = next.onTile; },
    destroy() {
      for (const [type, handler, opts] of listeners) view.removeEventListener(type, handler, opts);
    }
  };
}

/** Two fingers: the board scales between them and follows them, and is dealt again when they lift. */
function bindPinch(view, on) {
  let pinch = null;
  const span = touches => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  const middle = touches => ({ x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2 });
  let touching = 0;
  on('touchstart', event => {
    touching = event.touches.length;
    if (event.touches.length !== 2) return;
    // On a desktop touchscreen the first finger started a drag; a pinch takes over from it.
    board.dragging = false;
    view.classList.remove('is-dragging');
    pinch = { span: span(event.touches), middle: middle(event.touches) };
  }, { passive: true });
  on('touchmove', event => {
    if (!pinch || event.touches.length !== 2) return;
    event.preventDefault();
    const { rect } = startZoom();
    const now = span(event.touches), mid = middle(event.touches);
    const shift = { x: mid.x - pinch.middle.x, y: mid.y - pinch.middle.y };
    const factor = now / pinch.span;
    pinch = { span: now, middle: mid };
    zoomBy(factor, { x: mid.x - rect.left - shift.x, y: mid.y - rect.top - shift.y }, { settle: null, shift });
  }, { passive: false });
  const end = event => {
    touching = event.touches.length;
    if (!pinch || event.touches.length >= 2) return;
    pinch = null;
    commitZoom();
  };
  on('touchend', end);
  on('touchcancel', end);

  // Safari on a Mac sends a trackpad pinch as gesture events, not ctrl+wheel, and zooms the page
  // unless they are cancelled. `scale` runs from 1 at the start of the gesture. A phone, or any
  // pinch with fingers on the glass, is the touch path's.
  const ownsGesture = () => !isMobile() && !touching;
  on('gesturestart', event => {
    if (!ownsGesture()) return;
    event.preventDefault();
    board.gesture = { scale: 1 };
  });
  on('gesturechange', event => {
    if (!board.gesture || !ownsGesture()) return;
    event.preventDefault();
    const { rect } = startZoom();
    const factor = event.scale / board.gesture.scale;
    board.gesture.scale = event.scale;
    zoomBy(factor, { x: event.clientX - rect.left, y: event.clientY - rect.top });
  });
  on('gestureend', event => {
    if (!board.gesture) return;
    event.preventDefault();
    board.gesture = null;
    // The ctrl+wheel tail of the same pinch, if this Safari sends one, is not a second zoom.
    board.gestureQuietUntil = performance.now() + 150;
  });
}
