/**
 * The picker rail's track (`.picker-columns`): horizontal scroll with snap, arrows, keyboard
 * paging, and the gutter handles that resize a column. Registers the rail's view hooks.
 */
import { runtime, view } from '../picker-state.svelte.js';
import { toggleProduct } from '../picker-selection.js';
import { armResizer, disarmResizer, startColumnResize, resizeColumnByKey } from './column_resize.js';

function columnStep(columns) {
  const column = columns.querySelector('.picker-column');
  if (!column) return 400;
  const gap = parseFloat(getComputedStyle(columns).columnGap || getComputedStyle(columns).gap) || 16;
  return column.getBoundingClientRect().width + gap;
}

function updateRailControls(rail, track) {
  const overflow = track.scrollWidth > track.clientWidth + 2;
  rail.classList.toggle('has-overflow', overflow);
  const prev = rail.querySelector('[data-action="rail-prev"]');
  const next = rail.querySelector('[data-action="rail-next"]');
  if (prev) prev.disabled = track.scrollLeft <= 2;
  if (next) next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
}

export function columnRail(columns) {
  const rail = columns.closest('.picker-rail');
  runtime.columns = columns;

  const update = () => updateRailControls(rail, columns);
  const scrollRail = (direction) => columns.scrollBy({ left: direction * columnStep(columns), behavior: 'smooth' });

  view.updateRail = update;
  view.scrollRail = scrollRail;
  view.scrollToColumn = (domain) => {
    const column = columns.querySelector(`.picker-column[data-domain="${domain}"]`);
    column?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
  };

  const onKeydown = (e) => {
    if (e.target.closest('input')) return;
    // A focused handle takes the arrows for width before the rail takes them for scroll.
    const handle = e.target.closest('.picker-column-resizer');
    if (handle) { resizeColumnByKey(handle, e); return; }
    if (e.key === 'ArrowRight') { scrollRail(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { scrollRail(-1); e.preventDefault(); }
    else if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.picker-add-column')) {
      e.target.closest('.picker-add-column').click();
      e.preventDefault();
    }
    else if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.picker-product')) {
      const tile = e.target.closest('.picker-product');
      toggleProduct(tile.dataset.domain, tile.dataset.id);
      e.preventDefault();
    }
  };
  const onPointerDown = (e) => {
    // A pointer's tool: a finger crossing the gutter is on its way to a product, not resizing.
    if (e.pointerType === 'touch') return;
    const handle = e.target.closest('.picker-column-resizer');
    if (handle) startColumnResize(handle, e, { rail, onDone: update });
  };
  const onPointerOver = (e) => {
    const handle = e.target.closest('.picker-column-resizer');
    if (handle) armResizer(handle);
  };
  const onPointerOut = (e) => {
    const handle = e.target.closest('.picker-column-resizer');
    if (handle) disarmResizer(handle);
  };

  columns.addEventListener('keydown', onKeydown);
  columns.addEventListener('scroll', update, { passive: true });
  columns.addEventListener('pointerdown', onPointerDown);
  columns.addEventListener('pointerover', onPointerOver);
  columns.addEventListener('pointerout', onPointerOut);
  window.addEventListener('resize', update);
  update();

  return {
    destroy() {
      columns.removeEventListener('keydown', onKeydown);
      columns.removeEventListener('scroll', update);
      columns.removeEventListener('pointerdown', onPointerDown);
      columns.removeEventListener('pointerover', onPointerOver);
      columns.removeEventListener('pointerout', onPointerOut);
      window.removeEventListener('resize', update);
      view.updateRail = () => {};
      view.scrollRail = () => {};
      view.scrollToColumn = () => {};
      runtime.columns = null;
    }
  };
}
