/**
 * Adding a brand to the rail: the popover of recommended brands, and the dialog that takes a
 * brand name or URL instead.
 */
import { tick } from 'svelte';
import { extractDomain, fetchCatalog } from './util.js';
import { getResults } from './state.svelte.js';
import { looksLikeDomain, resolveBrand } from './resolve.js';
import { picker, runtime, view, entryFor } from './picker-state.svelte.js';
import { addBrand, replaceBrand, brandNameFromDomain } from './picker-brands.js';

const POPOVER_WIDTH = 300;

export async function showAddPopover(anchor, { swapDomain = null } = {}) {
  picker.swapDomain = swapDomain;

  // Anchor to the add button, kept inside the section.
  const sectionRect = runtime.section.getBoundingClientRect();
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(0, Math.min(rect.right - sectionRect.left - POPOVER_WIDTH, sectionRect.width - POPOVER_WIDTH));
  picker.popover = { open: true, top: rect.bottom - sectionRect.top + 8, left };

  await tick();
  view.fitPopoverList();
}

export function hideAddPopover() {
  picker.popover.open = false;
  picker.swapDomain = null;
}

export async function showUrlDialog() {
  // hideAddPopover clears the swap target, so carry it across.
  const swapDomain = picker.swapDomain;
  hideAddPopover();
  picker.swapDomain = swapDomain;
  picker.dialog.open = true;
  picker.dialog.error = '';
  await tick();
  view.focusUrlInput();
}

export function hideUrlDialog() {
  picker.dialog.open = false;
}

export async function submitUrl(typed) {
  const dialog = picker.dialog;
  if (!typed) {
    dialog.error = 'Enter a brand name or website, like graza.co.';
    return;
  }
  if (dialog.busy) return;
  dialog.busy = true;
  dialog.error = '';
  try {
    // A name resolves to its site the way the omnibar does; an address goes straight through.
    let domain = looksLikeDomain(typed) ? extractDomain(typed) : null;
    if (!domain) {
      dialog.label = 'Finding site';
      domain = await resolveBrand(typed);
    }
    if (!domain) {
      dialog.error = `Couldn't find a site for “${typed}”. Enter its web address, like graza.co.`;
      return;
    }
    if (entryFor(domain) && domain !== picker.swapDomain) {
      hideUrlDialog();
      view.scrollToColumn(domain);
      return;
    }
    dialog.label = 'Fetching catalog';
    const catalog = await fetchCatalog(domain);
    if (!catalog.products.length) {
      dialog.error = catalog.status === 'error'
        ? `Couldn't reach ${domain}.`
        : `${domain} has no public catalog to pick from.`;
      return;
    }
    const known = (getResults()?.brands || []).find(b => extractDomain(b.url || '') === domain);
    const brand = known || { name: brandNameFromDomain(domain), url: `https://${domain}`, catalog };
    brand.catalog = catalog;
    const swapDomain = picker.swapDomain;
    hideUrlDialog();
    picker.swapDomain = null;
    if (swapDomain) await replaceBrand(swapDomain, brand);
    else await addBrand(brand);
  } finally {
    dialog.busy = false;
    dialog.label = 'Add brand';
  }
}
