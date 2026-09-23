/**
 * On touch, a control acts on the tap itself (pointerup, with a slop so a scroll that starts on
 * it is not a press); the click Safari may or may not send afterwards is ignored. Safari spends a
 * touch's first click on hover states, so waiting for it took two taps.
 *
 * `use:touchTap={selector}` on the root that contains the controls (document-wide when the root
 * is `document`): a matching element gets `.click()` on the tap, and the trailing trusted click
 * within 700ms is swallowed.
 */
const TAP_SLOP = 8;
const TRAILING_CLICK_MS = 700;

export function bindTouchTap(root, selector) {
  let down = null;
  let tappedAt = 0;

  const onDown = (e) => {
    const el = e.pointerType === 'touch' ? e.target.closest(selector) : null;
    down = el ? { el, x: e.clientX, y: e.clientY } : null;
  };
  const onUp = (e) => {
    if (!down || e.pointerType !== 'touch') return;
    const { el, x, y } = down;
    down = null;
    if (e.target.closest(selector) !== el || Math.hypot(e.clientX - x, e.clientY - y) > TAP_SLOP) return;
    tappedAt = performance.now();
    el.click();
  };
  const onClick = (e) => {
    if (!e.isTrusted || performance.now() - tappedAt > TRAILING_CLICK_MS || !e.target.closest(selector)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  };

  root.addEventListener('pointerdown', onDown);
  root.addEventListener('pointerup', onUp);
  root.addEventListener('click', onClick, true);
  return () => {
    root.removeEventListener('pointerdown', onDown);
    root.removeEventListener('pointerup', onUp);
    root.removeEventListener('click', onClick, true);
  };
}

export function touchTap(node, selector) {
  const unbind = bindTouchTap(node, selector);
  return { destroy: unbind };
}
