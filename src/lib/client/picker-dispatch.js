/**
 * One click handler for the picker: every control carries a data-action, and the section and the
 * tray delegate their clicks here.
 */
import { extractDomain } from './util.js';
import { getResults } from './state.svelte.js';
import { picker, view } from './picker-state.svelte.js';
import { toggleProduct, clearSelection, applyConcept } from './picker-selection.js';
import { generateConcepts, cancelConcepts } from './picker-concepts.js';
import { addBrand, replaceBrand, removeBrand } from './picker-brands.js';
import { showAddPopover, hideAddPopover, showUrlDialog } from './picker-add.js';
import { createDraft, cancelDraft } from './picker-draft.js';

export function handleAction(e) {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  switch (target.dataset.action) {
    case 'toggle': toggleProduct(target.dataset.domain, target.dataset.id); break;
    case 'clear': clearSelection(); break;
    case 'suggest': generateConcepts(); break;
    case 'cancel': cancelConcepts(); break;
    case 'apply-concept': applyConcept(Number(target.dataset.index)); break;
    // Creating the draft on ShopTalk arrives with OL-3986; until then it loads the concept.
    case 'create-concept': {
      const index = Number(target.dataset.index);
      applyConcept(index);
      createDraft(picker.concepts[index]?.name);
      break;
    }
    case 'create-bundle': createDraft(); break;
    case 'stop-bundling': cancelDraft(); break;
    case 'open-draft':
      if (picker.draft.url) window.open(picker.draft.url, '_blank', 'noopener');
      break;
    case 'toggle-minimize': view.toggleMinimize(); break;
    case 'rail-prev': view.scrollRail(-1); break;
    case 'rail-next': view.scrollRail(1); break;
    case 'add-brand':
      e.stopPropagation();
      if (!picker.popover.open) showAddPopover(target.querySelector('.picker-add-btn') || target); else hideAddPopover();
      break;
    case 'pick-brand': {
      const brand = (getResults()?.brands || []).find(b => extractDomain(b.url || '') === target.dataset.domain);
      const swapDomain = picker.swapDomain;
      hideAddPopover();
      if (!brand) break;
      if (swapDomain) replaceBrand(swapDomain, brand);
      else addBrand(brand);
      break;
    }
    case 'swap-brand':
      e.stopPropagation();
      if (!picker.popover.open || picker.swapDomain !== target.dataset.domain) {
        showAddPopover(target, { swapDomain: target.dataset.domain });
      } else {
        hideAddPopover();
      }
      break;
    case 'add-url': showUrlDialog(); break;
    case 'remove-brand': removeBrand(target.dataset.domain); break;
  }
}
