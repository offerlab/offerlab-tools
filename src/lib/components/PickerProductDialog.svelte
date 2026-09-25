<script>
  /**
   * The dialog that adds or edits a stand-in product for a brand with no public catalog: a name, a
   * price and a picture, typed in or filled from a product link. Lives on body, so its listeners
   * are attached here rather than delegated from the app root.
   */
  import { picker, view, entryFor } from '$lib/client/picker-state.svelte.js';
  import { hideProductDialog, saveProduct, removeProduct, fillFromLink, pickPicture, dialogPictures } from '$lib/client/picker-standins.js';
  import { catalogThumbUrl } from '$lib/client/util.js';
  import { portal } from '$lib/client/actions/portal.js';
  import Icon from './Icon.svelte';

  const dialog = $derived(picker.productDialog);
  const brandName = $derived(entryFor(dialog.domain)?.brand.name || 'This brand');
  const pictures = $derived(dialog.open ? dialogPictures() : []);

  function dialogEvents(form) {
    const onSubmit = (e) => {
      e.preventDefault();
      saveProduct();
    };
    const onClick = (e) => {
      const target = e.target.closest('[data-action]');
      if (e.target === form || target?.dataset.action === 'close-dialog') hideProductDialog();
      else if (target?.dataset.action === 'fill-from-link') fillFromLink();
      else if (target?.dataset.action === 'pick-picture') pickPicture(target.dataset.src);
      else if (target?.dataset.action === 'remove-product') removeProduct();
    };
    // Enter in the link field reads the link rather than saving the product.
    const onKeydown = (e) => {
      if (e.key === 'Enter' && e.target.name === 'link') {
        e.preventDefault();
        fillFromLink();
      }
    };
    form.addEventListener('submit', onSubmit);
    form.addEventListener('click', onClick);
    form.addEventListener('keydown', onKeydown);
    view.focusProductInput = () => form.querySelector(picker.productDialog.id ? 'input[name="title"]' : 'input[name="link"]')?.focus();
    return {
      destroy() {
        form.removeEventListener('submit', onSubmit);
        form.removeEventListener('click', onClick);
        form.removeEventListener('keydown', onKeydown);
        view.focusProductInput = () => {};
      }
    };
  }
</script>

<form class="dialog-backdrop picker-product-dialog" id="pickerProductDialog" class:hidden={!dialog.open} novalidate use:portal use:dialogEvents>
  <div class="dialog picker-product-modal" role="dialog" aria-modal="true" aria-labelledby="pickerProductHeading">
    <div class="dialog-header">
      <h2 class="dialog-heading" id="pickerProductHeading">{dialog.id ? 'Edit product' : 'Add a product'}</h2>
      <button type="button" class="dialog-close" data-action="close-dialog" aria-label="Close"><Icon name="cross-large" size={16} /></button>
    </div>
    <div class="dialog-body">
      <p class="picker-product-lede">{brandName} has no public catalog, so this is a stand-in. It shows what a bundle would look like, and becomes a real product in OfferLab when the bundle is built.</p>
      <div class="picker-product-link">
        <div class="floating-input">
          <input type="url" name="link" id="pickerProductLink" class="floating-input-field" placeholder="https://…" autocomplete="off" autocapitalize="off" spellcheck="false" bind:value={picker.productDialog.link}>
          <label class="floating-label" for="pickerProductLink">Product link (optional)</label>
        </div>
        <button type="button" class="btn btn--lg btn--overlay" data-action="fill-from-link" disabled={dialog.busy || !dialog.link.trim()}>
          {#if dialog.busy}<Icon name="spinner" class="icon-spin" size={16} />{:else}<Icon name="link-3-chain" size={16} />{/if} Fill in
        </button>
      </div>
      <p class="picker-product-note" role="status">{dialog.note}</p>
      <div class="picker-product-fields">
        <div class="floating-input">
          <input type="text" name="title" id="pickerProductTitle" class="floating-input-field" placeholder="Signature product" autocomplete="off" bind:value={picker.productDialog.title}>
          <label class="floating-label" for="pickerProductTitle">Name</label>
        </div>
        <div class="floating-input picker-product-price-field">
          <input type="text" name="price" id="pickerProductPrice" class="floating-input-field" placeholder="700" inputmode="decimal" autocomplete="off" bind:value={picker.productDialog.price}>
          <label class="floating-label" for="pickerProductPrice">Price ($)</label>
        </div>
      </div>
      <div class="picker-product-pictures" role="group" aria-label="Picture">
        {#each pictures as picture (picture.src)}
          <button type="button" class="picker-product-picture media-tile media-hairline" class:is-selected={dialog.image === picture.src} data-action="pick-picture" data-src={picture.src} aria-pressed={dialog.image === picture.src} title={picture.alt || ''}>
            <img src={catalogThumbUrl(picture.src, 200)} alt={picture.alt || ''} loading="lazy">
          </button>
        {:else}
          <p class="picker-product-pictures-empty">No pictures were found for {brandName}. Paste a picture's address below.</p>
        {/each}
      </div>
      <div class="floating-input">
        <input type="url" name="image" id="pickerProductImage" class="floating-input-field" placeholder="https://…/picture.jpg" autocomplete="off" autocapitalize="off" spellcheck="false" bind:value={picker.productDialog.image}>
        <label class="floating-label" for="pickerProductImage">Picture address</label>
      </div>
      <p class="picker-url-error" role="alert">{dialog.error}</p>
    </div>
    <div class="dialog-actions">
      {#if dialog.id}<button type="button" class="btn btn--lg btn--overlay" data-action="remove-product">Remove</button>{/if}
      <button type="button" class="btn btn--lg btn--overlay" data-action="close-dialog">Cancel</button>
      <button type="submit" class="btn btn--lg btn--primary">{dialog.id ? 'Save' : 'Add product'}</button>
    </div>
  </div>
</form>
