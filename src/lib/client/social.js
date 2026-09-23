/**
 * Social accounts as the cards and the pitch show them: scraped from the brand's site with
 * Gemini's guesses filling any platform the site did not link, stored as {platform: {handle, url}}
 * in the app's registry order.
 */
import { normalizeSocial } from '$lib/shared/socials.js';

export const SOCIAL_PLATFORMS = [
  { key: 'instagram', label: 'Instagram', icon: 'instagram' },
  { key: 'tiktok', label: 'TikTok', icon: 'tiktok' },
  { key: 'twitter', label: 'X', icon: 'twitter-x' },
  { key: 'youtube', label: 'YouTube', icon: 'youtube' },
  { key: 'pinterest', label: 'Pinterest', icon: 'pinterest' },
  { key: 'facebook', label: 'Facebook', icon: 'facebook' },
  { key: 'snapchat', label: 'Snapchat', icon: 'snapchat' },
  { key: 'shopmy', label: 'ShopMy', icon: 'shopmy' },
  { key: 'amazon', label: 'Amazon shop', icon: 'amazon' },
  { key: 'ltk', label: 'LTK', icon: 'ltk' }
];

export function hasAnySocialLink(social) {
  return Object.keys(normalizeSocial(social)).length > 0;
}

/** The platforms a brand is on, in display order: [{ key, label, icon, handle, url }]. */
export function socialEntries(social) {
  const normalized = normalizeSocial(social);
  return SOCIAL_PLATFORMS.filter(p => normalized[p.key]).map(p => ({ ...p, ...normalized[p.key] }));
}
