/**
 * Gemini bundle concepts for the picker, and the card's copy: written for whichever brands are
 * on the rail, refreshed when that changes.
 */
import { CONFIG, parseJsonResponse, extractText } from './util.js';
import { picker, runtime, sellerEntry, brandNames, brandSetKey, conceptsRendered } from './picker-state.svelte.js';
import { CONCEPT_MODEL, CONCEPT_COUNT, MAX_PICKS_PER_BRAND, CONCEPT_ANGLES, buildConceptPrompt, buildCopyPrompt } from './picker-prompt.js';

export function money(value) {
  if (value === null || value === undefined) return '';
  return `$${Number(value).toFixed(2).replace(/\.00$/, '')}`;
}

// Shown until the model answers, and whenever it cannot. Names the brands and says what happens.
export function fallbackCopy() {
  const names = brandNames();
  return {
    headline: `${names.join(' x ')}, bundled`,
    subtitle: names.length > 1 ? 'AI picks the pairs. You pick the winner.' : 'Add a partner brand to pair with.'
  };
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

export async function refreshConceptsCopy() {
  const key = brandSetKey();
  if (!key || picker.copyKey === key) return;
  if (runtime.copyAbort) runtime.copyAbort.abort();
  picker.copyKey = key;
  // One brand has nothing to pair with yet; asked anyway, the model invents a partner.
  if (picker.brands.length < 2) {
    picker.copy = null;
    return;
  }
  const controller = new AbortController();
  runtime.copyAbort = controller;

  try {
    const response = await fetch(`${CONFIG.GEMINI_PROXY}?model=${encodeURIComponent(CONCEPT_MODEL)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
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
    if (picker.copyKey !== key) return;
    picker.copy = { headline: tidyCopy(parsed.headline), subtitle: tidyCopy(parsed.subtitle) };
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.warn('[Picker] Concept copy failed:', err.message);
  } finally {
    if (runtime.copyAbort === controller) runtime.copyAbort = null;
  }
}

function conceptSeparatePrice(concept) {
  return concept.picks.reduce((sum, p) => sum + (p.product.price || 0), 0);
}

export function conceptBundlePrice(concept) {
  return Math.round(conceptSeparatePrice(concept) * (1 - concept.discountPercent / 100) * 100) / 100;
}

export async function generateConcepts() {
  if (picker.brands.length < 2) return;
  if (runtime.abort) runtime.abort.abort();
  const controller = new AbortController();
  runtime.abort = controller;
  picker.conceptsStatus = 'loading';
  picker.conceptsError = null;
  let revealOnRender = false;

  const prompt = buildConceptPrompt();

  try {
    const response = await fetch(`${CONFIG.GEMINI_PROXY}?model=${encodeURIComponent(CONCEPT_MODEL)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
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
    picker.concepts = concepts;
    picker.conceptsSummary = tidySummary(parsed?.summary);
    picker.activeConcept = -1;
    picker.conceptsStatus = 'ready';
    revealOnRender = true;
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[Picker] Concept generation failed:', err);
    picker.conceptsStatus = 'error';
    picker.conceptsError = err.message;
  } finally {
    if (runtime.abort === controller) runtime.abort = null;
  }
  conceptsRendered({ reveal: revealOnRender });
}

export function cancelConcepts() {
  if (runtime.abort) runtime.abort.abort();
  runtime.abort = null;
  picker.conceptsStatus = picker.concepts.length ? 'ready' : 'idle';
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

// Product images for the fanned stack on the concepts card: round-robin across the brands,
// seller first, so a two-brand pair still fans five cards.
export function stackImages() {
  const lists = picker.brands.map(e => (e.brand.catalog?.products || []).map(p => p.image));
  const images = [];
  for (let i = 0; images.length < 5 && lists.some(l => l[i]); i++) {
    for (const list of lists) if (list[i] && images.length < 5) images.push(list[i]);
  }
  return images;
}
