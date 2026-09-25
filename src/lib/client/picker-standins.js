/**
 * The searched brand's column when it has no public catalog: stand-in products
 * (shared/standins.js) that the operator takes as they are, edits, or adds to by hand or from a
 * product link, so the brand still sees a bundle of its own and can build it.
 */
import { tick } from 'svelte';
import { gatherStandIns, productFromLink, standIn } from '$lib/shared/standins.js';
import { toPrice } from '$lib/shared/page.js';
import { getResults } from './state.svelte.js';
import { extractDomain, searchApi } from './util.js';
import { picker, entryFor, findProduct, productKey, view } from './picker-state.svelte.js';
import { toggleProduct } from './picker-selection.js';

// What the operator made of each brand's stand-ins, by domain. It outlasts the picker closing and
// opening again, and goes with the tab.
const made = new Map();
let nextId = 1;

export function isStandIns(catalog) {
  return catalog?.status === 'standin';
}

/**
 * The brand as the picker's lead on stand-ins: a copy, so the results card keeps saying it has no
 * catalog. `loading` while a search from before stand-ins existed still has to find some.
 */
export function standInEntry(brand) {
  const domain = extractDomain(brand.url || '');
  const products = made.get(domain) || brand.standIns?.products || [];
  const loading = !made.has(domain) && !brand.standIns;
  return {
    domain,
    brand: { ...brand, catalog: { status: 'standin', domain, count: products.length, products: products.map(p => ({ ...p })), loading } }
  };
}

/**
 * Finds stand-ins for a lead that came without them. What is found is kept for the session, so
 * the picker asks once per brand; finding nothing is not kept, and the column offers to try again.
 */
export async function ensureStandIns(domain) {
  const entry = entryFor(domain);
  if (!isStandIns(entry?.brand.catalog) || !entry.brand.catalog.loading) return;

  const gathered = await gatherStandIns(searchApi, entry.brand).catch(() => null);
  const seller = getResults()?.searchedBrand;
  if (gathered && seller && extractDomain(seller.url || '') === domain) seller.standIns = gathered;

  const current = entryFor(domain);
  if (!isStandIns(current?.brand.catalog) || !current.brand.catalog.loading) return;
  if (!gathered) {
    current.brand.catalog = { ...current.brand.catalog, loading: false, failed: true };
    return;
  }
  current.brand.standIns = gathered;
  // Anything added by hand while these were found stays, ahead of them.
  const products = [...current.brand.catalog.products, ...gathered.products.map(p => ({ ...p }))];
  current.brand.catalog = { ...current.brand.catalog, products, count: products.length, loading: false };
}

/** The column's Suggest products, after a search for stand-ins found nothing. */
export function retryStandIns(domain) {
  const catalog = entryFor(domain)?.brand.catalog;
  if (!isStandIns(catalog) || catalog.loading) return;
  catalog.loading = true;
  catalog.failed = false;
  return ensureStandIns(domain);
}

function remember(domain) {
  const catalog = entryFor(domain)?.brand.catalog;
  if (isStandIns(catalog)) made.set(domain, catalog.products.map(p => ({ ...p })));
}

/* -------------------------------------------------------------------------- */
/* The product dialog                                                          */
/* -------------------------------------------------------------------------- */

export async function openProductDialog(domain, id = null) {
  const product = id ? findProduct(domain, id) : null;
  Object.assign(picker.productDialog, {
    open: true,
    domain,
    id: product ? String(product.id) : null,
    title: product?.title || '',
    price: product?.price ? String(product.price) : '',
    image: product?.image || '',
    link: product?.url || '',
    busy: false,
    error: '',
    note: ''
  });
  await tick();
  view.focusProductInput();
}

export function hideProductDialog() {
  picker.productDialog.open = false;
}

/**
 * The pictures to choose from: what was found for the brand and what its stand-ins already
 * show, in a fixed order, with the one the product has now in front if it is none of those.
 */
export function dialogPictures() {
  const dialog = picker.productDialog;
  const brand = entryFor(dialog.domain)?.brand;
  const found = [
    ...(brand?.standIns?.images || []),
    ...(brand?.catalog?.products || []).map(p => ({ src: p.image, alt: p.title }))
  ].filter(p => p.src);
  const pictures = [];
  const seen = new Set();
  for (const picture of found) {
    if (seen.has(picture.src)) continue;
    seen.add(picture.src);
    pictures.push(picture);
  }
  const current = dialog.image.trim();
  return current && !seen.has(current) ? [{ src: current, alt: dialog.title }, ...pictures] : pictures;
}

export function pickPicture(src) {
  picker.productDialog.image = src || '';
}

/** Fills the form from a product page. A site that turns the read away leaves a guess at the name. */
export async function fillFromLink() {
  const dialog = picker.productDialog;
  const link = dialog.link.trim();
  if (!link || dialog.busy) return;
  dialog.busy = true;
  dialog.error = '';
  dialog.note = '';
  try {
    const found = await productFromLink(searchApi, link);
    if (!picker.productDialog.open || picker.productDialog.link.trim() !== link) return;
    if (found.name) dialog.title = found.name;
    if (found.price) dialog.price = String(found.price);
    if (found.image) dialog.image = found.image;
    if (found.blocked) {
      const host = extractDomain(link) || 'That site';
      dialog.note = found.name
        ? `${host} would not let us read that page, so the name comes from the link. Add the price and pick a picture.`
        : `${host} would not let us read that page. Fill the product in below.`;
    }
  } finally {
    dialog.busy = false;
  }
}

export function saveProduct() {
  const dialog = picker.productDialog;
  const entry = entryFor(dialog.domain);
  if (!isStandIns(entry?.brand.catalog)) {
    hideProductDialog();
    return;
  }
  const title = dialog.title.trim();
  const price = toPrice(dialog.price);
  if (!title) {
    dialog.error = 'Give the product a name.';
    return;
  }
  // OfferLab takes a product live only with a price, so a bundle cannot be built without one.
  if (!price) {
    dialog.error = 'Give the product a price.';
    return;
  }
  const image = dialog.image.trim() || null;
  const url = dialog.link.trim() || null;

  const existing = dialog.id ? findProduct(dialog.domain, dialog.id) : null;
  if (existing) {
    Object.assign(existing, { title, price, image, url });
  } else {
    const catalog = entry.brand.catalog;
    const product = standIn({ id: `made-${nextId++}`, title, price, image, url });
    catalog.products = [product, ...catalog.products];
    catalog.count = catalog.products.length;
    // Made to be bundled, so it goes straight into the selection.
    toggleProduct(dialog.domain, product.id);
  }
  remember(dialog.domain);
  hideProductDialog();
}

export function removeProduct() {
  const { domain, id } = picker.productDialog;
  const entry = entryFor(domain);
  if (id && isStandIns(entry?.brand.catalog)) {
    if (picker.selection.has(productKey(domain, id))) toggleProduct(domain, id);
    const catalog = entry.brand.catalog;
    catalog.products = catalog.products.filter(p => String(p.id) !== id);
    catalog.count = catalog.products.length;
    picker.concepts.forEach(concept => {
      concept.picks = concept.picks.filter(pick => !(pick.domain === domain && String(pick.product.id) === id));
    });
    remember(domain);
  }
  hideProductDialog();
}
