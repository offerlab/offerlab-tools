/**
 * Moves the element to document.body for as long as it lives. The app container carries a
 * perspective for the tile tilt, which would make a fixed layer position against it instead of
 * the viewport, so the picker's tray and dialog live on body, like the social popover.
 */
export function portal(node) {
  document.body.appendChild(node);
  return {
    destroy() {
      node.remove();
    }
  };
}
