/**
 * Icons from the main app's library (assets/icons/, mirrored from offerlab's
 * app/assets/images/icons). icons-data.js carries only the ones in use; run
 * `npm run build:icons` after referencing a new name.
 */
import { ICONS } from './icons-data.js';

// Inline SVG markup for an icon. Library icons are 24px and paint with currentColor.
// Pass `size` to set width/height (and the stroke math's --icon-rendered), or size them
// from CSS and publish --icon-rendered in that rule.
export function icon(name, { class: className = '', size } = {}) {
  const svg = ICONS[name];
  if (!svg) {
    console.warn(`[icons] Unknown icon: ${name}`);
    return '';
  }
  let out = svg.replace('<svg ', `<svg class="icon${className ? ` ${className}` : ''}" `);
  if (size) {
    out = out
      .replace(/ width="\d+" height="\d+"/, ` width="${size}" height="${size}"`)
      .replace('<svg ', `<svg style="--icon-rendered: ${size}" `);
  }
  return out.replace('<svg ', '<svg aria-hidden="true" focusable="false" ');
}

// Swaps every <span data-icon="name" class="..."> placeholder in static markup for its SVG.
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    const markup = icon(el.dataset.icon, { class: el.className, size: el.dataset.iconSize });
    if (!markup) return;
    const template = document.createElement('template');
    template.innerHTML = markup;
    el.replaceWith(template.content.firstElementChild);
  });
}
