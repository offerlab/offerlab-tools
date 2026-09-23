/**
 * The picker's selection: products toggled across the columns, or loaded from a concept.
 */
import { picker, productKey, findProduct } from './picker-state.svelte.js';
import { sellable } from './picker-prompt.js';

// A finished or failed draft belongs to the selection it was made from.
function afterSelectionChange() {
  if (picker.draft.status !== 'working' && picker.draft.status !== 'idle') picker.draft = { status: 'idle', message: '', url: null };
}

export function toggleProduct(domain, id) {
  const key = productKey(domain, id);
  if (picker.selection.has(key)) {
    picker.selection.delete(key);
  } else {
    const product = findProduct(domain, id);
    if (!product || !sellable(product)) return;
    picker.selection.set(key, { domain, product, sequence: picker.sequence++ });
  }
  if (picker.activeConcept >= 0) syncActiveConceptToSelection();
  afterSelectionChange();
}

export function clearSelection() {
  picker.selection.clear();
  picker.activeConcept = -1;
  afterSelectionChange();
}

export function applyConcept(index) {
  const concept = picker.concepts[index];
  if (!concept) return;
  picker.selection.clear();
  concept.picks.forEach(({ domain, product }) => {
    picker.selection.set(productKey(domain, product.id), { domain, product, sequence: picker.sequence++ });
  });
  picker.activeConcept = index;
  afterSelectionChange();
}

function syncActiveConceptToSelection() {
  const concept = picker.concepts[picker.activeConcept];
  if (!concept) return;
  concept.picks = [...picker.selection.values()].map(s => ({ domain: s.domain, product: s.product }));
  concept.edited = true;
}
