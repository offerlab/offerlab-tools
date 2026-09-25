/**
 * Handing a bundle to OfferLab: the selection becomes a draft collab and the builder opens on it.
 */
import * as offerlab from './offerlab.js';
import { picker, entryFor, sellerEntry, setDraft } from './picker-state.svelte.js';

// The brands in the order they were first picked: what a draft is called until OfferLab names it.
function draftName() {
  const seen = [];
  [...picker.selection.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .forEach(pick => { if (!seen.includes(pick.domain)) seen.push(pick.domain); });
  return seen.map(domain => entryFor(domain)?.brand.name || domain).join(' × ');
}

/**
 * Turns the current selection into a draft collab in OfferLab and opens the builder on it.
 * Signing in comes first when there is no session; the operator lands back here and clicks again.
 */
export async function createDraft(name) {
  if (picker.draft.status === 'working') return;

  // Off for everyone the handoff is not for. It signs in against an internal demo environment,
  // so the alternative to saying this is sending a guest to a login they cannot pass.
  if (!offerlab.isEnabled()) {
    setDraft('pending', 'Building bundles from here is coming soon');
    return;
  }

  if (!offerlab.isConnected()) {
    setDraft('working', 'Opening OfferLab');
    try {
      await offerlab.connect();
    } catch (err) {
      setDraft('error', err.message || 'Could not reach OfferLab');
    }
    return;
  }

  const picks = [...picker.selection.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .map(pick => ({
      domain: pick.domain,
      brandName: entryFor(pick.domain)?.brand.name,
      product: pick.product,
      storefront: entryFor(pick.domain)?.brand.catalog?.status === 'shopify'
    }));
  if (!picks.length) return;

  setDraft('working', 'Connecting to OfferLab');
  try {
    // A concept's name is the bundle's. Without one, OfferLab names the bundle from its products
    // (Stacks::GenerateNameJob), which a "Brand × Brand" name from here would have kept it from doing.
    const draft = await offerlab.createDraftBundle({
      name: name || undefined,
      picks,
      // The bundle presents as whichever brand leads it, and it is being pitched to the one that
      // was searched for, so that is the brand whose products go first.
      presentingDomain: sellerEntry()?.domain
    });
    offerlab.rememberDraft(sellerEntry()?.domain, draft);
    setDraft('done', draft.name || draftName(), draft.url);
    // A draft nobody looks at is not a handoff. Opened here, off the click that started it.
    window.open(draft.url, '_blank', 'noopener');
  } catch (err) {
    console.warn('[OfferLab] draft failed:', err);
    setDraft('error', err.message || 'Could not create the draft');
  }
}
