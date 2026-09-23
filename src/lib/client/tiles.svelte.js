/**
 * The landing page's floating brand tiles: their exit animation, and the state the tilt reads.
 * `--tiles-exit` is published on the app container so the visibility swap in CSS waits exactly as
 * long as the animation runs.
 */
export const TILE_EXIT = { normal: 680, fast: 305 };

export const tiles = $state({
  exiting: false,
  fast: false,
  exit: '0s'
});

/**
 * Plays the tiles' exit and resolves when the last one has gone. `fast` is for jumping to a
 * cached search, where there is no loading state to cover the gap.
 */
export function whipOutTiles({ fast = false } = {}) {
  const duration = fast ? TILE_EXIT.fast : TILE_EXIT.normal;
  tiles.exit = `${duration}ms`;
  tiles.fast = fast;
  tiles.exiting = true;
  return new Promise(resolve => setTimeout(() => {
    // The exit is over, so a section change from here hides the tiles outright.
    tiles.exit = '0s';
    resolve();
  }, duration));
}

export function resetTiles() {
  tiles.exiting = false;
  tiles.fast = false;
}
