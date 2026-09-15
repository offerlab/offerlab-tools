/**
 * Bundle picker: one catalog column per brand (the searched brand first, then partners),
 * multi-select across them, and Gemini bundle concepts. Tiles and the floating selection
 * tray follow the main app's collab-builder catalog picker (OL-3571).
 */
import {
  elements, CONFIG, getResults, extractDomain, getFaviconUrl, renderFaviconDuo, escapeHtml,
  parseJsonResponse, extractText, fetchCatalog, catalogThumbUrl, showSection
} from './app.js';
import { icon } from './icons.js';

const PICK_PARAM = 'pick';
const CONCEPT_MODEL = 'gemini-2.5-flash';
const CONCEPT_COUNT = 4;
const MAX_PRODUCTS_IN_PROMPT = 60;
const MAX_PICKS_PER_BRAND = 3;
const CONCEPT_THUMBS = 4;
const TRAY_THUMBS = 3;
// A thumb's tilt is fixed by its selection sequence, so the pile never rearranges itself.
const THUMB_TILTS = [{ rotate: 10, shift: 2 }, { rotate: -10, shift: -2 }, { rotate: 0, shift: 0 }];

const state = {
  brands: [],             // [{ domain, brand }], the searched brand first
  selection: new Map(),   // "domain:id" -> { domain, product, sequence }
  sequence: 0,
  concepts: [],           // [{ name, hook, why, picks: [{ domain, product }], discountPercent, edited }]
  activeConcept: -1,
  conceptsStatus: 'idle', // idle | loading | ready | error
  conceptsError: null,
  filters: {},            // domain -> text
  abort: null
};

const dom = {};

export function initPicker() {
  dom.section = document.getElementById('pickerSection');
  if (!dom.section) return;
  dom.header = document.getElementById('pickerHeader');
  dom.concepts = document.getElementById('pickerConcepts');
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
  window.addEventListener('resize', updateRailControls);
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

async function openPickerWith(partners, { skipUrlUpdate = false } = {}) {
  const seller = getResults()?.searchedBrand;
  const usable = partners.filter(canBuildWith);
  if (!seller || !canBuildWith(seller) || usable.length === 0) return false;

  resetState();
  state.brands = [seller, ...usable].map(brand => ({ domain: extractDomain(brand.url || ''), brand }));
  if (!skipUrlUpdate) pushPickUrl();

  renderAll();
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

function pushPickUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set(PICK_PARAM, state.brands.slice(1).map(e => e.domain).join(','));
  history.pushState(null, '', url.toString());
}

function resetState() {
  if (state.abort) state.abort.abort();
  state.brands = [];
  state.selection = new Map();
  state.sequence = 0;
  state.concepts = [];
  state.activeConcept = -1;
  state.conceptsStatus = 'idle';
  state.conceptsError = null;
  state.filters = {};
  state.abort = null;
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
  renderHeader();
  renderColumns();
  scrollToColumn(domain);
  await ensureFullCatalog(brand);
  renderColumn(domain);
}

function removeBrand(domain) {
  if (domain === sellerEntry()?.domain) return;
  state.brands = state.brands.filter(e => e.domain !== domain);
  [...state.selection.keys()].filter(key => key.startsWith(`${domain}:`)).forEach(key => state.selection.delete(key));
  // Concepts referenced that catalog; start those over.
  state.concepts = [];
  state.activeConcept = -1;
  state.conceptsStatus = 'idle';
  pushPickUrl();
  renderAll();
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

function selectionTotal() {
  return [...state.selection.values()].reduce((sum, s) => sum + (s.product.price || 0), 0);
}

function clearSelection() {
  state.selection = new Map();
  state.activeConcept = -1;
  renderSelectionState();
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

function syncActiveConceptToSelection() {
  const concept = state.concepts[state.activeConcept];
  if (!concept) return;
  concept.picks = [...state.selection.values()].map(s => ({ domain: s.domain, product: s.product }));
  concept.edited = true;
}

function promptCatalog(brand) {
  return [...brand.catalog.products]
    .filter(p => p.image)
    .sort((a, b) => Number(b.available) - Number(a.available))
    .slice(0, MAX_PRODUCTS_IN_PROMPT)
    .map(p => `${p.id} | ${p.title} | ${p.price !== null && p.price !== undefined ? `$${p.price}` : 'price n/a'}${p.productType ? ` | ${p.productType}` : ''}`)
    .join('\n');
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
  const seller = sellerEntry();
  const partners = state.brands.slice(1);
  const partnerNames = partners.map(e => e.brand.name).join(', ');
  const sections = state.brands.map((entry, i) => {
    const role = i === 0 ? 'SELLER' : `PARTNER ${i}`;
    return `=== ${role}: ${entry.brand.name} (key: ${entry.domain}) ===\n${promptProfile(entry.brand)}\n\n--- catalog (id | title | price | type) ---\n${promptCatalog(entry.brand)}`;
  }).join('\n\n');

  return `Design ${CONCEPT_COUNT} co-branded product bundles that ${seller.brand.name} could sell on its own storefront, pairing its products with products from ${partnerNames}.

${sections}

Rules:
- Every bundle includes at least one product from the seller and at least one from a partner. With several partners, spread the bundles so each partner appears in at least one, and combine partners when the products genuinely belong together.
- 1 to ${MAX_PICKS_PER_BRAND} products from any one brand, 2 to 6 products total, chosen from the catalogs above by id.
- Bundles should feel like one purchase with a clear use occasion, not a random pairing. Avoid gift cards, subscriptions, and duplicate variants of the same item.
- Make the bundles distinct from each other: different occasions, price points, or customer moments.
- discountPercent is the bundle discount versus buying separately, an integer from 10 to 25.

Return JSON only:
{
  "concepts": [
    {
      "name": "Bundle name, 5 words or fewer",
      "hook": "One customer-facing sentence selling the bundle",
      "why": "One sentence for the merchandiser on why these products belong together",
      "products": { "<brand key>": ["id"] },
      "discountPercent": 15
    }
  ]
}`;
}

async function generateConcepts() {
  if (state.brands.length < 2) return;
  if (state.abort) state.abort.abort();
  state.abort = new AbortController();
  state.conceptsStatus = 'loading';
  state.conceptsError = null;
  renderConcepts();
  renderTray();

  try {
    const response = await fetch(`${CONFIG.GEMINI_PROXY}?model=${encodeURIComponent(CONCEPT_MODEL)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: state.abort.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'You are a merchandising strategist who designs co-branded product bundles for DTC brands. Return only valid JSON.' }] },
        contents: [{ role: 'user', parts: [{ text: buildConceptPrompt() }] }],
        generationConfig: { temperature: 0.7, topP: 0.95, maxOutputTokens: 4096, responseMimeType: 'application/json' }
      })
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${response.status})`);
    }
    const data = await response.json();
    const concepts = normalizeConcepts(parseJsonResponse(extractText(data))?.concepts);
    if (concepts.length === 0) throw new Error('No usable bundles came back. Try again.');
    state.concepts = concepts;
    state.activeConcept = -1;
    state.conceptsStatus = 'ready';
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[Picker] Concept generation failed:', err);
    state.conceptsStatus = 'error';
    state.conceptsError = err.message;
  } finally {
    state.abort = null;
  }
  renderConcepts();
  renderTray();
}

// Keeps only concepts whose ids resolve to real products, with the seller and at least one partner.
function normalizeConcepts(raw) {
  if (!Array.isArray(raw)) return [];
  const seller = sellerEntry().domain;
  return raw.map(c => {
    const byBrand = c.products && typeof c.products === 'object' ? c.products : {};
    const picks = [];
    for (const [domain, ids] of Object.entries(byBrand)) {
      if (!entryFor(domain)) continue;
      const seen = new Set();
      for (const id of Array.isArray(ids) ? ids : []) {
        const product = findProduct(domain, id);
        if (!product || seen.has(product.id) || seen.size >= MAX_PICKS_PER_BRAND) continue;
        seen.add(product.id);
        picks.push({ domain, product });
      }
    }
    const hasSeller = picks.some(p => p.domain === seller);
    const hasPartner = picks.some(p => p.domain !== seller);
    if (!hasSeller || !hasPartner) return null;
    return {
      name: String(c.name || 'Untitled bundle').trim(),
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
  renderHeader();
  renderConcepts();
  renderColumns();
  renderTray();
}

function renderSelectionState() {
  dom.columns.querySelectorAll('.picker-product').forEach(tile => {
    const selected = state.selection.has(tile.dataset.key);
    tile.classList.toggle('is-selected', selected);
    tile.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
  renderTray();
  renderConcepts();
}

function renderHeader() {
  const [seller, ...partners] = state.brands;
  const title = state.brands.map(e => escapeHtml(e.brand.name)).join(' &times; ');
  dom.header.innerHTML = `
    <div class="picker-title">
      ${renderFaviconDuo(seller.domain, partners[0]?.domain || seller.domain)}
      <div class="picker-title-labels">
        <h2 class="results-group-title">${title}</h2>
        <p class="results-group-title text-content-tertiary">Pick products across the catalogs, or let AI suggest a few bundles to start from.</p>
      </div>
    </div>
  `;
}

function renderConcepts() {
  const { conceptsStatus } = state;
  let body;
  if (conceptsStatus === 'loading') {
    body = `<div class="picker-concepts-grid">${'<div class="picker-concept picker-concept--skeleton"></div>'.repeat(CONCEPT_COUNT)}</div>`;
  } else if (conceptsStatus === 'error') {
    body = `<div class="picker-concepts-empty">
      <p>${escapeHtml(state.conceptsError || 'Something went wrong.')}</p>
      <button type="button" class="btn btn--md btn--primary" data-action="suggest">Try again</button>
    </div>`;
  } else if (conceptsStatus === 'ready') {
    body = `<div class="picker-concepts-grid">${state.concepts.map(renderConceptCard).join('')}</div>`;
  } else {
    body = `<div class="picker-concepts-empty">
      <p>Four bundle ideas built from the catalogs, each with a suggested price. Click one to load it into the picker.</p>
      <button type="button" class="btn btn--md btn--primary" data-action="suggest">Suggest bundles</button>
    </div>`;
  }

  const action = conceptsStatus === 'loading'
    ? `<button type="button" class="btn btn--md btn--secondary" data-action="cancel">Stop</button>`
    : conceptsStatus === 'ready'
      ? `<button type="button" class="btn btn--md btn--secondary" data-action="suggest">Regenerate</button>`
      : '';

  dom.concepts.innerHTML = `
    <div class="picker-section-head">
      <h3 class="picker-section-title">Bundle concepts</h3>
      ${action}
    </div>
    ${body}
  `;
}

function renderConceptCard(concept, index) {
  const products = concept.picks.map(p => p.product);
  const separate = conceptSeparatePrice(concept);
  const bundle = conceptBundlePrice(concept);
  const thumbs = products.slice(0, CONCEPT_THUMBS).map(p => `<img src="${catalogThumbUrl(p.image, 120)}" alt="" title="${escapeHtml(p.title)}">`).join('');
  const more = products.length > CONCEPT_THUMBS ? `<span class="picker-concept-more">+${products.length - CONCEPT_THUMBS}</span>` : '';
  const split = state.brands
    .map(e => ({ name: e.brand.name, n: concept.picks.filter(p => p.domain === e.domain).length }))
    .filter(x => x.n > 0)
    .map(x => `${x.n} ${escapeHtml(x.name)}`)
    .join(' · ');
  const active = index === state.activeConcept;
  return `
    <button type="button" class="picker-concept${active ? ' is-active' : ''}" data-action="apply-concept" data-index="${index}">
      <div class="picker-concept-thumbs">${thumbs}${more}</div>
      <div class="picker-concept-name">${escapeHtml(concept.name)}${concept.edited ? ' <span class="picker-concept-edited">edited</span>' : ''}</div>
      <p class="picker-concept-hook">${escapeHtml(concept.hook)}</p>
      <div class="picker-concept-price">
        <strong>${money(bundle)}</strong>
        <span>${money(separate)} separately · save ${concept.discountPercent}%</span>
      </div>
      <div class="picker-concept-meta">${split}</div>
    </button>
  `;
}

function renderColumns() {
  dom.columns.innerHTML = state.brands.map(e => renderColumnMarkup(e.domain)).join('') + renderAddColumn();
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
      <div class="picker-column-head">
        <img class="picker-column-favicon" src="${getFaviconUrl(domain)}" alt="">
        <div class="picker-column-labels">
          <div class="picker-column-name">${escapeHtml(brand.name)}</div>
          <div class="picker-column-count">${catalog.count} products${loadingMore ? ' · loading the rest' : ''}</div>
        </div>
        ${removable ? `<button type="button" class="picker-column-remove" data-action="remove-brand" data-domain="${escapeHtml(domain)}" aria-label="Remove ${escapeHtml(brand.name)}">${icon('cross-large', { size: 16 })}</button>` : ''}
      </div>
      <div class="picker-column-filter">
        <input type="search" class="picker-filter" data-domain="${escapeHtml(domain)}" placeholder="Filter products" value="${escapeHtml(state.filters[domain] || '')}" aria-label="Filter ${escapeHtml(brand.name)} products">
      </div>
      <div class="picker-grid">${products.map(p => renderTile(domain, p)).join('') || '<p class="picker-grid-empty">No products match.</p>'}</div>
    </div>
  `;
}

// The catalog picker's flat tile: the artwork is the tile, and the add button is where selection
// is expressed (plus morphs to check). The whole tile toggles, since there is nothing to open.
function renderTile(domain, p) {
  const key = productKey(domain, p.id);
  const selected = state.selection.has(key);
  const price = p.price !== null && p.price !== undefined ? money(p.price) : 'Price varies';
  const img = p.image ? `<img src="${catalogThumbUrl(p.image, 320)}" alt="" loading="lazy">` : '';
  return `
    <div class="picker-product${selected ? ' is-selected' : ''}" role="button" tabindex="0" aria-pressed="${selected}" data-action="toggle" data-domain="${escapeHtml(domain)}" data-id="${escapeHtml(String(p.id))}" data-key="${escapeHtml(key)}" title="${escapeHtml(p.title)}">
      <div class="picker-product-art">
        ${img}
        <span class="picker-product-add" aria-hidden="true">${icon('plus-to-check')}</span>
      </div>
      <div class="picker-product-caption">
        <p class="picker-product-title">${escapeHtml(p.title)}</p>
        <p class="picker-product-price">${price}</p>
      </div>
    </div>`;
}

function renderAddColumn() {
  return `
    <div class="picker-add-column">
      <button type="button" class="picker-add-btn" data-action="add-brand" aria-label="Add a brand" aria-haspopup="true">${icon('plus-large', { size: 20 })}</button>
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

  const split = state.brands
    .map(e => ({ name: e.brand.name, n: selectedFor(e.domain).length }))
    .filter(x => x.n > 0)
    .map(x => `${x.n} ${escapeHtml(x.name)}`)
    .join(', ');
  const thumbs = picks.slice(-TRAY_THUMBS).map(pick => {
    const tilt = THUMB_TILTS[pick.sequence % THUMB_TILTS.length];
    return `<div class="picker-tray-thumb" data-key="${escapeHtml(productKey(pick.domain, pick.product.id))}" style="transform: translateX(${tilt.shift}px) rotate(${tilt.rotate}deg)"><img src="${catalogThumbUrl(pick.product.image, 96)}" alt="" title="${escapeHtml(pick.product.title)}"></div>`;
  }).join('');

  dom.tray.innerHTML = `
    <div class="picker-tray-pill">
      <div class="picker-tray-thumbs">${thumbs}</div>
      <div class="picker-tray-summary">
        <strong>${count} ${count === 1 ? 'product' : 'products'} · ${money(selectionTotal())}</strong>
        <span>${split}</span>
      </div>
      <button type="button" class="btn btn--md btn--secondary" data-action="clear">Clear</button>
      <button type="button" class="btn btn--md btn--primary" data-action="suggest"${state.conceptsStatus === 'loading' ? ' disabled' : ''}>Suggest bundles</button>
    </div>
  `;
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
  if (e.key === 'ArrowRight') { scrollRail(1); e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { scrollRail(-1); e.preventDefault(); }
  else if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.picker-product')) {
    const tile = e.target.closest('.picker-product');
    toggleProduct(tile.dataset.domain, tile.dataset.id);
    e.preventDefault();
  }
}

/* ---------------------------------------------------------------------------
   Add-brand popover and URL dialog
   --------------------------------------------------------------------------- */

function showAddPopover(anchor) {
  const brands = addableBrands();
  const rows = brands.map(b => {
    const domain = extractDomain(b.url || '');
    return `
      <button type="button" class="picker-add-row" data-action="add-result-brand" data-domain="${escapeHtml(domain)}">
        <img class="picker-add-row-favicon" src="${getFaviconUrl(domain)}" alt="">
        <span class="picker-add-row-labels">
          <span class="picker-add-row-name">${escapeHtml(b.name)}</span>
          <span class="picker-add-row-meta">${b.catalog.count} products</span>
        </span>
      </button>`;
  }).join('');

  dom.popover.innerHTML = `
    <button type="button" class="picker-add-row picker-add-row--url" data-action="add-url">
      <span class="picker-add-row-icon">${icon('plus-large', { size: 16 })}</span>
      <span class="picker-add-row-labels"><span class="picker-add-row-name">Add a brand by URL</span></span>
    </button>
    ${rows ? `<div class="picker-add-divider"></div><div class="picker-add-list">${rows}</div>` : '<p class="picker-add-empty">Every recommended brand with a catalog is already here.</p>'}
  `;

  // Anchor to the add button, kept inside the section.
  const sectionRect = dom.section.getBoundingClientRect();
  const rect = anchor.getBoundingClientRect();
  const width = 300;
  const left = Math.max(0, Math.min(rect.right - sectionRect.left - width, sectionRect.width - width));
  dom.popover.style.top = `${rect.bottom - sectionRect.top + 8}px`;
  dom.popover.style.left = `${left}px`;
  dom.popover.classList.remove('hidden');
}

function hideAddPopover() {
  dom.popover?.classList.add('hidden');
}

function showUrlDialog() {
  hideAddPopover();
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
  const domain = extractDomain(input.value.trim());
  if (!domain) {
    error.textContent = 'Enter a brand website, like graza.co.';
    return;
  }
  if (entryFor(domain)) {
    hideUrlDialog();
    scrollToColumn(domain);
    return;
  }
  button.disabled = true;
  button.textContent = 'Fetching catalog';
  error.textContent = '';
  try {
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
    hideUrlDialog();
    await addBrand(brand);
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
    case 'rail-prev': scrollRail(-1); break;
    case 'rail-next': scrollRail(1); break;
    case 'add-brand':
      e.stopPropagation();
      if (dom.popover.classList.contains('hidden')) showAddPopover(target); else hideAddPopover();
      break;
    case 'add-result-brand': {
      const brand = (getResults()?.brands || []).find(b => extractDomain(b.url || '') === target.dataset.domain);
      hideAddPopover();
      if (brand) addBrand(brand);
      break;
    }
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
