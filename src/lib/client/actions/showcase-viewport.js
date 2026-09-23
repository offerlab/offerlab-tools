/**
 * `use:showcaseBoard={{ onTile, onReady }}` on the library viewport: mounts the board (a map the
 * pointer, fingers, trackpad and keys pan and zoom; see showcase-board.js) over the viewport's
 * `.library-board`, hands its controls to `onReady`, and a tile click (never the one that ends a
 * drag) to `onTile`.
 */
import { createBoard } from '$lib/client/showcase-board.js';
import { coverUrl, escape } from '$lib/client/showcase.svelte.js';

export function showcaseBoard(view, options) {
  let { onTile } = options;
  const shelves = createBoard({
    section: view.closest('.library-section'),
    viewport: view,
    el: view.querySelector('.library-board'),
    media: window.matchMedia('(max-width: 900px)'),
    coverUrl,
    escape,
    onTile: (id, tile) => onTile(id, tile)
  });
  options.onReady?.(shelves);

  return {
    update(next) { onTile = next.onTile; },
    destroy() { shelves.destroy(); }
  };
}
