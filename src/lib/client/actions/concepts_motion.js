/**
 * The concepts card's motion: the glow sweep on reveal, the stack fanning out, the thumbs flying
 * in, the copy crossfade, and the morph between banner and chip. Imperative on purpose: every
 * one of these measures the box or needs a class on a specific frame.
 */
import { flushSync } from 'svelte';
import { picker, runtime, view } from '../picker-state.svelte.js';

const REVEAL_MS = 1600;
// Chip and banner are one box. fit-content to 100% has nothing to interpolate, so both ends are
// pinned in pixels and released once the run finishes; a shrink-wrapped shell follows the pinned
// child, which is what keeps the glow tracking the box frame by frame.
const MORPH_MS = 420;

function playCardReveal(shell) {
  shell.classList.remove('is-revealing');
  // Reflow so a repeat reveal restarts the animation rather than being ignored as a no-op.
  void shell.offsetWidth;
  shell.classList.add('is-revealing');
  setTimeout(() => shell.classList.remove('is-revealing'), REVEAL_MS);
}

// The thumbs' entrance is for a fresh batch only; the class comes off once it has played so a
// product toggle re-rendering the cards does not replay it.
function enterGrid(card) {
  const grid = card.querySelector('.picker-concepts-grid');
  if (!grid) return;
  grid.classList.remove('is-entering');
  void grid.offsetWidth;
  grid.classList.add('is-entering');
  setTimeout(() => grid.classList.remove('is-entering'), REVEAL_MS);
}

// The stack arrives collapsed under the front card and fans to its slots on the next frame.
// The fan is an entrance for a NEW set of images: replaying it on every change to the head made
// the pile flutter on a change that has nothing to do with what it shows.
function fanOutStack(card) {
  const stack = card.querySelector('.picker-stack');
  if (!stack) return;
  const signature = [...stack.querySelectorAll('img')].map(img => img.src).join('|');
  if (signature === runtime.stackSignature) return;
  runtime.stackSignature = signature;
  stack.classList.add('picker-stack--entering');
  requestAnimationFrame(() => requestAnimationFrame(() => stack.classList.remove('picker-stack--entering')));
}

function crossfadeCopy(card) {
  card.classList.add('is-swapping');
  requestAnimationFrame(() => requestAnimationFrame(() => card.classList.remove('is-swapping')));
}

function toggleMinimize(card, shell) {
  const next = !picker.conceptsMinimized;

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    picker.conceptsMinimized = next;
    shell.classList.toggle('is-chip', next);
    return;
  }

  const fromW = card.offsetWidth;
  const fromH = card.offsetHeight;
  // A stadium's 999px only renders as one because the radius is clamped to half the box at paint.
  // Both ends have to be the CLAMPED pixel value or the run sits above the clamp, changing nothing
  // visible, and the corners appear to snap.
  const clampedRadius = (h) => Math.min(parseFloat(getComputedStyle(card).borderTopLeftRadius), h / 2);
  const fromRadius = clampedRadius(fromH);

  card.style.transition = 'none';
  card.style.width = '';
  card.style.height = '';
  picker.conceptsMinimized = next;
  // Measure with the shell in its TARGET state: a shrink-wrapped shell would hand back the
  // banner's max-content width rather than the width it will actually settle at.
  shell.classList.toggle('is-chip', next);
  flushSync();
  const toW = card.offsetWidth;
  const toH = card.offsetHeight;

  // Pin the content to its FINAL layout width for the run. That is the whole trick: the box can
  // travel around it without the headline re-wrapping, which is what lets it stay visible at all.
  // The scale and fade are a keyframe (see .is-morphing > *), not a transition: these elements were
  // built a moment ago and have no previous computed style for a transition to interpolate from.
  const content = [...card.children];
  const pinned = content.map(el => el.getBoundingClientRect().width);
  content.forEach((el, i) => { el.style.width = `${pinned[i]}px`; });
  card.classList.add('is-morphing');
  // Shrink-wrapped for BOTH directions of the run so the glow tracks the pinned card; expanding
  // hands it back on release.
  shell.classList.add('is-chip');

  const toRadius = clampedRadius(toH);
  card.style.width = `${fromW}px`;
  card.style.height = `${fromH}px`;
  card.style.borderRadius = `${fromRadius}px`;
  void card.offsetHeight;
  card.style.transition = '';

  card.style.width = `${toW}px`;
  card.style.height = `${toH}px`;
  card.style.borderRadius = `${toRadius}px`;
  const release = (e) => {
    if (e.target !== card || e.propertyName !== 'height') return;
    card.style.width = '';
    card.style.height = '';
    card.style.borderRadius = '';
    content.forEach(el => { el.style.width = ''; });
    card.classList.remove('is-morphing');
    shell.classList.toggle('is-chip', next);
    card.removeEventListener('transitionend', release);
  };
  card.addEventListener('transitionend', release);
  // A run that never fires transitionend (an interrupted morph) still has to hand the box back.
  setTimeout(() => release({ target: card, propertyName: 'height' }), MORPH_MS + 120);
}

/** `use:conceptsMotion` on the `.picker-concepts` card; the shell is its parent. */
export function conceptsMotion(card) {
  const shell = card.closest('.picker-concepts-shell');

  view.reveal = () => playCardReveal(shell);
  view.enterGrid = () => enterGrid(card);
  view.crossfade = () => crossfadeCopy(card);
  view.fanOutStack = () => fanOutStack(card);
  view.toggleMinimize = () => toggleMinimize(card, shell);

  // The minimise control is hidden below this width, so a chip carried in from a wider
  // viewport would have no way back. Expand it rather than stranding the user.
  const onResize = () => {
    if (picker.conceptsMinimized && window.matchMedia('(max-width: 900px)').matches) {
      picker.conceptsMinimized = false;
      shell.classList.remove('is-chip');
    }
  };
  window.addEventListener('resize', onResize);

  return {
    destroy() {
      window.removeEventListener('resize', onResize);
      for (const name of ['reveal', 'enterGrid', 'crossfade', 'fanOutStack', 'toggleMinimize']) view[name] = () => {};
    }
  };
}
