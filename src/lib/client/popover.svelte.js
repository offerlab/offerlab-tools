/**
 * The result card's "⋯" popover: the brand's social links and, for staff, the moderation actions.
 * One popover at a time; it renders inside its card so it scrolls with the page.
 */
import { app } from './state.svelte.js';
import * as store from './store.js';
import * as offerlab from './offerlab.js';
import { extractDomain } from './util.js';
import { getSearchFromUrl } from './url.js';

export const popover = $state({
  domain: null,
  top: 0,
  left: 0,
  busy: false,
  error: ''
});

const POPOVER_WIDTH = 220; // matches .social-popover min-width

export function showSocialPopover(button, domain) {
  const card = button.closest('.result-card');
  const rect = button.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  popover.domain = domain;
  // 4px below the three-dot menu, centered under it, relative to the card.
  popover.top = rect.bottom - cardRect.top + 4;
  popover.left = Math.max(0, rect.left - cardRect.left - (POPOVER_WIDTH / 2) + (rect.width / 2));
  popover.busy = false;
  popover.error = '';
}

export function hideSocialPopover() {
  popover.domain = null;
  popover.busy = false;
  popover.error = '';
}

/**
 * Staff only. "Wrong products" hides the brand's products everywhere; "Remove from results" drops
 * the brand from this search only. Both go through /api/moderation with the OfferLab token.
 */
export async function moderateCard(domain, action) {
  const searchDomain = extractDomain(getSearchFromUrl() || '');
  popover.busy = true;
  try {
    const bearer = await offerlab.freshToken();
    if (!bearer) throw new Error('Sign in to OfferLab to moderate results.');
    await store.moderate({ action, domain, searchDomain }, bearer);
  } catch (err) {
    popover.error = err.message.endsWith('.') ? err.message : `${err.message}.`;
    popover.busy = false;
    return;
  }
  hideSocialPopover();
  const results = app.results;
  if (action === 'remove-recommendation') {
    if (results) results.brands = results.brands.filter(b => extractDomain(b.url || '') !== domain);
    return;
  }
  const hidden = { status: 'none', domain, count: 0, products: [], hidden: true };
  const brand = results?.brands?.find(b => extractDomain(b.url || '') === domain);
  if (brand) brand.catalog = hidden;
}
