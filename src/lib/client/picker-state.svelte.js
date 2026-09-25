/**
 * The bundle picker's state (Svelte 5 runes), shared by its modules and components: one catalog
 * column per brand, a multi-select across them, Gemini bundle concepts and the draft handoff.
 * `view` holds the motion the templates cannot express; the actions fill it in at mount.
 */
import { tick } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';

export const picker = $state({
  brands: [],                 // [{ domain, brand }], the searched brand first (on stand-ins when it has no catalog)
  selection: new SvelteMap(), // "domain:id" -> { domain, product, sequence }
  draft: { status: 'idle', message: '', url: null },
  sequence: 0,
  concepts: [],               // [{ name, hook, why, picks: [{ domain, product }], discountPercent, edited }]
  activeConcept: -1,
  conceptsStatus: 'idle',     // idle | loading | ready | error
  conceptsError: null,
  conceptsSummary: '',
  conceptsMinimized: false,
  copy: null,                 // { headline, subtitle } written for this brand set
  copyKey: null,              // the brand set that copy belongs to
  swapDomain: null,           // the column the popover is replacing, when it was opened from one
  filters: {},                // domain -> text
  popover: { open: false, top: 0, left: 0 },
  dialog: { open: false, error: '', busy: false, label: 'Add brand' },
  // Making or editing one stand-in product (picker-standins.js)
  productDialog: { open: false, domain: null, id: null, title: '', price: '', image: '', link: '', busy: false, error: '', note: '' }
});

// In-flight requests and DOM handles: nothing renders from these, so they stay out of $state.
export const runtime = {
  abort: null,
  copyAbort: null,
  stackSignature: '',   // the image set the fan last played for
  section: null,
  columns: null,
  popover: null
};

// Imperative motion and measurement, registered by the actions that own the elements.
export const view = {
  reveal() {},
  enterGrid() {},
  crossfade() {},
  fanOutStack() {},
  toggleMinimize() {},
  scrollRail() {},
  scrollToColumn() {},
  updateRail() {},
  fitPopoverList() {},
  focusUrlInput() {},
  focusProductInput() {}
};

export function resetState() {
  if (runtime.abort) runtime.abort.abort();
  picker.brands = [];
  picker.selection = new SvelteMap();
  picker.sequence = 0;
  picker.concepts = [];
  picker.conceptsSummary = '';
  picker.activeConcept = -1;
  picker.conceptsStatus = 'idle';
  picker.conceptsError = null;
  picker.filters = {};
  runtime.abort = null;
  if (runtime.copyAbort) runtime.copyAbort.abort();
  picker.swapDomain = null;
  picker.productDialog.open = false;
  picker.copy = null;
  picker.copyKey = null;
  runtime.copyAbort = null;
}

export function entryFor(domain) {
  return picker.brands.find(e => e.domain === domain) || null;
}

export function sellerEntry() {
  return picker.brands[0];
}

export function productKey(domain, id) {
  return `${domain}:${id}`;
}

export function findProduct(domain, id) {
  return entryFor(domain)?.brand.catalog?.products?.find(p => String(p.id) === String(id)) || null;
}

export function brandSetKey() {
  return picker.brands.map(e => e.domain).join(',');
}

export function brandNames() {
  return picker.brands.map(e => e.brand.name);
}

export function setDraft(status, message, url = null) {
  picker.draft = { status, message, url };
}

// The concepts card has re-rendered from state; play whatever entrance the change calls for.
export async function conceptsRendered({ reveal = false, swap = false } = {}) {
  await tick();
  if (reveal) {
    view.enterGrid();
    view.reveal();
  }
  if (swap) view.crossfade();
}
