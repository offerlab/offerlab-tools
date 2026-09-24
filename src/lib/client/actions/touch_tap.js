/**
 * On touch, a control acts on the tap itself (pointerup, with a slop so a scroll that starts on
 * it is not a press); the click Safari may or may not send afterwards is ignored. Safari spends a
 * touch's first click on hover states, so waiting for it took two taps.
 *
 * `use:touchTap={selector}` on the root that contains the controls (document-wide when the root
 * is `document`): a matching element gets `.click()` on the tap, and the trailing trusted click
 * within 700ms is swallowed wherever it lands. The tap can remove what was tapped (Clear empties
 * the tray), so the click may arrive on a control in another root, under where the finger was.
 */
const TAP_SLOP = 8;
const TRAILING_CLICK_MS = 700;

// No tap yet: -Infinity, so a click in the page's first 700ms is not mistaken for a tap's trailing click.
let tappedAt = -Infinity;
let swallowing = false;

function swallowTrailingClicks() {
  if (swallowing || typeof document === 'undefined') return;
  swallowing = true;
  document.addEventListener('click', (e) => {
    if (!e.isTrusted || performance.now() - tappedAt > TRAILING_CLICK_MS) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
}

export function bindTouchTap(root, selector) {
  let down = null;
  swallowTrailingClicks();

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
  root.addEventListener('pointerdown', onDown);
  root.addEventListener('pointerup', onUp);
  return () => {
    root.removeEventListener('pointerdown', onDown);
    root.removeEventListener('pointerup', onUp);
  };
}

export function touchTap(node, selector) {
  const unbind = bindTouchTap(node, selector);
  return { destroy: unbind };
}
