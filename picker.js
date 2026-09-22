/**
 * Bundle picker: one catalog column per brand (the searched brand first, then partners),
 * multi-select across them, and Gemini bundle concepts. Tiles and the floating selection
 * tray follow the main app's collab-builder catalog picker (OL-3571).
 */
import {
  elements, CONFIG, getResults, extractDomain, getFaviconUrl, escapeHtml,
  parseJsonResponse, extractText, fetchCatalog, catalogThumbUrl, showSection
} from './app.js';
import { icon } from './icons.js';
import * as offerlab from './offerlab.js';
import { looksLikeDomain, resolveBrand } from './resolve.js';

const PICK_PARAM = 'pick';
const CONCEPT_MODEL = 'gemini-2.5-flash';
const CONCEPT_COUNT = 4;
const MAX_PRODUCTS_IN_PROMPT = 60;
const MAX_PICKS_PER_BRAND = 3;
// Naming the angles, and quoting a quota against them, is what stops every concept landing on
// the same safe pairing. Ported from the brand recommendation prompt, which works the same way.
const CONCEPT_ANGLES = {
  'same-ritual': 'used together in one sitting or one routine',
  'starter-kit': 'everything someone needs to attempt a thing for the first time',
  'upgrade': 'a staple plus the thing that makes it noticeably better',
  'gift-ready': 'reads as a present with no explanation needed',
  'subculture': 'speaks to one specific identity, hobby, or community',
  'trend-jack': 'hooks a cultural moment or something running on social right now',
  'odd-couple': 'makes no sense on paper, then total sense once you picture it'
};
const OBVIOUS_ANGLES = ['same-ritual', 'starter-kit', 'upgrade'];
const UNEXPECTED_ANGLES = ['subculture', 'trend-jack', 'odd-couple'];
const CONCEPT_THUMBS = 4;
const TRAY_THUMBS = 3;
// A thumb's tilt is fixed by its selection sequence, so the pile never rearranges itself.
const THUMB_TILTS = [{ rotate: 10, shift: 2 }, { rotate: -10, shift: -2 }, { rotate: 0, shift: 0 }];
// A concept's thumbs overlap into a pile; the tilt alternates by position so the row reads as
// shuffled rather than fanned in one direction.
const THUMB_PILE_TILTS = [-6, 4, -3, 5];

const state = {
  brands: [],             // [{ domain, brand }], the searched brand first
  selection: new Map(),   // "domain:id" -> { domain, product, sequence }
  draft: { status: 'idle', message: '', url: null },
  sequence: 0,
  concepts: [],           // [{ name, hook, why, picks: [{ domain, product }], discountPercent, edited }]
  activeConcept: -1,
  conceptsStatus: 'idle', // idle | loading | ready | error
  conceptsError: null,
  conceptsSummary: '',
  conceptsMinimized: false,
  stackSignature: '',   // the image set the fan last played for
  copy: null,             // { headline, subtitle } written for this brand set
  copyKey: null,          // the brand set that copy belongs to
  copyAbort: null,
  swapDomain: null,       // the column the popover is replacing, when it was opened from one
  filters: {},            // domain -> text
  abort: null
};

const dom = {};

export function initPicker() {
  dom.section = document.getElementById('pickerSection');
  if (!dom.section) return;
  // Before anything reads the query string: a sign-in redirect left its own parameters there and
  // this puts the finder's back. Not awaited — the token exchange only has to beat the next click.
  offerlab.completeRedirect()
    .catch(err => { console.warn('[OfferLab] sign-in did not complete:', err); })
    .finally(refreshAccount);
  dom.accountWrap = document.getElementById('offerlabAccountWrap');
  dom.account = document.getElementById('offerlabAccount');
  dom.accountTeam = document.getElementById('offerlabAccountTeam');
  dom.accountBadge = document.getElementById('offerlabAccountBadge');
  dom.accountCaret = document.getElementById('offerlabAccountCaret');
  dom.accountMenu = document.getElementById('offerlabAccountMenu');
  dom.accountMeta = document.getElementById('offerlabAccountMeta');
  initAccountControl();
  dom.concepts = document.getElementById('pickerConcepts');
  dom.conceptsShell = document.getElementById('pickerConceptsShell');
  dom.rail = document.getElementById('pickerRail');
  dom.columns = document.getElementById('pickerColumns');
  dom.tray = document.getElementById('pickerTray');
  dom.popover = document.getElementById('pickerAddPopover');
  dom.dialog = document.getElementById('pickerUrlDialog');
  // The app container carries a perspective for the tile tilt, which would make these fixed
  // layers position against it instead of the viewport. They live on body, like the social popover.
  document.body.append(dom.tray, dom.dialog);

  dom.section.addEventListener('click', onSectionClick);
  dom.tray.addEventListener('click', onSectionClick);
  dom.section.addEventListener('input', onSectionInput);
  dom.columns.addEventListener('keydown', onRailKeydown);
  dom.columns.addEventListener('scroll', updateRailControls, { passive: true });
  // Delegated, since the columns are re-rendered whole on every catalog change.
  dom.columns.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.picker-column-resizer');
    if (handle) startColumnResize(handle, e);
  });
  dom.columns.addEventListener('pointerover', (e) => {
    const handle = e.target.closest('.picker-column-resizer');
    if (handle) armResizer(handle);
  });
  dom.columns.addEventListener('pointerout', (e) => {
    const handle = e.target.closest('.picker-column-resizer');
    if (handle) disarmResizer(handle);
  });
  window.addEventListener('resize', () => {
    updateRailControls();
    // The minimise control is hidden below this width, so a chip carried in from a wider
    // viewport would have no way back. Expand it rather than stranding the user.
    if (state.conceptsMinimized && window.matchMedia('(max-width: 900px)').matches) {
      state.conceptsMinimized = false;
      dom.conceptsShell.classList.remove('is-chip');
      renderConcepts();
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#pickerAddPopover') && !e.target.closest('[data-action="add-brand"]')) hideAddPopover();
  });
  dom.dialog.addEventListener('submit', onUrlSubmit);
  dom.dialog.addEventListener('click', (e) => {
    if (e.target === dom.dialog || e.target.closest('[data-action="close-dialog"]')) hideUrlDialog();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideAddPopover(); hideUrlDialog(); }
  });
}

export function canBuildWith(brand) {
  return (brand?.catalog?.products?.length || 0) > 0;
}

export function isPickerOpen() {
  return !!dom.section && !dom.section.classList.contains('hidden');
}

export function openPicker(partner, { skipUrlUpdate = false } = {}) {
  return openPickerWith([partner], { skipUrlUpdate });
}

/**
 * The first column presents the bundle. That is the searched brand when it has a public catalog;
 * when it has none (a headless storefront, no products.json) the partner clicked leads instead,
 * and the searched brand is simply not on the rail, so a build never dead-ends on it.
 */
async function openPickerWith(partners, { skipUrlUpdate = false } = {}) {
  const seller = getResults()?.searchedBrand;
  const lead = seller && canBuildWith(seller) ? [seller] : [];
  const usable = partners.filter(canBuildWith);
  if (usable.length === 0) return false;

  resetState();
  state.brands = [...lead, ...usable].map(brand => ({ domain: extractDomain(brand.url || ''), brand }));
  if (!skipUrlUpdate) pushPickUrl();

  renderAll();
  playCardReveal();
  refreshConceptsCopy();
  showSection('picker');
  window.scrollTo({ top: 0 });

  // Cached catalogs are trimmed for localStorage; the picker wants the whole thing.
  await Promise.all(state.brands.map(entry => ensureFullCatalog(entry.brand).then(() => renderColumn(entry.domain))));
  return true;
}

export function closePicker() {
  if (state.abort) state.abort.abort();
  const url = new URL(window.location.href);
  if (url.searchParams.has(PICK_PARAM)) {
    url.searchParams.delete(PICK_PARAM);
    history.pushState(null, '', url.toString());
  }
  hideAddPopover();
  hideUrlDialog();
  resetState();
  renderTray();
  showSection('results');
}

// Browser back/forward: the URL is the source of truth for whether the picker is open.
export function syncPickerWithUrl() {
  const param = new URLSearchParams(window.location.search).get(PICK_PARAM);
  if (!param && isPickerOpen()) {
    resetState();
    renderTray();
    showSection('results');
  } else if (param && !isPickerOpen()) {
    restorePickerFromUrl();
  }
}

// After results render, reopen the picker with the partners named in the URL.
export function restorePickerFromUrl() {
  const param = new URLSearchParams(window.location.search).get(PICK_PARAM);
  const brands = getResults()?.brands;
  if (!param || !brands) return;
  const wanted = param.split(',').filter(Boolean);
  const matches = wanted.map(domain => brands.find(b => extractDomain(b.url || '') === domain)).filter(canBuildWith);
  if (matches.length) {
    openPickerWith(matches, { skipUrlUpdate: true });
  } else {
    const url = new URL(window.location.href);
    url.searchParams.delete(PICK_PARAM);
    history.replaceState(null, '', url.toString());
  }
}

// Every brand on the rail but the searched one, which the search itself names; when a partner
// leads instead, it is in here too, so the rail comes back the same from the URL.
function pushPickUrl() {
  const searched = extractDomain(getResults()?.searchedBrand?.url || '');
  const url = new URL(window.location.href);
  url.searchParams.set(PICK_PARAM, state.brands.filter(e => e.domain !== searched).map(e => e.domain).join(','));
  history.pushState(null, '', url.toString());
}

function resetState() {
  if (state.abort) state.abort.abort();
  state.brands = [];
  state.selection = new Map();
  state.sequence = 0;
  state.concepts = [];
  state.conceptsSummary = '';
  state.activeConcept = -1;
  state.conceptsStatus = 'idle';
  state.conceptsError = null;
  state.filters = {};
  state.abort = null;
  if (state.copyAbort) state.copyAbort.abort();
  state.swapDomain = null;
  state.copy = null;
  state.copyKey = null;
  state.copyAbort = null;
}

async function ensureFullCatalog(brand) {
  const catalog = brand.catalog;
  if (catalog.status !== 'shopify') return;
  if (!catalog.truncated && catalog.products.length >= catalog.count) return;
  const fresh = await fetchCatalog(extractDomain(brand.url || ''));
  if (fresh.status === 'shopify' && fresh.products.length) brand.catalog = fresh;
}

/* ---------------------------------------------------------------------------
   Brands (columns)
   --------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
   Column resizing (ported from the app's builder preview panel)
   --------------------------------------------------------------------------- */

// Hover intent, so a cursor crossing the gutter does not flash the handle.
const RESIZER_ARM_DELAY = 100;
const RESIZE_STEP = 16;
const RESIZE_STEP_LARGE = 64;
let armTimer = null;

function armResizer(handle) {
  clearTimeout(armTimer);
  armTimer = setTimeout(() => { handle.dataset.armed = ''; }, RESIZER_ARM_DELAY);
}

function disarmResizer(handle) {
  clearTimeout(armTimer);
  delete handle.dataset.armed;
}

// Writes a preferred width, then reads back what clamp() allowed. Parking a far-out value would
// leave a dead zone before the drag bites on the way back.
function setColumnWidth(column, px) {
  column.dataset.resized = '';
  column.style.setProperty('--col-w', `${Math.round(px)}px`);
  column.style.setProperty('--col-w', `${Math.round(column.getBoundingClientRect().width)}px`);
}

function startColumnResize(handle, event) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const column = handle.closest('.picker-column');
  if (!column) return;
  event.preventDefault();

  const startX = event.clientX;
  const startWidth = column.getBoundingClientRect().width;
  handle.setPointerCapture?.(event.pointerId);
  dom.rail.setAttribute('data-resizing', '');

  const onMove = (e) => setColumnWidth(column, startWidth + (e.clientX - startX));
  const onUp = () => {
    dom.rail.removeAttribute('data-resizing');
    updateRailControls();
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

// Keyboard equivalent of the drag, for anyone not holding a pointer.
function resizeColumnByKey(handle, event) {
  const step = event.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP;
  const delta = { ArrowLeft: -step, ArrowRight: step }[event.key];
  if (delta === undefined) return;
  const column = handle.closest('.picker-column');
  if (!column) return;
  event.preventDefault();
  setColumnWidth(column, column.getBoundingClientRect().width + delta);
}

function entryFor(domain) {
  return state.brands.find(e => e.domain === domain) || null;
}

function sellerEntry() {
  return state.brands[0];
}

async function addBrand(brand) {
  const domain = extractDomain(brand.url || '');
  if (!domain || !canBuildWith(brand)) return;
  const existing = entryFor(domain);
  if (existing) {
    scrollToColumn(domain);
    return;
  }
  state.brands.push({ domain, brand });
  pushPickUrl();
  renderConcepts({ reveal: true, swap: true });
  refreshConceptsCopy();
  renderColumns();
  // The new column arrives past the right edge once there are more than two, so page to it.
  scrollToColumn(domain);
  await ensureFullCatalog(brand);
  renderColumn(domain);
}

// Swaps one column's brand for another, keeping its position on the rail. The old brand's
// picks go with it; the rest of the selection stands.
async function replaceBrand(domain, brand) {
  const entry = entryFor(domain);
  const nextDomain = extractDomain(brand.url || '');
  if (!entry || !nextDomain || !canBuildWith(brand) || nextDomain === domain) return;
  if (entryFor(nextDomain)) {
    scrollToColumn(nextDomain);
    return;
  }

  [...state.selection.keys()].filter(key => key.startsWith(`${domain}:`)).forEach(key => state.selection.delete(key));
  entry.domain = nextDomain;
  entry.brand = brand;
  // The concepts referenced the old catalog, so they start over.
  state.concepts = [];
  state.conceptsSummary = '';
  state.activeConcept = -1;
  state.conceptsStatus = 'idle';

  pushPickUrl();
  renderConcepts({ reveal: true, swap: true });
  refreshConceptsCopy();
  renderColumns();
  renderTray();
  scrollToColumn(nextDomain);
  await ensureFullCatalog(brand);
  renderColumn(nextDomain);
}

function removeBrand(domain) {
  if (domain === sellerEntry()?.domain) return;
  state.brands = state.brands.filter(e => e.domain !== domain);
  [...state.selection.keys()].filter(key => key.startsWith(`${domain}:`)).forEach(key => state.selection.delete(key));
  // Concepts referenced that catalog; start those over.
  state.concepts = [];
  state.conceptsSummary = '';
  state.activeConcept = -1;
  state.conceptsStatus = 'idle';
  pushPickUrl();
  renderAll();
  refreshConceptsCopy();
}

// Brands from the results list that can be added: buildable and not already a column.
function addableBrands() {
  const taken = new Set(state.brands.map(e => e.domain));
  return (getResults()?.brands || []).filter(b => canBuildWith(b) && !taken.has(extractDomain(b.url || '')));
}

/* ---------------------------------------------------------------------------
   Selection
   --------------------------------------------------------------------------- */

function productKey(domain, id) {
  return `${domain}:${id}`;
}

function findProduct(domain, id) {
  return entryFor(domain)?.brand.catalog?.products?.find(p => String(p.id) === String(id)) || null;
}

function toggleProduct(domain, id) {
  const key = productKey(domain, id);
  if (state.selection.has(key)) {
    state.selection.delete(key);
  } else {
    const product = findProduct(domain, id);
    if (!product) return;
    state.selection.set(key, { domain, product, sequence: state.sequence++ });
  }
  if (state.activeConcept >= 0) syncActiveConceptToSelection();
  renderSelectionState();
}

function selectedFor(domain) {
  return [...state.selection.values()].filter(s => s.domain === domain).map(s => s.product);
}

function clearSelection() {
  state.selection = new Map();
  state.activeConcept = -1;
  renderSelectionState();
}

/* ---------------------------------------------------------------------------
   The card's copy: written for whichever brands are on the rail, refreshed when that changes
   --------------------------------------------------------------------------- */

function brandSetKey() {
  return state.brands.map(e => e.domain).join(',');
}

function brandNames() {
  return state.brands.map(e => e.brand.name);
}

// Shown until the model answers, and whenever it cannot. Names the brands and says what happens.
function fallbackCopy() {
  const names = brandNames();
  return {
    headline: `${names.join(' x ')}, bundled`,
    subtitle: names.length > 1 ? 'AI picks the pairs. You pick the winner.' : 'Add a partner brand to pair with.'
  };
}

function buildCopyPrompt() {
  const brands = state.brands.map(e => {
    const b = e.brand;
    return `${b.name} (${e.domain})${b.description ? `: ${b.description}` : ''}`;
  }).join('\n');

  return `Write the headline and subtitle for a card that offers to invent co-branded product bundles from these brands' catalogs. It sits on a screen at a trade show booth, where a merchant is looking at their own brand next to possible partners.

Brands, the first being the one the bundles would be sold by:
${brands}

Headline: 7 words or fewer. Start with a capital letter and use ordinary sentence capitalization, not Title Case. It has to make clear this is about BUNDLING these brands' products together, and must contain one of these exact words: bundle, bundled, bundles, pair, paired, pairing, box, kit, or set. Playful and specific to THESE brands: what they sell, who buys it, what the pairing would feel like on a shelf or a table. Never use a colon, and never the pattern "Brand and Brand: something". Do not reuse a slogan either brand already has.
Subtitle: 8 words or fewer, starting with a capital letter. An instruction for what pressing the button does, in the same voice.

When you name more than one brand together, join them with " x " (a lowercase x with a space each side), never "and", "+", or "&".

No em dashes, no exclamation marks, no ampersands, no colons. Return JSON only: {"headline": "...", "subtitle": "..."}`;
}

// The model drifts on the same details however the prompt is worded: it lowercases the whole
// line, reaches for a colon or an exclamation mark, and drops the x between brand names. Fixed
// here rather than re-asked.
function tidyCopy(value) {
  let text = String(value || '').trim()
    // A colon becomes a comma, and the clause after it drops back to lowercase — the model
    // capitalises it as the start of its own sentence.
    .replace(/\s*:\s*(\w)/g, (_, c) => `, ${c.toLowerCase()}`)
    .replace(/\s*:\s*/g, ', ')
    .replace(/!+/g, '')
    .replace(/\s*&\s*|\s+\+\s+/g, ' x ');

  // "Graza and Fishwife" / "Graza Fishwife" -> "Graza x Fishwife", for the brands on the rail.
  const names = brandNames().map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  for (const a of names) {
    for (const b of names) {
      if (a === b) continue;
      text = text.replace(new RegExp(`\\b${a}\\s+(?:and\\s+)?${b}\\b`, 'gi'), `${a.replace(/\\(.)/g, '$1')} x ${b.replace(/\\(.)/g, '$1')}`);
    }
  }

  text = text.trim().replace(/\s{2,}/g, ' ');
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

// The head's supporting line is a sentence, so it keeps tidyCopy's brand "x" and punctuation
// rules but has to close on a full stop.
function tidySummary(value) {
  const text = tidyCopy(value);
  if (!text) return '';
  return /[.?]$/.test(text) ? text : `${text}.`;
}

async function refreshConceptsCopy() {
  const key = brandSetKey();
  if (!key || state.copyKey === key) return;
  if (state.copyAbort) state.copyAbort.abort();
  state.copyKey = key;
  // One brand has nothing to pair with yet; asked anyway, the model invents a partner.
  if (state.brands.length < 2) {
    state.copy = null;
    renderConcepts();
    return;
  }
  state.copyAbort = new AbortController();

  try {
    const response = await fetch(`${CONFIG.GEMINI_PROXY}?model=${encodeURIComponent(CONCEPT_MODEL)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: state.copyAbort.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'You write short, playful product copy for OfferLab. Return only valid JSON.' }] },
        contents: [{ role: 'user', parts: [{ text: buildCopyPrompt() }] }],
        // thinkingBudget 0: a short prompt like this spent its whole token budget on thoughts and
        // returned MAX_TOKENS before writing any JSON.
        generationConfig: { temperature: 0.9, topP: 0.95, maxOutputTokens: 512, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } }
      })
    });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    const parsed = parseJsonResponse(extractText(await response.json()));
    if (!parsed?.headline) throw new Error('No copy returned');
    // A late answer for a brand set that has since changed is dropped.
    if (state.copyKey !== key) return;
    state.copy = { headline: tidyCopy(parsed.headline), subtitle: tidyCopy(parsed.subtitle) };
    renderConcepts();
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.warn('[Picker] Concept copy failed:', err.message);
  } finally {
    state.copyAbort = null;
  }
}

/* ---------------------------------------------------------------------------
   Concepts
   --------------------------------------------------------------------------- */

function conceptSeparatePrice(concept) {
  return concept.picks.reduce((sum, p) => sum + (p.product.price || 0), 0);
}

function conceptBundlePrice(concept) {
  return Math.round(conceptSeparatePrice(concept) * (1 - concept.discountPercent / 100) * 100) / 100;
}

function applyConcept(index) {
  const concept = state.concepts[index];
  if (!concept) return;
  state.selection = new Map();
  concept.picks.forEach(({ domain, product }) => {
    state.selection.set(productKey(domain, product.id), { domain, product, sequence: state.sequence++ });
  });
  state.activeConcept = index;
  renderSelectionState();
}

/* ---------------------------------------------------------------------------
   Handing a bundle to OfferLab
   --------------------------------------------------------------------------- */

/**
 * Which OfferLab this is talking to, and whether the account may create anything. Shown because
 * an operator about to publish a brand's bundle should be able to see, without clicking, which
 * team it is going into.
 */
// Signed out the chip signs in; signed in it opens its menu. One control, two jobs, because the
// header has room for one thing and both are about the same connection.
function initAccountControl() {
  if (!dom.account) return;

  dom.account.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!offerlab.isConnected()) { connectOfferLab(); return; }
    toggleAccountMenu();
  });

  dom.accountMenu?.addEventListener('click', (e) => {
    const item = e.target.closest('[data-action]');
    if (!item) return;
    closeAccountMenu();
    if (item.dataset.action === 'offerlab-signout') {
      offerlab.disconnect();
      refreshAccount();
    } else if (item.dataset.action === 'offerlab-switch') {
      switchAccount();
    }
  });

  document.addEventListener('click', closeAccountMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAccountMenu(); });
}

function toggleAccountMenu() {
  const open = dom.accountMenu.classList.toggle('hidden');
  dom.account.setAttribute('aria-expanded', String(!open));
}

function closeAccountMenu() {
  dom.accountMenu?.classList.add('hidden');
  dom.account?.setAttribute('aria-expanded', 'false');
}

/**
 * Re-running OAuth would hand back the same account: the authorize step reuses the session on
 * OfferLab's side and the server has no prompt handling to override that. So signing out there is
 * a separate step, in its own tab, and the operator comes back and signs in again.
 */
async function switchAccount() {
  offerlab.disconnect();
  refreshAccount();
  window.open(`${await offerlab.host()}/users/sign_out`, '_blank', 'noopener');
  setDraft('pending', 'Sign out of OfferLab in the new tab, then sign in again here');
}

async function refreshAccount() {
  const wrap = dom.accountWrap;
  if (!wrap) return;
  closeAccountMenu();

  if (!offerlab.isEnabled()) {
    wrap.classList.add('hidden');
    renderTray();
    return;
  }

  wrap.classList.remove('hidden');

  // Signed out, this is the way in. Connecting used to be reachable only from the tray, which
  // means only after searching, opening a picker and selecting something.
  if (!offerlab.isConnected()) {
    dom.account.classList.add('is-disconnected');
    dom.account.classList.remove('is-limited');
    dom.accountBadge.innerHTML = icon('passkeys', { size: 18 });
    dom.accountCaret.innerHTML = '';
    dom.accountTeam.textContent = 'Sign in';
    dom.account.title = 'Sign in to OfferLab to create bundles from here';
    dom.account.setAttribute('aria-label', 'Sign in to OfferLab');
    renderTray();
    return;
  }

  dom.account.classList.remove('is-disconnected');
  dom.accountCaret.innerHTML = icon('chevron-bottom', { size: 12 });
  dom.account.setAttribute('aria-label', 'OfferLab account');
  dom.account.title = '';
  try {
    const { account } = await offerlab.loadAccount();
    const team = account?.team || 'OfferLab';
    dom.accountTeam.textContent = team;
    // Standing in for the team's avatar, which list_teams does not return yet (OL-3997).
    dom.accountBadge.textContent = team.trim().charAt(0).toUpperCase();
    dom.account.classList.toggle('is-limited', account?.developer === false);
    dom.accountMeta.hidden = account?.developer !== false;
    dom.accountMeta.textContent = 'No developer access, so bundles cannot be created';
  } catch (err) {
    console.warn('[OfferLab] could not read the account:', err.message);
  }
  renderTray();
}

// The brands in the order they were first picked, which is what the draft is named after.
function draftName() {
  const seen = [];
  [...state.selection.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .forEach(pick => { if (!seen.includes(pick.domain)) seen.push(pick.domain); });
  return seen.map(domain => entryFor(domain)?.brand.name || domain).join(' \u00d7 ');
}

function setDraft(status, message, url = null) {
  state.draft = { status, message, url };
  renderTray();
}

async function connectOfferLab() {
  try {
    await offerlab.connect();
  } catch (err) {
    console.warn('[OfferLab] could not start sign-in:', err);
    setDraft('error', err.message || 'Could not reach OfferLab');
  }
}

/**
 * Turns the current selection into a draft collab in OfferLab and opens the builder on it.
 * Signing in comes first when there is no session; the operator lands back here and clicks again.
 */
async function createDraft(name) {
  if (state.draft.status === 'working') return;

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

  const picks = [...state.selection.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .map(pick => ({ domain: pick.domain, brandName: entryFor(pick.domain)?.brand.name, product: pick.product }));
  if (!picks.length) return;

  setDraft('working', 'Connecting to OfferLab');
  try {
    const draft = await offerlab.createDraftBundle({
      name: name || draftName(),
      picks,
      // The bundle presents as whichever brand leads it, and it is being pitched to the one that
      // was searched for, so that is the brand whose products go first.
      presentingDomain: sellerEntry()?.domain,
      onProgress: message => setDraft('working', message)
    });
    offerlab.rememberDraft(sellerEntry()?.domain, draft);
    setDraft('done', draft.name, draft.url);
    // A draft nobody looks at is not a handoff. Opened here, off the click that started it.
    window.open(draft.url, '_blank', 'noopener');
  } catch (err) {
    console.warn('[OfferLab] draft failed:', err);
    setDraft('error', err.message || 'Could not create the draft');
  }
}

function syncActiveConceptToSelection() {
  const concept = state.concepts[state.activeConcept];
  if (!concept) return;
  concept.picks = [...state.selection.values()].map(s => ({ domain: s.domain, product: s.product }));
  concept.edited = true;
}

// Trade-only and non-physical listings make bad bundle members and crowd out the catalog the
// model actually gets to see, so they never reach the prompt.
const PROMPT_EXCLUDE_TITLE = /wholesale|case of \d|gift card|subscription|\bsample\b/i;

function promptProducts(brand) {
  return (brand.catalog?.products || [])
    .filter(p => p.available)
    .filter(p => !(p.tags || []).some(t => /^hidden$/i.test(t)))
    .filter(p => !PROMPT_EXCLUDE_TITLE.test(p.title))
    .slice(0, MAX_PRODUCTS_IN_PROMPT);
}

function promptCatalog(entry, prefix, handles) {
  return promptProducts(entry.brand).map((p, i) => {
    const handle = `${prefix}${i + 1}`;
    handles.set(handle, { domain: entry.domain, product: p });
    const price = p.price === null || p.price === undefined ? 'price n/a' : `$${p.price}`;
    const type = p.productType ? ` | ${p.productType}` : '';
    const about = p.description ? ` | ${p.description}` : '';
    return `${handle} | ${p.title} | ${price}${type}${about}`;
  }).join('\n');
}

function promptProfile(brand) {
  const lines = [`Name: ${brand.name}`, `Site: ${brand.url || ''}`];
  if (brand.description) lines.push(`About: ${brand.description}`);
  if (brand.reason) lines.push(`Why they pair: ${brand.reason}`);
  if (brand.brandDNA) lines.push(`Brand DNA: ${JSON.stringify(brand.brandDNA)}`);
  if (brand.targetCustomer) lines.push(`Customer: ${JSON.stringify(brand.targetCustomer)}`);
  return lines.join('\n');
}

function buildConceptPrompt() {
  const handles = new Map();
  const seller = sellerEntry();
  const partners = state.brands.slice(1);
  const partnerNames = partners.map(e => e.brand.name).join(' x ');
  const sections = state.brands.map((entry, i) => {
    const prefix = i === 0 ? 'S' : String.fromCharCode(64 + i);
    const role = i === 0 ? 'SELLER' : `PARTNER ${i}`;
    return `=== ${role}: ${entry.brand.name} (handles ${prefix}1, ${prefix}2, ...) ===\n${promptProfile(entry.brand)}\n\n--- catalog (handle | title | price | type | what it is) ---\n${promptCatalog(entry, prefix, handles)}`;
  }).join('\n\n');

  const angleList = Object.entries(CONCEPT_ANGLES)
    .map(([key, note]) => `- "${key}": ${note}`).join('\n');

  const text = `You are a world-class bundle merchandiser, part trend forecaster, part stylist, part cultural observer.

Your mission: design bundles for ${seller.brand.name} x ${partnerNames} that a shopper would screenshot and send to a friend.

A good bundle feels obvious in retrospect; a bad one feels forced. The genuinely obvious pairing is table stakes, since anyone can see the oil goes with the pan. The bundles that win are the ones nobody had thought to put in the same box, where the products together aim at a specific life, a specific week, a specific room, and the logic lands the moment you picture it.

${sections}

=== BUNDLE ANGLES ===

Classify every bundle with exactly one angle:
${angleList}

=== DIVERSITY REQUIREMENTS ===

Your ${CONCEPT_COUNT} bundles MUST include:
- Exactly ONE obvious bundle, from ${OBVIOUS_ANGLES.map(a => `"${a}"`).join(' or ')}. One. Not two.
- At least TWO from ${UNEXPECTED_ANGLES.map(a => `"${a}"`).join(' or ')}. These are the point of the exercise.
- No two bundles sharing an angle.
- No product in more than one bundle.
- A spread of price, from something bought on impulse to something considered.

What divergence actually looks like: given an olive oil brand and a cookware brand, the obvious
bundle is oil plus pan. An "odd-couple" bundle is the finishing oil plus the small dessert plates,
sold to the person whose entire personality is putting olive oil on ice cream because they saw it
on TikTok. Same catalogs, completely different thought. Aim there.

For the unexpected ones, reach for a real occasion or subculture: the first apartment, the hungover Sunday, the person who took up bread in January, the dinner party that is actually a performance, the gift for someone who already owns everything. Put that person or that moment in the hook, but vary how you get there. If more than one hook opens the same way, rewrite it.

=== ANTI-PATTERNS ===

DO NOT:
- Name a bundle after what is in it. Name the occasion, ritual, or feeling the products add up to. "Sunday Reset Bundle", never "Olive Oil and Candle Bundle".
- Lean on Kit, Set, Duo, or Essentials as the whole idea. Those words can close a name, but they cannot carry it.
- Use the words elevate, unlock, discover, transform, effortless, seamless, curated, or "everything you need", in any form. These are the words a model reaches for when it has nothing specific to say.
- Open more than one hook with the same two words. Four hooks that all start "For the ..." is one hook written four times, so at most one may use that shape.
- Describe a bundle by listing its categories, as in "olive oil and a pan". Say what it lets someone do.
- Pair the two most famous products from each brand. That bundle sells itself and teaches nobody anything.
- Use a handle that does not appear in the catalogs above.

=== VOICE ===

Real bundle names from this platform. Match this register:
  Brunch Club Box, Campfire Classics, Cold Brew Companion, Cozy Morning Ritual,
  Desk Setup Refresh, Late Night Snack Kit, Pantry Power Pack, Self-Care Sunday,
  Studio Warmup Pack, Sunday Reset Bundle, Trailhead Trio, The Coastal Pantry Pairing

- Bundle name: 4 words or fewer, Title Case, under 40 characters, no colons.
- Write "${seller.brand.name} x ${partners[0]?.brand.name || 'Partner'}", never "and".
- No exclamation marks, no em dashes.

=== COMPOSITION ===

- Every bundle needs at least one S handle and at least one partner handle.${partners.length > 1 ? `\n- Spread across partners so each of ${partnerNames} appears in at least one bundle, and combine partners when the products genuinely belong together.` : ''}
- 1 to ${MAX_PICKS_PER_BRAND} products from any one brand, 2 to 6 products total.
- discountPercent is the bundle discount versus buying separately, an integer from 10 to 25.

Return JSON only. Write each concept's fields in the order given: commit to the angle and the
person first, and choose products that serve them. Picking obvious products and labelling them
"odd-couple" afterwards is the failure mode here.
{
  "concepts": [
    {
      "angle": "one of the angle keys above",
      "occasion": "The specific person and moment, in under 12 words. Not 'the home cook'. Someone like 'the friend who hosts on a Tuesday for no reason'.",
      "name": "Bundle name, 4 words or fewer",
      "hook": "One customer-facing sentence. No two hooks in your response may open with the same two words.",
      "products": ["S1", "A3"],
      "why": "One sentence for the merchandiser on why these products belong together",
      "discountPercent": 15
    }
  ],
  "summary": "Written last, once the bundles above exist. ONE short sentence, 16 words or fewer, naming the thread running through them. Concrete and a little playful, the way you would say it out loud to a colleague: what kind of person, or what stretch of the year, this set is for. Open on the person or the moment, never on the list. Banned: collection, selection, curated, thoughtfully, seamlessly, diverse, elevate, essentials, offerings, targeting, culinary moments, and any opener of the shape 'This X brings together' or 'Here are'."
}`;

  return { text, handles };
}

async function generateConcepts() {
  if (state.brands.length < 2) return;
  if (state.abort) state.abort.abort();
  state.abort = new AbortController();
  state.conceptsStatus = 'loading';
  state.conceptsError = null;
  let revealOnRender = false;
  renderConcepts();
  renderTray();

  const prompt = buildConceptPrompt();

  try {
    const response = await fetch(`${CONFIG.GEMINI_PROXY}?model=${encodeURIComponent(CONCEPT_MODEL)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: state.abort.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'You are a merchandising strategist who designs co-branded product bundles for DTC brands. Return only valid JSON.' }] },
        contents: [{ role: 'user', parts: [{ text: prompt.text }] }],
        // Warmer than the app's other calls: the brief asks for unexpected pairings, and the
        // angle quota keeps that spread from turning into noise.
        generationConfig: { temperature: 0.95, topP: 0.95, maxOutputTokens: 4096, responseMimeType: 'application/json' }
      })
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${response.status})`);
    }
    const data = await response.json();
    const parsed = parseJsonResponse(extractText(data));
    const concepts = normalizeConcepts(parsed?.concepts, prompt.handles);
    if (concepts.length === 0) throw new Error('No usable bundles came back. Try again.');
    state.concepts = concepts;
    state.conceptsSummary = tidySummary(parsed?.summary);
    state.activeConcept = -1;
    state.conceptsStatus = 'ready';
    revealOnRender = true;
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[Picker] Concept generation failed:', err);
    state.conceptsStatus = 'error';
    state.conceptsError = err.message;
  } finally {
    state.abort = null;
  }
  renderConcepts({ reveal: revealOnRender });
  renderTray();
}

// Keeps only concepts whose handles resolve to real products, with the seller and at least one
// partner. A concept the model botched is dropped rather than failing the whole batch.
function normalizeConcepts(raw, handles) {
  if (!Array.isArray(raw)) return [];
  const seller = sellerEntry().domain;
  return raw.map(c => {
    const picks = [];
    const perBrand = new Map();
    for (const handle of Array.isArray(c.products) ? c.products : []) {
      const hit = handles.get(String(handle).trim().toUpperCase());
      if (!hit) continue;
      const count = perBrand.get(hit.domain) || 0;
      if (picks.some(p => p.product.id === hit.product.id) || count >= MAX_PICKS_PER_BRAND) continue;
      perBrand.set(hit.domain, count + 1);
      picks.push(hit);
    }
    if (!picks.some(p => p.domain === seller) || !picks.some(p => p.domain !== seller)) return null;
    const angle = String(c.angle || '').trim().toLowerCase();
    return {
      name: String(c.name || 'Untitled bundle').trim(),
      angle: CONCEPT_ANGLES[angle] ? angle : '',
      hook: String(c.hook || '').trim(),
      why: String(c.why || '').trim(),
      picks,
      discountPercent: Math.min(25, Math.max(10, parseInt(c.discountPercent, 10) || 15)),
      edited: false
    };
  }).filter(Boolean).slice(0, CONCEPT_COUNT + 1);
}

/* ---------------------------------------------------------------------------
   Rendering
   --------------------------------------------------------------------------- */

function money(value) {
  if (value === null || value === undefined) return '';
  return `$${Number(value).toFixed(2).replace(/\.00$/, '')}`;
}

function renderAll() {
  renderConcepts();
  renderColumns();
  renderTray();
}

function renderSelectionState() {
  if (state.draft.status !== 'working' && state.draft.status !== 'idle') state.draft = { status: 'idle', message: '', url: null };
  dom.columns.querySelectorAll('.picker-product').forEach(tile => {
    const selected = state.selection.has(tile.dataset.key);
    tile.classList.toggle('is-selected', selected);
    tile.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
  renderTray();
  renderConcepts();
}


// Product images for the fanned stack on the concepts card: round-robin across the brands,
// seller first, so a two-brand pair still fans five cards.
function stackImages() {
  const lists = state.brands.map(e => (e.brand.catalog?.products || []).map(p => p.image));
  const images = [];
  for (let i = 0; images.length < 5 && lists.some(l => l[i]); i++) {
    for (const list of lists) if (list[i] && images.length < 5) images.push(list[i]);
  }
  return images;
}

// Five slots fanning out from the front card: a mid pair just behind it, tilted outward, and a
// smaller far pair behind those. Painted back to front, so DOM order is far, mid, front.
// Slots for the fan, scaled to the shorter card. The far pair sits low enough that the midpoint
// of its bottom edge lands just above the mid pair's.
// Only the order and which pair is the outer one; the geometry itself lives in CSS as
// .picker-stack-card--s0..s3, so a narrow layout can retune it without fighting inline styles.
const STACK_SLOTS = [
  { far: true },  // far left
  { far: true },  // far right
  {},             // mid left
  {}              // mid right
];

function renderProductStack() {
  const images = stackImages();
  if (images.length === 0) return '';
  const card = (src, cls) => `<span class="picker-stack-card media-tile media-hairline${cls}"><img class="media-zoom" src="${src}" alt=""></span>`;
  // images[1..2] take the mid pair, images[3..4] the far pair; with fewer images the far slots go empty.
  const order = [3, 4, 1, 2];
  const behind = order.map((imageIndex, slotIndex) => {
    const src = images[imageIndex];
    if (!src) return '';
    // The outermost pair is what the narrow layout drops, so it is nameable in CSS.
    const far = STACK_SLOTS[slotIndex].far ? ' picker-stack-card--far' : '';
    return card(catalogThumbUrl(src, 240), ` picker-stack-card--s${slotIndex}${far}`);
  }).join('');
  return `<div class="picker-stack" aria-hidden="true">${behind}${card(catalogThumbUrl(images[0], 240), ' picker-stack-card--front')}</div>`;
}

function renderConcepts({ reveal = false, swap = false } = {}) {
  const { conceptsStatus } = state;
  const copy = state.copy || fallbackCopy();
  let body = '';
  let head = '';

  if (conceptsStatus === 'ready') {
    head = conceptsHead({
      title: `${state.concepts.length} ${state.concepts.length === 1 ? 'way' : 'ways'} to pair these`,
      subtitle: state.conceptsSummary || 'Four directions, one shared shopper.',
      action: `<button type="button" class="btn btn--md btn--ghost" data-action="suggest" aria-label="Regenerate bundle ideas">${icon('arrow-rotate-clockwise', { size: 14 })}<span class="picker-concepts-action-label">Regenerate</span></button>`
    });
    body = `<div class="picker-concepts-grid">${state.concepts.map(renderConceptCard).join('')}</div>`;
  } else if (conceptsStatus === 'loading') {
    head = conceptsHead({
      title: 'Rummaging through the shelves',
      titleClass: 'text-shimmer-ink',
      subtitle: '',
      action: `<button type="button" class="stop-button" data-action="cancel" aria-label="Stop generating">${icon('stop-filled', { class: 'stop-icon' })}</button>`
    });
    body = `<div class="picker-concepts-grid">${'<div class="picker-concept picker-concept--skeleton"></div>'.repeat(CONCEPT_COUNT)}</div>`;
  } else if (conceptsStatus === 'error') {
    head = conceptsHead({
      title: "That one didn't come together",
      subtitle: state.conceptsError || 'Something went wrong.',
      action: `<button type="button" class="btn btn--md btn--ai" data-action="suggest" aria-label="Try again">${icon('ai-sparkles-two-filled', { size: 16 })}<span class="picker-concepts-action-label">Try again</span></button>`
    });
  } else {
    head = conceptsHead({
      title: copy.headline,
      subtitle: copy.subtitle,
      action: `<button type="button" class="btn btn--md btn--ai" data-action="suggest" aria-label="Suggest bundles">${icon('ai-sparkles-two-filled', { size: 16 })}<span class="picker-concepts-action-label">Suggest bundles</span></button>`
    });
  }

  const morphing = dom.concepts.classList.contains('is-morphing') ? ' is-morphing' : '';

  if (state.conceptsMinimized) {
    dom.concepts.className = `picker-concepts picker-concepts--${conceptsStatus} is-minimized${morphing}`;
    dom.concepts.innerHTML = `<button type="button" class="picker-concepts-chip" data-action="toggle-minimize"
      aria-expanded="false" aria-label="Expand bundle ideas"><span class="picker-concepts-chip-label">Bundle ideas</span><span
      class="picker-concepts-chip-icon" aria-hidden="true">${icon('expand-45', { size: 14 })}</span></button>`;
    return;
  }

  dom.concepts.className = `picker-concepts picker-concepts--${conceptsStatus}${morphing}`;
  dom.concepts.innerHTML = `${head}${body ? `<div class="picker-concepts-body" id="pickerConceptsBody">${body}</div>` : ''}`;

  fanOutStack();
  if (reveal) {
    dom.concepts.querySelector('.picker-concepts-grid')?.classList.add('is-entering');
    playCardReveal();
  }
  if (swap) crossfadeCopy();
}

// The head's controls read as one elevated pill: whatever the current state offers, a hairline,
// then minimize. The buttons inside are ghosts so the pill is the only raised thing.
function conceptsActions(action) {
  const minimized = state.conceptsMinimized;
  return `
    <div class="picker-concepts-actions">
      ${action}
      ${action ? '<span class="picker-concepts-actions-divider" aria-hidden="true"></span>' : ''}
      <button type="button" class="btn btn--md btn--ghost btn--icon" data-action="toggle-minimize"
        aria-expanded="${!minimized}" aria-controls="pickerConceptsBody"
        aria-label="${minimized ? 'Expand bundle ideas' : 'Minimize bundle ideas'}"
        >${minimized ? icon('expand-45', { size: 16 }) : icon('minimize-45', { size: 16 })}</button>
    </div>`;
}

function conceptsHead({ title, subtitle, action, titleClass = '' }) {
  return `
    <div class="picker-concepts-head">
      ${renderProductStack()}
      <div class="picker-concepts-copy">
        <h3 class="picker-concepts-title${titleClass ? ` ${titleClass}` : ''}">${escapeHtml(title)}</h3>
        ${subtitle ? `<p class="picker-concepts-subtitle">${escapeHtml(subtitle)}</p>` : ''}
      </div>
      ${conceptsActions(action)}
    </div>`;
}

// The stack arrives collapsed under the front card and fans to its slots on the next frame.
// The fan is an entrance for a NEW set of images. Every product toggle re-renders this head, and
// replaying it there made the pile flutter on a change that has nothing to do with what it shows.
function fanOutStack() {
  const stack = dom.concepts.querySelector('.picker-stack');
  if (!stack) return;
  const signature = [...stack.querySelectorAll('img')].map(img => img.src).join('|');
  if (signature === state.stackSignature) return;
  state.stackSignature = signature;
  stack.classList.add('picker-stack--entering');
  requestAnimationFrame(() => requestAnimationFrame(() => stack.classList.remove('picker-stack--entering')));
}

function playCardReveal() {
  dom.conceptsShell.classList.remove('is-revealing');
  // Reflow so a repeat reveal restarts the animation rather than being ignored as a no-op.
  void dom.conceptsShell.offsetWidth;
  dom.conceptsShell.classList.add('is-revealing');
  setTimeout(() => dom.conceptsShell.classList.remove('is-revealing'), 1600);
}

// Chip and banner are one box. fit-content to 100% has nothing to interpolate, so both ends are
// pinned in pixels and released once the run finishes; a shrink-wrapped shell follows the pinned
// child, which is what keeps the glow tracking the box frame by frame.
const MORPH_MS = 420;

function toggleMinimize() {
  const card = dom.concepts;
  const shell = dom.conceptsShell;
  const next = !state.conceptsMinimized;

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    state.conceptsMinimized = next;
    shell.classList.toggle('is-chip', next);
    renderConcepts();
    return;
  }

  const fromW = card.offsetWidth;
  const fromH = card.offsetHeight;
  // A stadium's 999px only renders as one because the radius is clamped to half the box at paint.
  // Both ends have to be the CLAMPED pixel value or the run sits above the clamp, changing nothing
  // visible, and the corners appear to snap.
  const clampedRadius = (h) => Math.min(parseFloat(getComputedStyle(card).borderTopLeftRadius), h / 2);
  const fromRadius = clampedRadius(fromH);

  card.style.transition = 'none';
  card.style.width = '';
  card.style.height = '';
  state.conceptsMinimized = next;
  // Measure with the shell in its TARGET state: a shrink-wrapped shell would hand back the
  // banner's max-content width rather than the width it will actually settle at.
  shell.classList.toggle('is-chip', next);
  renderConcepts();
  const toW = card.offsetWidth;
  const toH = card.offsetHeight;

  // The content is laid out at its FINAL size and pinned there, which is what lets it be visible
  // through the run: the box travels around it and the headline never re-wraps. It grows in from
  // just under full size so it arrives with the box rather than after it.
  // Pin the content to its FINAL layout width for the run. That is the whole trick: the box can
  // travel around it without the headline re-wrapping, which is what let it stay visible at all.
  // The scale and fade are a keyframe (see .is-morphing > *), not a transition: these elements were
  // built a moment ago and have no previous computed style for a transition to interpolate from.
  const content = [...card.children];
  const pinned = content.map(el => el.getBoundingClientRect().width);
  content.forEach((el, i) => { el.style.width = `${pinned[i]}px`; });
  card.classList.add('is-morphing');
  // Shrink-wrapped for BOTH directions of the run so the glow tracks the pinned card; expanding
  // hands it back on release.
  shell.classList.add('is-chip');

  const toRadius = clampedRadius(toH);
  card.style.width = `${fromW}px`;
  card.style.height = `${fromH}px`;
  card.style.borderRadius = `${fromRadius}px`;
  void card.offsetHeight;
  card.style.transition = '';

  card.style.width = `${toW}px`;
  card.style.height = `${toH}px`;
  card.style.borderRadius = `${toRadius}px`;
  const release = (e) => {
    if (e.target !== card || e.propertyName !== 'height') return;
    card.style.width = '';
    card.style.height = '';
    card.style.borderRadius = '';
    content.forEach(el => { el.style.width = ''; });
    card.classList.remove('is-morphing');
    shell.classList.toggle('is-chip', next);
    card.removeEventListener('transitionend', release);
  };
  card.addEventListener('transitionend', release);
  // A run that never fires transitionend (an interrupted morph) still has to hand the box back.
  setTimeout(() => release({ target: card, propertyName: 'height' }), MORPH_MS + 120);
}

function crossfadeCopy() {
  dom.concepts.classList.add('is-swapping');
  requestAnimationFrame(() => requestAnimationFrame(() => dom.concepts.classList.remove('is-swapping')));
}

function renderConceptCard(concept, index) {
  const products = concept.picks.map(p => p.product);
  const bundle = conceptBundlePrice(concept);
  const thumbs = products.slice(0, CONCEPT_THUMBS).map((p, i) => `<span class="picker-concept-thumb media-tile media-hairline" style="--tilt: ${THUMB_PILE_TILTS[i % THUMB_PILE_TILTS.length]}deg; --i: ${index * CONCEPT_THUMBS + i}" title="${escapeHtml(p.title)}"><img class="media-zoom" src="${catalogThumbUrl(p.image, 200)}" alt=""></span>`).join('');
  const more = products.length > CONCEPT_THUMBS ? `<span class="picker-concept-more">+${products.length - CONCEPT_THUMBS}</span>` : '';
  const items = concept.picks.map(({ domain, product }) => {
    const brand = entryFor(domain)?.brand.name || domain;
    return `<li class="picker-concept-item">${escapeHtml(product.title)} <span class="picker-concept-item-brand">by ${escapeHtml(brand)}</span></li>`;
  }).join('');
  const active = index === state.activeConcept;
  return `
    <div class="picker-concept${active ? ' is-active' : ''}" role="button" tabindex="0" data-action="apply-concept" data-index="${index}">
      <div class="picker-concept-main">
        <div class="picker-concept-thumbs">${thumbs}${more}</div>
        <div class="picker-concept-name">${escapeHtml(concept.name)}${concept.edited ? ' <span class="picker-concept-edited">edited</span>' : ''}</div>
        <p class="picker-concept-hook">${escapeHtml(concept.hook)}</p>
        <div class="picker-concept-total">${money(bundle)}</div>
      </div>
      <div class="picker-concept-foot">
        <div class="picker-concept-includes">
          <div class="picker-concept-includes-label">Includes</div>
          <ul class="picker-concept-items">${items}</ul>
        </div>
        <button type="button" class="btn btn--md btn--ai picker-concept-create" data-action="create-concept" data-index="${index}">Create bundle</button>
      </div>
    </div>
  `;
}

function renderColumns() {
  dom.columns.innerHTML = state.brands.map(e => renderColumnMarkup(e.domain)).join('') + renderAddColumn();
  // The brand columns divide the content area between them; CSS needs the count to do the maths.
  dom.columns.style.setProperty('--brand-count', String(Math.max(state.brands.length, 1)));
  // One brand reads better in the reading column; past that the rail wants the whole viewport.
  dom.rail.classList.toggle('is-bleeding', state.brands.length > 1);
  updateRailControls();
}

function renderColumn(domain) {
  const existing = dom.columns.querySelector(`.picker-column[data-domain="${domain}"]`);
  if (!existing) return;
  existing.outerHTML = renderColumnMarkup(domain);
  updateRailControls();
}

function renderColumnMarkup(domain) {
  const entry = entryFor(domain);
  if (!entry) return '';
  const { brand } = entry;
  const catalog = brand.catalog;
  const isSeller = domain === sellerEntry().domain;
  const filter = (state.filters[domain] || '').trim().toLowerCase();
  const products = catalog.products.filter(p => !filter || p.title.toLowerCase().includes(filter));
  const loadingMore = catalog.status === 'shopify' && (catalog.truncated || catalog.products.length < catalog.count);
  const removable = !isSeller && state.brands.length > 2;

  return `
    <div class="picker-column" data-domain="${escapeHtml(domain)}">
      <div class="picker-column-top scrim">
      <div class="picker-column-head">
        <img class="picker-column-favicon" src="${getFaviconUrl(domain)}" alt="">
        <div class="picker-column-labels">
          <div class="picker-column-name">${escapeHtml(brand.name)}</div>
          <div class="picker-column-count">${catalog.count} products${loadingMore ? ' · loading the rest' : ''}</div>
        </div>
        <button type="button" class="picker-column-action has-tooltip" data-action="swap-brand" data-domain="${escapeHtml(domain)}" aria-label="Switch ${escapeHtml(brand.name)} for another brand" aria-haspopup="true">
          ${icon('arrow-rotate-right-left', { size: 16 })}
          <span class="tooltip tooltip--end" aria-hidden="true">Switch brand</span>
        </button>
        ${removable ? `<button type="button" class="picker-column-action" data-action="remove-brand" data-domain="${escapeHtml(domain)}" aria-label="Remove ${escapeHtml(brand.name)}">${icon('cross-large', { size: 16 })}</button>` : ''}
      </div>
      <div class="picker-column-filter">
        <input type="search" class="picker-filter" data-domain="${escapeHtml(domain)}" placeholder="Filter products" value="${escapeHtml(state.filters[domain] || '')}" aria-label="Filter ${escapeHtml(brand.name)} products">
      </div>
      </div>
      <div class="picker-grid">${products.map(p => renderTile(domain, p)).join('') || '<p class="picker-grid-empty">No products match.</p>'}</div>
      <div class="picker-column-resizer-zone">
        <button type="button" class="picker-column-resizer" data-action="resize-column" data-domain="${escapeHtml(domain)}"
          role="separator" aria-orientation="vertical" aria-label="Resize the ${escapeHtml(brand.name)} column"><span aria-hidden="true"></span></button>
      </div>
    </div>
  `;
}

// The catalog picker's flat tile: the artwork is the tile, and the add button is where selection
// is expressed (plus morphs to check). The whole tile toggles, since there is nothing to open.
function renderTile(domain, p) {
  const key = productKey(domain, p.id);
  const selected = state.selection.has(key);
  const price = p.price !== null && p.price !== undefined ? money(p.price) : 'Price varies';
  const img = `<img class="media-zoom" src="${catalogThumbUrl(p.image, 320)}" alt="" loading="lazy">`;
  return `
    <div class="picker-product${selected ? ' is-selected' : ''}" role="button" tabindex="0" aria-pressed="${selected}" data-action="toggle" data-domain="${escapeHtml(domain)}" data-id="${escapeHtml(String(p.id))}" data-key="${escapeHtml(key)}" title="${escapeHtml(p.title)}">
      <div class="picker-product-art media-tile media-hairline">
        ${img}
        <span class="picker-product-add" aria-hidden="true">${icon('plus-to-check')}</span>
      </div>
      <div class="picker-product-caption">
        <p class="picker-product-title">${escapeHtml(p.title)}</p>
        <p class="picker-product-price">${price}</p>
      </div>
    </div>`;
}

// The whole dashed column is the control; the plus is its visual.
function renderAddColumn() {
  return `
    <div class="picker-add-column" role="button" tabindex="0" data-action="add-brand" aria-label="Add a brand" aria-haspopup="true">
      <span class="picker-add-btn" aria-hidden="true">${icon('plus-large', { size: 20 })}</span>
      <span class="picker-add-label">Add brand</span>
    </div>
  `;
}

function renderTray() {
  const picks = [...state.selection.values()].sort((a, b) => a.sequence - b.sequence);
  const count = picks.length;
  dom.tray.classList.toggle('is-visible', count > 0);
  dom.tray.setAttribute('aria-hidden', count === 0 ? 'true' : 'false');
  dom.section.classList.toggle('has-tray', count > 0);
  if (count === 0) {
    dom.tray.innerHTML = '';
    return;
  }

  // Brands with picks, in the order they were first picked: "Our Place × Graza"
  const firstPick = new Map();
  picks.forEach(p => { if (!firstPick.has(p.domain)) firstPick.set(p.domain, p.sequence); });
  const split = [...firstPick.keys()].map(domain => entryFor(domain)?.brand.name || domain).join(' \u00d7 ');
  const thumbs = picks.slice(-TRAY_THUMBS).map(pick => {
    const tilt = THUMB_TILTS[pick.sequence % THUMB_TILTS.length];
    return `<div class="picker-tray-thumb media-tile media-hairline" data-key="${escapeHtml(productKey(pick.domain, pick.product.id))}" style="transform: translateX(${tilt.shift}px) rotate(${tilt.rotate}deg)" title="${escapeHtml(pick.product.title)}"><img src="${catalogThumbUrl(pick.product.image, 96)}" alt=""></div>`;
  }).join('');

  dom.tray.innerHTML = `
    <div class="picker-tray-pill">
      <div class="picker-tray-thumbs">${thumbs}</div>
      <div class="picker-tray-summary">
        <strong>${count} ${count === 1 ? 'product' : 'products'}</strong>
        <span${state.draft.status === 'error' ? ' class="picker-tray-problem"' : ''}>${escapeHtml(trayNote(split))}</span>
      </div>
      <div class="picker-tray-actions">
        <button type="button" class="btn btn--md btn--overlay" data-action="clear" aria-label="Clear selection">${icon('cross-large', { size: 14 })}<span class="picker-tray-action-label">Clear</span></button>
        ${trayPrimary()}
      </div>
    </div>
  `;
}

// The brand line doubles as the progress line: while a draft is being created there is nothing
// the operator needs from it, and it is the one place in the pill with room for a sentence.
function trayNote(brands) {
  const { status, message } = state.draft;
  if (status === 'working') return `${message}\u2026`;
  if (status === 'error' || status === 'pending') return message;
  if (status === 'done') return `Opened ${message} in OfferLab`;
  return brands;
}

function trayPrimary() {
  const { status } = state.draft;
  if (status === 'working') {
    return `<button type="button" class="btn btn--md btn--primary" disabled>Working</button>`;
  }
  if (status === 'done') {
    return `<button type="button" class="btn btn--md btn--primary" data-action="open-draft">Open in OfferLab</button>`;
  }
  if (offerlab.isEnabled() && !offerlab.isConnected()) {
    return `<button type="button" class="btn btn--md btn--primary" data-action="create-bundle">Connect OfferLab</button>`;
  }
  // Connected, but without developer access there is nothing behind this button. Null means the
  // role has not come back yet, which is not the same as no.
  if (offerlab.isEnabled() && offerlab.canCreateDrafts() === false) return '';
  return `<button type="button" class="btn btn--md btn--primary" data-action="create-bundle">${status === 'error' ? 'Try again' : 'Create bundle'}</button>`;
}

/* ---------------------------------------------------------------------------
   Rail: horizontal scroll with snap, arrows, and keyboard paging
   --------------------------------------------------------------------------- */

function columnStep() {
  const column = dom.columns.querySelector('.picker-column');
  if (!column) return 400;
  const gap = parseFloat(getComputedStyle(dom.columns).columnGap || getComputedStyle(dom.columns).gap) || 16;
  return column.getBoundingClientRect().width + gap;
}

function scrollRail(direction) {
  dom.columns.scrollBy({ left: direction * columnStep(), behavior: 'smooth' });
}

function scrollToColumn(domain) {
  const column = dom.columns.querySelector(`.picker-column[data-domain="${domain}"]`);
  column?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
}

function updateRailControls() {
  if (!dom.rail || !dom.columns) return;
  const track = dom.columns;
  const overflow = track.scrollWidth > track.clientWidth + 2;
  dom.rail.classList.toggle('has-overflow', overflow);
  const prev = dom.rail.querySelector('[data-action="rail-prev"]');
  const next = dom.rail.querySelector('[data-action="rail-next"]');
  if (prev) prev.disabled = track.scrollLeft <= 2;
  if (next) next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
}

function onRailKeydown(e) {
  if (e.target.closest('input')) return;
  // A focused handle takes the arrows for width before the rail takes them for scroll.
  const handle = e.target.closest('.picker-column-resizer');
  if (handle) { resizeColumnByKey(handle, e); return; }
  if (e.key === 'ArrowRight') { scrollRail(1); e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { scrollRail(-1); e.preventDefault(); }
  else if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.picker-add-column')) {
    e.target.closest('.picker-add-column').click();
    e.preventDefault();
  }
  else if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.picker-product')) {
    const tile = e.target.closest('.picker-product');
    toggleProduct(tile.dataset.domain, tile.dataset.id);
    e.preventDefault();
  }
}

/* ---------------------------------------------------------------------------
   Add-brand popover and URL dialog
   --------------------------------------------------------------------------- */

function showAddPopover(anchor, { swapDomain = null } = {}) {
  state.swapDomain = swapDomain;
  const swapping = !!swapDomain;
  const brands = addableBrands();
  const rows = brands.map(b => {
    const domain = extractDomain(b.url || '');
    return `
      <button type="button" class="picker-add-row" data-action="pick-brand" data-domain="${escapeHtml(domain)}">
        <img class="picker-add-row-favicon" src="${getFaviconUrl(domain)}" alt="">
        <span class="picker-add-row-labels">
          <span class="picker-add-row-name">${escapeHtml(b.name)}</span>
          <span class="picker-add-row-meta">${b.catalog.count} products</span>
        </span>
      </button>`;
  }).join('');

  dom.popover.innerHTML = `
    ${swapping ? `<p class="picker-add-heading">Switch ${escapeHtml(entryFor(swapDomain)?.brand.name || 'this brand')} for</p>` : ''}
    <button type="button" class="picker-add-row picker-add-row--url" data-action="add-url">
      <span class="picker-add-row-icon">${icon('link-3-chain', { size: 16 })}</span>
      <span class="picker-add-row-labels"><span class="picker-add-row-name">${swapping ? 'Use a brand URL' : 'Add a brand by URL'}</span></span>
    </button>
    ${rows ? `<div class="picker-add-divider"></div><div class="picker-add-list scrim-mask-y">${rows}</div>` : '<p class="picker-add-empty">Every recommended brand with a catalog is already here.</p>'}
  `;

  // Anchor to the add button, kept inside the section.
  const sectionRect = dom.section.getBoundingClientRect();
  const rect = anchor.getBoundingClientRect();
  const width = 300;
  const left = Math.max(0, Math.min(rect.right - sectionRect.left - width, sectionRect.width - width));
  dom.popover.style.top = `${rect.bottom - sectionRect.top + 8}px`;
  dom.popover.style.left = `${left}px`;
  dom.popover.classList.remove('hidden');

  // Show as much of the list as the viewport allows below the anchor, never past its bottom edge.
  const list = dom.popover.querySelector('.picker-add-list');
  if (list) {
    const listTop = list.getBoundingClientRect().top;
    const available = window.innerHeight - listTop - 24;
    list.style.maxHeight = `${Math.max(240, Math.min(480, available))}px`;
  }
}

function hideAddPopover() {
  dom.popover?.classList.add('hidden');
  state.swapDomain = null;
}

function showUrlDialog() {
  // hideAddPopover clears the swap target, so carry it across.
  const swapDomain = state.swapDomain;
  hideAddPopover();
  state.swapDomain = swapDomain;
  dom.dialog.classList.remove('hidden');
  dom.dialog.querySelector('.picker-url-error').textContent = '';
  const input = dom.dialog.querySelector('input');
  input.value = '';
  input.focus();
}

function hideUrlDialog() {
  dom.dialog?.classList.add('hidden');
}

async function onUrlSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const input = form.querySelector('input');
  const button = form.querySelector('button[type="submit"]');
  const error = form.querySelector('.picker-url-error');
  const typed = input.value.trim();
  if (!typed) {
    error.textContent = 'Enter a brand name or website, like graza.co.';
    return;
  }
  if (button.disabled) return;
  button.disabled = true;
  error.textContent = '';
  try {
    // A name resolves to its site the way the omnibar does; an address goes straight through.
    let domain = looksLikeDomain(typed) ? extractDomain(typed) : null;
    if (!domain) {
      button.textContent = 'Finding site';
      domain = await resolveBrand(typed);
    }
    if (!domain) {
      error.textContent = `Couldn't find a site for “${typed}”. Enter its web address, like graza.co.`;
      return;
    }
    if (entryFor(domain) && domain !== state.swapDomain) {
      hideUrlDialog();
      scrollToColumn(domain);
      return;
    }
    button.textContent = 'Fetching catalog';
    const catalog = await fetchCatalog(domain);
    if (!catalog.products.length) {
      error.textContent = catalog.status === 'error'
        ? `Couldn't reach ${domain}.`
        : `${domain} has no public catalog to pick from.`;
      return;
    }
    const known = (getResults()?.brands || []).find(b => extractDomain(b.url || '') === domain);
    const brand = known || { name: brandNameFromDomain(domain), url: `https://${domain}`, catalog };
    brand.catalog = catalog;
    const swapDomain = state.swapDomain;
    hideUrlDialog();
    state.swapDomain = null;
    if (swapDomain) await replaceBrand(swapDomain, brand);
    else await addBrand(brand);
  } finally {
    button.disabled = false;
    button.textContent = 'Add brand';
  }
}

function brandNameFromDomain(domain) {
  return domain.replace(/^www\./, '').split('.')[0].replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/* ---------------------------------------------------------------------------
   Events
   --------------------------------------------------------------------------- */

function onSectionClick(e) {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  switch (target.dataset.action) {
    case 'toggle': toggleProduct(target.dataset.domain, target.dataset.id); break;
    case 'clear': clearSelection(); break;
    case 'suggest': generateConcepts(); break;
    case 'cancel':
      if (state.abort) state.abort.abort();
      state.abort = null;
      state.conceptsStatus = state.concepts.length ? 'ready' : 'idle';
      renderConcepts();
      renderTray();
      break;
    case 'apply-concept': applyConcept(Number(target.dataset.index)); break;
    // Creating the draft on ShopTalk arrives with OL-3986; until then it loads the concept.
    case 'create-concept': {
      const index = Number(target.dataset.index);
      applyConcept(index);
      createDraft(state.concepts[index]?.name);
      break;
    }
    case 'create-bundle': createDraft(); break;
    case 'open-draft':
      if (state.draft.url) window.open(state.draft.url, '_blank', 'noopener');
      break;
    case 'toggle-minimize': toggleMinimize(); break;
    case 'rail-prev': scrollRail(-1); break;
    case 'rail-next': scrollRail(1); break;
    case 'add-brand':
      e.stopPropagation();
      if (dom.popover.classList.contains('hidden')) showAddPopover(target.querySelector('.picker-add-btn') || target); else hideAddPopover();
      break;
    case 'pick-brand': {
      const brand = (getResults()?.brands || []).find(b => extractDomain(b.url || '') === target.dataset.domain);
      const swapDomain = state.swapDomain;
      hideAddPopover();
      if (!brand) break;
      if (swapDomain) replaceBrand(swapDomain, brand);
      else addBrand(brand);
      break;
    }
    case 'swap-brand':
      e.stopPropagation();
      if (dom.popover.classList.contains('hidden') || state.swapDomain !== target.dataset.domain) {
        showAddPopover(target, { swapDomain: target.dataset.domain });
      } else {
        hideAddPopover();
      }
      break;
    case 'add-url': showUrlDialog(); break;
    case 'remove-brand': removeBrand(target.dataset.domain); break;
  }
}

function onSectionInput(e) {
  const input = e.target.closest('.picker-filter');
  if (!input) return;
  const domain = input.dataset.domain;
  state.filters[domain] = input.value;
  const column = dom.columns.querySelector(`.picker-column[data-domain="${domain}"]`);
  const grid = column?.querySelector('.picker-grid');
  if (!grid) return;
  const fresh = document.createElement('div');
  fresh.innerHTML = renderColumnMarkup(domain);
  grid.innerHTML = fresh.querySelector('.picker-grid').innerHTML;
}
