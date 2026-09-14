/**
 * Bundle picker: both catalogs side by side, multi-select across them, and Gemini bundle
 * concepts. Opened from a recommended brand card once its catalog has products.
 */
import {
  elements, CONFIG, getResults, extractDomain, getFaviconUrl, renderFaviconDuo, escapeHtml,
  parseJsonResponse, extractText, fetchCatalog, catalogThumbUrl, showSection
} from './app.js';

const PICK_PARAM = 'pick';
const CONCEPT_MODEL = 'gemini-2.5-flash';
const CONCEPT_COUNT = 4;
const MAX_PRODUCTS_IN_PROMPT = 60;
const FOOTER_THUMBS = 6;
const CONCEPT_THUMBS = 4;

const state = {
  searched: null,
  partner: null,
  selection: new Map(),   // key "searched:123" -> { side, product }
  concepts: [],
  activeConcept: -1,
  conceptsStatus: 'idle', // idle | loading | ready | error
  conceptsError: null,
  filters: { searched: '', partner: '' },
  abort: null
};

const dom = {};

export function initPicker() {
  dom.section = document.getElementById('pickerSection');
  if (!dom.section) return;
  dom.header = document.getElementById('pickerHeader');
  dom.concepts = document.getElementById('pickerConcepts');
  dom.columns = document.getElementById('pickerColumns');
  dom.footer = document.getElementById('pickerFooter');

  dom.section.addEventListener('click', onSectionClick);
  dom.section.addEventListener('input', onSectionInput);
}

export function canBuildWith(brand) {
  return (brand?.catalog?.products?.length || 0) > 0;
}

export async function openPicker(partner, { skipUrlUpdate = false } = {}) {
  const searched = getResults()?.searchedBrand;
  if (!searched || !canBuildWith(searched) || !canBuildWith(partner)) return false;

  resetState();
  state.searched = searched;
  state.partner = partner;

  if (!skipUrlUpdate) {
    const url = new URL(window.location.href);
    url.searchParams.set(PICK_PARAM, extractDomain(partner.url || ''));
    history.pushState(null, '', url.toString());
  }

  renderAll();
  showSection('picker');
  window.scrollTo({ top: 0 });

  // Cached catalogs are trimmed for localStorage; the picker wants the whole thing.
  await Promise.all([ensureFullCatalog(searched), ensureFullCatalog(partner)]);
  if (state.partner === partner) renderColumns();
  return true;
}

export function closePicker() {
  if (state.abort) state.abort.abort();
  const url = new URL(window.location.href);
  if (url.searchParams.has(PICK_PARAM)) {
    url.searchParams.delete(PICK_PARAM);
    history.pushState(null, '', url.toString());
  }
  resetState();
  showSection('results');
}

// Browser back/forward: the URL is the source of truth for whether the picker is open.
export function syncPickerWithUrl() {
  const domain = new URLSearchParams(window.location.search).get(PICK_PARAM);
  const isOpen = dom.section && !dom.section.classList.contains('hidden');
  if (!domain && isOpen) {
    resetState();
    showSection('results');
  } else if (domain && !isOpen) {
    restorePickerFromUrl();
  }
}

// After results render, reopen the picker named in the URL.
export function restorePickerFromUrl() {
  const domain = new URLSearchParams(window.location.search).get(PICK_PARAM);
  const brands = getResults()?.brands;
  if (!domain || !brands) return;
  const match = brands.find(b => extractDomain(b.url || '') === domain);
  if (match && canBuildWith(match)) {
    openPicker(match, { skipUrlUpdate: true });
  } else {
    const url = new URL(window.location.href);
    url.searchParams.delete(PICK_PARAM);
    history.replaceState(null, '', url.toString());
  }
}

function resetState() {
  if (state.abort) state.abort.abort();
  state.searched = null;
  state.partner = null;
  state.selection = new Map();
  state.concepts = [];
  state.activeConcept = -1;
  state.conceptsStatus = 'idle';
  state.conceptsError = null;
  state.filters = { searched: '', partner: '' };
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
   Selection
   --------------------------------------------------------------------------- */

function brandFor(side) {
  return side === 'searched' ? state.searched : state.partner;
}

function productKey(side, id) {
  return `${side}:${id}`;
}

function findProduct(side, id) {
  return brandFor(side)?.catalog?.products?.find(p => String(p.id) === String(id)) || null;
}

function toggleProduct(side, id) {
  const key = productKey(side, id);
  if (state.selection.has(key)) {
    state.selection.delete(key);
  } else {
    const product = findProduct(side, id);
    if (!product) return;
    state.selection.set(key, { side, product });
  }
  if (state.activeConcept >= 0) syncActiveConceptToSelection();
  renderSelectionState();
}

function selectedBySide(side) {
  return [...state.selection.values()].filter(s => s.side === side).map(s => s.product);
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
  return [...concept.searched, ...concept.partner].reduce((sum, p) => sum + (p.price || 0), 0);
}

function conceptBundlePrice(concept) {
  const separate = conceptSeparatePrice(concept);
  return Math.round(separate * (1 - concept.discountPercent / 100) * 100) / 100;
}

function applyConcept(index) {
  const concept = state.concepts[index];
  if (!concept) return;
  state.selection = new Map();
  concept.searched.forEach(p => state.selection.set(productKey('searched', p.id), { side: 'searched', product: p }));
  concept.partner.forEach(p => state.selection.set(productKey('partner', p.id), { side: 'partner', product: p }));
  state.activeConcept = index;
  renderSelectionState();
}

function syncActiveConceptToSelection() {
  const concept = state.concepts[state.activeConcept];
  if (!concept) return;
  concept.searched = selectedBySide('searched');
  concept.partner = selectedBySide('partner');
  concept.edited = true;
}

function promptCatalog(brand) {
  const products = [...brand.catalog.products]
    .filter(p => p.image)
    .sort((a, b) => Number(b.available) - Number(a.available))
    .slice(0, MAX_PRODUCTS_IN_PROMPT);
  return products.map(p => `${p.id} | ${p.title} | ${p.price !== null && p.price !== undefined ? `$${p.price}` : 'price n/a'}${p.productType ? ` | ${p.productType}` : ''}`).join('\n');
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
  const a = state.searched;
  const b = state.partner;
  return `Design ${CONCEPT_COUNT} co-branded product bundles that ${a.name} could sell on its own storefront, each pairing its products with products from ${b.name}.

=== BRAND A (the seller) ===
${promptProfile(a)}

=== BRAND B (the partner) ===
${promptProfile(b)}

=== BRAND A CATALOG (id | title | price | type) ===
${promptCatalog(a)}

=== BRAND B CATALOG (id | title | price | type) ===
${promptCatalog(b)}

Rules:
- Every bundle uses 1 to 3 products from EACH brand, 2 to 5 products total, chosen from the catalogs above by id.
- Bundles should feel like one purchase with a clear use occasion, not a random pairing. Avoid gift cards, subscriptions, and duplicate variants of the same item.
- Make the four bundles distinct from each other: different occasions, price points, or customer moments.
- discountPercent is the bundle discount versus buying separately, an integer from 10 to 25.

Return JSON only:
{
  "concepts": [
    {
      "name": "Bundle name, 5 words or fewer",
      "hook": "One customer-facing sentence selling the bundle",
      "why": "One sentence for the merchandiser on why these products belong together",
      "brandAProductIds": ["id"],
      "brandBProductIds": ["id"],
      "discountPercent": 15
    }
  ]
}`;
}

async function generateConcepts() {
  if (!state.searched || !state.partner) return;
  if (state.abort) state.abort.abort();
  state.abort = new AbortController();
  state.conceptsStatus = 'loading';
  state.conceptsError = null;
  renderConcepts();

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
    const parsed = parseJsonResponse(extractText(data));
    const concepts = normalizeConcepts(parsed?.concepts);
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
}

// Keeps only concepts whose ids resolve to real products, with at least one from each brand.
function normalizeConcepts(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(c => {
    const searched = uniqueProducts('searched', c.brandAProductIds);
    const partner = uniqueProducts('partner', c.brandBProductIds);
    if (searched.length === 0 || partner.length === 0) return null;
    const discount = Math.min(25, Math.max(10, parseInt(c.discountPercent, 10) || 15));
    return {
      name: String(c.name || 'Untitled bundle').trim(),
      hook: String(c.hook || '').trim(),
      why: String(c.why || '').trim(),
      searched: searched.slice(0, 3),
      partner: partner.slice(0, 3),
      discountPercent: discount,
      edited: false
    };
  }).filter(Boolean).slice(0, CONCEPT_COUNT + 1);
}

function uniqueProducts(side, ids) {
  const seen = new Set();
  return (Array.isArray(ids) ? ids : []).map(id => findProduct(side, id)).filter(p => {
    if (!p || seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
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
  renderFooter();
}

function renderSelectionState() {
  dom.columns.querySelectorAll('.picker-product').forEach(tile => {
    tile.classList.toggle('is-selected', state.selection.has(tile.dataset.key));
  });
  renderFooter();
  renderConcepts();
}

function renderHeader() {
  const a = state.searched;
  const b = state.partner;
  dom.header.innerHTML = `
    <button type="button" class="btn btn--md btn--secondary picker-back" data-action="close">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      Back to results
    </button>
    <div class="picker-title">
      ${renderFaviconDuo(extractDomain(a.url || ''), extractDomain(b.url || ''))}
      <div class="picker-title-labels">
        <h2 class="results-group-title">${escapeHtml(a.name)} &times; ${escapeHtml(b.name)}</h2>
        <p class="results-group-title text-content-tertiary">Pick products from both catalogs, or let AI suggest a few bundles to start from.</p>
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
      <p>Four bundle ideas built from both catalogs, each with a suggested price. Click one to load it into the picker.</p>
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
  const products = [...concept.searched, ...concept.partner];
  const separate = conceptSeparatePrice(concept);
  const bundle = conceptBundlePrice(concept);
  const thumbs = products.slice(0, CONCEPT_THUMBS).map(p => `<img src="${catalogThumbUrl(p.image, 120)}" alt="" title="${escapeHtml(p.title)}">`).join('');
  const more = products.length > CONCEPT_THUMBS ? `<span class="picker-concept-more">+${products.length - CONCEPT_THUMBS}</span>` : '';
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
      <div class="picker-concept-meta">${concept.searched.length} from ${escapeHtml(state.searched.name)} · ${concept.partner.length} from ${escapeHtml(state.partner.name)}</div>
    </button>
  `;
}

function renderColumns() {
  dom.columns.innerHTML = renderColumn('searched') + renderColumn('partner');
}

function renderColumn(side) {
  const brand = brandFor(side);
  const catalog = brand.catalog;
  const domain = extractDomain(brand.url || '');
  const filter = state.filters[side].trim().toLowerCase();
  const products = catalog.products.filter(p => !filter || p.title.toLowerCase().includes(filter));
  const loadingMore = catalog.status === 'shopify' && (catalog.truncated || catalog.products.length < catalog.count);

  const tiles = products.map(p => {
    const key = productKey(side, p.id);
    const price = p.price !== null && p.price !== undefined ? money(p.price) : 'Price varies';
    const img = p.image ? `<img src="${catalogThumbUrl(p.image, 320)}" alt="" loading="lazy">` : '';
    return `
      <button type="button" class="picker-product${state.selection.has(key) ? ' is-selected' : ''}" data-action="toggle" data-side="${side}" data-id="${escapeHtml(String(p.id))}" data-key="${key}" title="${escapeHtml(p.title)}">
        <div class="picker-product-image">${img}<span class="picker-product-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span></div>
        <div class="picker-product-title">${escapeHtml(p.title)}</div>
        <div class="picker-product-price">${price}</div>
      </button>`;
  }).join('');

  return `
    <div class="picker-column" data-side="${side}">
      <div class="picker-column-head">
        <img class="picker-column-favicon" src="${getFaviconUrl(domain)}" alt="">
        <div class="picker-column-labels">
          <div class="picker-column-name">${escapeHtml(brand.name)}</div>
          <div class="picker-column-count">${catalog.count} products${loadingMore ? ' · loading the rest' : ''}</div>
        </div>
        <input type="search" class="picker-filter" data-side="${side}" placeholder="Filter" value="${escapeHtml(state.filters[side])}" aria-label="Filter ${escapeHtml(brand.name)} products">
      </div>
      <div class="picker-grid">${tiles || '<p class="picker-grid-empty">No products match.</p>'}</div>
    </div>
  `;
}

function renderFooter() {
  const items = [...state.selection.values()];
  const count = items.length;
  const thumbs = items.slice(0, FOOTER_THUMBS).map(s => `<img src="${catalogThumbUrl(s.product.image, 96)}" alt="" title="${escapeHtml(s.product.title)}">`).join('');
  const more = count > FOOTER_THUMBS ? `<span class="picker-footer-more">+${count - FOOTER_THUMBS}</span>` : '';
  const a = selectedBySide('searched').length;
  const b = selectedBySide('partner').length;
  const summary = count === 0
    ? 'Nothing selected yet'
    : `${count} ${count === 1 ? 'product' : 'products'} · ${money(selectionTotal())} · ${a} ${escapeHtml(state.searched.name)}, ${b} ${escapeHtml(state.partner.name)}`;

  dom.footer.innerHTML = `
    <div class="picker-footer-selection">
      <div class="picker-footer-thumbs">${thumbs}${more}</div>
      <div class="picker-footer-summary">${summary}</div>
    </div>
    <div class="picker-footer-actions">
      <button type="button" class="btn btn--md btn--secondary" data-action="clear"${count === 0 ? ' disabled' : ''}>Clear</button>
      <button type="button" class="btn btn--md btn--primary" data-action="suggest"${state.conceptsStatus === 'loading' ? ' disabled' : ''}>Suggest bundles</button>
    </div>
  `;
  dom.footer.classList.toggle('has-selection', count > 0);
}

/* ---------------------------------------------------------------------------
   Events
   --------------------------------------------------------------------------- */

function onSectionClick(e) {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  switch (target.dataset.action) {
    case 'close': closePicker(); break;
    case 'toggle': toggleProduct(target.dataset.side, target.dataset.id); break;
    case 'clear': clearSelection(); break;
    case 'suggest': generateConcepts(); break;
    case 'cancel':
      if (state.abort) state.abort.abort();
      state.abort = null;
      state.conceptsStatus = state.concepts.length ? 'ready' : 'idle';
      renderConcepts();
      renderFooter();
      break;
    case 'apply-concept': applyConcept(Number(target.dataset.index)); break;
  }
}

function onSectionInput(e) {
  const input = e.target.closest('.picker-filter');
  if (!input) return;
  const side = input.dataset.side;
  state.filters[side] = input.value;
  const column = dom.columns.querySelector(`.picker-column[data-side="${side}"]`);
  const grid = column?.querySelector('.picker-grid');
  if (!grid) return;
  const fresh = document.createElement('div');
  fresh.innerHTML = renderColumn(side);
  grid.innerHTML = fresh.querySelector('.picker-grid').innerHTML;
}
