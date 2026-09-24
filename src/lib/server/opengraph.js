/**
 * OpenGraph.io's hybrid graph falls back to the site's favicon or header logo when a page carries
 * no og:image (Caraway, Fly By Jing). Neither is a cover; the card does better with no image.
 */
export function usableCover(imageUrl, faviconUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return null;
  if (faviconUrl && imageUrl === faviconUrl) return null;
  if (/favicon|(^|[\/_.-])logo([\/_.-]|$)|\.svg(\?|$)|\.ico(\?|$)/i.test(imageUrl)) return null;
  return imageUrl;
}

