/**
 * `use:delegateActions={handler}`: delegated clicks for a root whose controls carry data-action,
 * with the touch handling from touch_tap.js so a product tile picks on the first tap.
 */
import { bindTouchTap } from './touch_tap.js';

export function delegateActions(root, handler) {
  let current = handler;
  const onClick = (e) => current(e);

  root.addEventListener('click', onClick);
  const unbindTap = bindTouchTap(root, '[data-action]');

  return {
    update(next) {
      current = next;
    },
    destroy() {
      root.removeEventListener('click', onClick);
      unbindTap();
    }
  };
}
