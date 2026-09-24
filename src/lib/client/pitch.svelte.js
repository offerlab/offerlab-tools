/**
 * The "Pitch them" modal's state and the calls the rest of the finder makes on it. PitchModal.svelte
 * renders `pitch`; the results cards and the popstate handler drive it through the functions here.
 *
 * Brand 1 is the searched brand (pitched TO), brand 2 the recommended brand (collab WITH).
 */
import { getResults } from './state.svelte.js';
import { extractDomain } from './util.js';
import { currentUrl, pushUrl, replaceUrl, PITCH_PARAM, getPitchFromUrl } from './url.js';
import * as offerlab from './offerlab.js';
import { generatePitchContent } from './pitch-api.js';

export const pitch = $state({
  // The overlay is on screen; `closing` while its exit animation runs.
  open: false,
  closing: false,
  brand: null,
  brand1: null,
  brand2: null,
  searchedBrand: null,
  model: 'gemini-2.5-flash',
  generating: false,
  // What the content area shows: 'initial' | 'loading' | 'error' | 'results'.
  stage: 'initial',
  error: '',
  result: null,
  // 'hidden' | 'generating' | 'regenerate'
  toolbar: 'hidden',
  // The drafts on screen for the pair currently open, so the prompt and the render agree.
  drafts: []
});

let abortController = null;
// Generated pitches, keyed "brand1|brand2", so reopening a pair renders instantly.
const pitchCache = new Map();
// The drafts come from the store; a load that lands after the modal moved on is dropped.
let bundlesBuiltRequest = 0;

export function isPitchOpen() {
  return pitch.open;
}

export function currentPitchBrand() {
  return pitch.brand;
}

function cacheKey() {
  return `${pitch.brand1}|${pitch.brand2}`;
}

/**
 * "Bundles built": what has already been made for this pair, so the outreach can point at
 * something real rather than describing it. Renders nothing for a pair with no drafts.
 *
 * The published page is looked up rather than stored at creation time, because publishing happens
 * later and in the builder, not here. It needs a connection, so a disconnected operator still gets
 * the list and the builder links, just without the PDP.
 */
async function loadBundlesBuilt(searchedDomain, partnerDomain) {
  const request = ++bundlesBuiltRequest;
  pitch.drafts = [];
  const drafts = await offerlab.draftsForPair(searchedDomain, partnerDomain);
  if (request !== bundlesBuiltRequest) return;
  pitch.drafts = drafts;
  if (pitch.drafts.length) fillPublishedLinks(searchedDomain);
}

// Newest first is what the operator just made. A stack deleted in OfferLab keeps its row and its
// link fails visibly, which is the ticket's stated behavior.
async function fillPublishedLinks(searchedDomain) {
  if (!offerlab.isEnabled() || !offerlab.isConnected()) return;

  for (const draft of pitch.drafts.filter(entry => !entry.publishedUrl)) {
    try {
      const url = await offerlab.publishedUrlFor(draft.stackId);
      if (!url) continue;
      offerlab.rememberPublishedUrl(searchedDomain, draft.stackId, url);
      // The "View the live page" link renders off this field.
      draft.publishedUrl = url;
    } catch (err) {
      console.warn(`[Pitch] Could not check whether stack ${draft.stackId} is published:`, err.message);
    }
  }
}

export async function openPitchModal(brand, { skipUrlUpdate = false } = {}) {
  const searchedBrand = getResults()?.searchedBrand || null;
  pitch.brand = brand;
  pitch.searchedBrand = searchedBrand;
  pitch.brand1 = searchedBrand?.name || 'Unknown Brand';
  pitch.brand2 = brand.name || 'Unknown Brand';
  // The skeleton from the first frame: generation starts as soon as the drafts are in, and the
  // finder never showed a "Generate" step before it.
  pitch.stage = 'loading';
  pitch.toolbar = 'hidden';

  const bundlesBuilt = loadBundlesBuilt(extractDomain(searchedBrand?.url || ''), extractDomain(brand.url || ''));

  pitch.closing = false;
  pitch.open = true;
  document.body.style.overflow = 'hidden';

  if (!skipUrlUpdate) {
    pushUrl(url => url.searchParams.set(PITCH_PARAM, brand.name));
  }

  // The pitch prompt names the bundles already built for this pair, so they are in before it runs.
  await bundlesBuilt;

  const cached = pitchCache.get(cacheKey());
  if (cached) {
    pitch.result = cached;
    pitch.stage = 'results';
    return;
  }
  triggerPitchGeneration();
}

// Starts the exit animation; PitchModal.svelte calls finishClose when it ends.
function beginClose() {
  if (!pitch.open || pitch.closing) return false;
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  pitch.generating = false;
  pitch.closing = true;
  return true;
}

export function closePitchModal() {
  if (!beginClose()) return;
  if (currentUrl().searchParams.has(PITCH_PARAM)) {
    pushUrl(url => url.searchParams.delete(PITCH_PARAM));
  }
}

/** The popstate branch: the pitch param is already gone, so the URL is left alone. */
export function closePitchModalSilently() {
  beginClose();
}

/** Called by the modal once its closing animation has ended. */
export function finishClose() {
  if (!pitch.closing) return;
  pitch.open = false;
  pitch.closing = false;
  document.body.style.overflow = '';
  pitch.brand = null;
  pitch.brand1 = null;
  pitch.brand2 = null;
}

/** Reopens the pitch named by ?pitch= once the search's brands are on screen. */
export function restorePitchFromUrl() {
  const pitchBrandName = getPitchFromUrl();
  const brands = getResults()?.brands;
  if (!pitchBrandName || !brands) return;

  const match = brands.find(b => b.name && b.name.toLowerCase() === pitchBrandName.toLowerCase());
  if (match) {
    openPitchModal(match, { skipUrlUpdate: true });
  } else {
    console.warn(`[PitchModal] Brand "${pitchBrandName}" not found in current results — ignoring pitch param`);
    replaceUrl(url => url.searchParams.delete(PITCH_PARAM));
  }
}

export function cancelPitchGeneration() {
  pitch.generating = false;
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  pitch.toolbar = 'regenerate';
  pitch.error = 'Generation cancelled.';
  pitch.stage = 'error';
}

export async function triggerPitchGeneration() {
  if (!pitch.brand1 || !pitch.brand2) return;

  if (abortController) abortController.abort();
  abortController = new AbortController();
  pitch.generating = true;
  pitch.toolbar = 'generating';
  pitch.stage = 'loading';

  const context = {
    searchedBrand: pitch.searchedBrand,
    recommendedBrand: pitch.brand,
    bundlesBuilt: pitch.drafts
  };

  try {
    const result = await generatePitchContent(
      pitch.brand1, pitch.brand2, pitch.model, context,
      { signal: abortController.signal }
    );

    // Aborted between the await and here.
    if (!pitch.generating) return;

    pitch.generating = false;
    abortController = null;
    pitchCache.set(cacheKey(), result);
    pitch.toolbar = 'regenerate';
    pitch.result = result;
    pitch.stage = 'results';
  } catch (err) {
    // cancelPitchGeneration already handled the UI.
    if (err.name === 'AbortError') return;
    console.error('[Pitch] Generation failed:', err);
    pitch.generating = false;
    abortController = null;
    pitch.toolbar = 'regenerate';
    pitch.error = err.message || 'An unexpected error occurred. Please try again.';
    pitch.stage = 'error';
  }
}

/** The toolbar button: stop while generating, otherwise regenerate. */
export function onToolbarClick() {
  if (pitch.generating) cancelPitchGeneration();
  else triggerPitchGeneration();
}
