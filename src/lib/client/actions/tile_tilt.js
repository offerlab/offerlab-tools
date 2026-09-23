/**
 * 3D cursor-follow on the landing tiles: each tile leans towards the pointer by up to 2.5deg.
 * `use:tileTilt={{ active }}`: the tilt only runs while the tiles are on screen and not exiting;
 * turning it off levels every tile.
 */
const TILT_MAX_DEG = 2.5;

export function tileTilt(container, params) {
  let active = params?.active !== false;

  const reset = () => {
    container.querySelectorAll('.tile').forEach(tile => tile.style.setProperty('--tilt-y', '0deg'));
  };

  const update = (clientX) => {
    if (!active) { reset(); return; }
    const w = window.innerWidth;
    container.querySelectorAll('.tile').forEach(tile => {
      const rect = tile.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const normalized = Math.max(-1, Math.min(1, (clientX - centerX) / (w * 0.4)));
      tile.style.setProperty('--tilt-y', `${normalized * TILT_MAX_DEG}deg`);
    });
  };

  const onMove = (e) => update(e.clientX);
  document.addEventListener('mousemove', onMove);
  document.documentElement.addEventListener('mouseleave', reset);

  return {
    update(next) {
      active = next?.active !== false;
      if (!active) reset();
    },
    destroy() {
      document.removeEventListener('mousemove', onMove);
      document.documentElement.removeEventListener('mouseleave', reset);
    }
  };
}
