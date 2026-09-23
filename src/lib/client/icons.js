/**
 * Icons from the main app's library (static/assets/icons/, mirrored from offerlab's
 * app/assets/images/icons). icons-data.js carries only the ones in use; run
 * `npm run build:icons` after referencing a new name. Templates use <Icon name="..." />;
 * imperatively built markup calls icon() directly.
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
