/**
 * The search history rows inside an omnibar's dropdown. Rendered imperatively into the <ul>
 * because resolve.js's suggestions write the same list while a name is typed; the two share one
 * regime rather than fighting over the nodes.
 *
 * A row is chosen on the tap itself for touch (pointerup, so a scroll that starts on a row is not
 * a choice) and on the click for a mouse. Safari spends a touch's first click on hover states and
 * the keyboard's reflow, so waiting for it took two taps.
 */
import { icon } from '../icons.js';
import { getFaviconUrl, FAVICON_PLACEHOLDER } from '../util.js';

const TAP_SLOP = 8;

export function renderHistoryRows(list, history) {
  if (!list || list.classList.contains('is-suggesting')) return;
  if (history.length === 0) {
    list.innerHTML = '<li class="history-empty">No recent searches</li>';
    return;
  }
  list.innerHTML = history.map(item => `
    <li class="history-item" data-url="${item.domain}">
      <img src="${getFaviconUrl(item.domain)}" alt="" class="history-item-favicon" onerror="this.src='${FAVICON_PLACEHOLDER}'">
      <span class="history-item-url">${item.domain}</span>
      <button type="button" class="history-item-remove-btn" data-url="${item.domain}" aria-label="Remove ${item.domain} from history">
        ${icon('cross-large', { class: 'history-item-remove-icon' })}
      </button>
    </li>
  `).join('');
}

/** `use:historyList={{ onChoose(domain), onRemove(domain) }}` on the <ul>. */
export function historyList(list, params) {
  let handlers = params;
  let down = null;
  let chosenAt = -Infinity;

  const choose = (item) => {
    chosenAt = performance.now();
    handlers.onChoose(item.dataset.url);
  };
  const onDown = (e) => {
    down = e.pointerType === 'touch' ? { x: e.clientX, y: e.clientY, item: e.target.closest('.history-item') } : null;
  };
  const onUp = (e) => {
    if (!down || e.pointerType !== 'touch') return;
    const item = e.target.closest('.history-item');
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > TAP_SLOP;
    const started = down.item;
    down = null;
    if (!item || item !== started || moved || e.target.closest('.history-item-remove-btn')) return;
    choose(item);
  };
  const onClick = (e) => {
    const removeBtn = e.target.closest('.history-item-remove-btn');
    if (removeBtn) {
      e.preventDefault();
      e.stopPropagation();
      if (removeBtn.dataset.url) handlers.onRemove(removeBtn.dataset.url);
      return;
    }
    // The click that follows a touch we already acted on.
    if (performance.now() - chosenAt < 700) return;
    const item = e.target.closest('.history-item');
    if (item) choose(item);
  };

  list.addEventListener('pointerdown', onDown);
  list.addEventListener('pointerup', onUp);
  list.addEventListener('click', onClick);
  return {
    update(next) { handlers = next; },
    destroy() {
      list.removeEventListener('pointerdown', onDown);
      list.removeEventListener('pointerup', onUp);
      list.removeEventListener('click', onClick);
    }
  };
}
