/**
 * Column resizing on the picker rail, ported from the app's builder preview panel: a pointer
 * drag on the gutter handle, or the arrow keys on it.
 */

// Hover intent, so a cursor crossing the gutter does not flash the handle.
const RESIZER_ARM_DELAY = 100;
const RESIZE_STEP = 16;
const RESIZE_STEP_LARGE = 64;
let armTimer = null;

export function armResizer(handle) {
  clearTimeout(armTimer);
  armTimer = setTimeout(() => { handle.dataset.armed = ''; }, RESIZER_ARM_DELAY);
}

export function disarmResizer(handle) {
  clearTimeout(armTimer);
  delete handle.dataset.armed;
}

// Writes a preferred width, then reads back what clamp() allowed. Parking a far-out value would
// leave a dead zone before the drag bites on the way back.
function setColumnWidth(column, px) {
  column.dataset.resized = '';
  column.style.setProperty('--col-w', `${Math.round(px)}px`);
  column.style.setProperty('--col-w', `${Math.round(column.getBoundingClientRect().width)}px`);
}

export function startColumnResize(handle, event, { rail, onDone }) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const column = handle.closest('.picker-column');
  if (!column) return;
  event.preventDefault();

  const startX = event.clientX;
  const startWidth = column.getBoundingClientRect().width;
  handle.setPointerCapture?.(event.pointerId);
  rail.setAttribute('data-resizing', '');

  const onMove = (e) => setColumnWidth(column, startWidth + (e.clientX - startX));
  const onUp = () => {
    rail.removeAttribute('data-resizing');
    onDone();
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

// Keyboard equivalent of the drag, for anyone not holding a pointer.
export function resizeColumnByKey(handle, event) {
  const step = event.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP;
  const delta = { ArrowLeft: -step, ArrowRight: step }[event.key];
  if (delta === undefined) return;
  const column = handle.closest('.picker-column');
  if (!column) return;
  event.preventDefault();
  setColumnWidth(column, column.getBoundingClientRect().width + delta);
}
