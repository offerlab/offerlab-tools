<script>
  /**
   * The add-brand popover: a brand by URL, then every recommended brand with a catalog that is
   * not already on the rail. Opened from the add column, or from a column head to swap it.
   */
  import { picker, runtime, view, entryFor } from '$lib/client/picker-state.svelte.js';
  import { addableBrands } from '$lib/client/picker-brands.js';
  import { extractDomain, getFaviconUrl } from '$lib/client/util.js';
  import Icon from './Icon.svelte';

  // Show as much of the list as the viewport allows below the anchor, never past its bottom edge.
  function popoverLayer(node) {
    runtime.popover = node;
    view.fitPopoverList = () => {
      const list = node.querySelector('.picker-add-list');
      if (!list) return;
      const listTop = list.getBoundingClientRect().top;
      const available = window.innerHeight - listTop - 24;
      list.style.maxHeight = `${Math.max(240, Math.min(480, available))}px`;
    };
    return {
      destroy() {
        view.fitPopoverList = () => {};
        runtime.popover = null;
      }
    };
  }
</script>

<div class="picker-add-popover" id="pickerAddPopover" role="menu" class:hidden={!picker.popover.open} style:top="{picker.popover.top}px" style:left="{picker.popover.left}px" use:popoverLayer>
  {#if picker.popover.open}
    {@const swapping = !!picker.swapDomain}
    {@const brands = addableBrands()}
    {#if swapping}<p class="picker-add-heading">Switch {entryFor(picker.swapDomain)?.brand.name || 'this brand'} for</p>{/if}
    <button type="button" class="picker-add-row picker-add-row--url" data-action="add-url">
      <span class="picker-add-row-icon"><Icon name="link-3-chain" size={16} /></span>
      <span class="picker-add-row-labels"><span class="picker-add-row-name">{swapping ? 'Use a brand URL' : 'Add a brand by URL'}</span></span>
    </button>
    {#if brands.length > 0}
      <div class="picker-add-divider"></div>
      <div class="picker-add-list scrim-mask-y">
        {#each brands as b}
          {@const domain = extractDomain(b.url || '')}
          <button type="button" class="picker-add-row" data-action="pick-brand" data-domain={domain}>
            <img class="picker-add-row-favicon" src={getFaviconUrl(domain)} alt="">
            <span class="picker-add-row-labels">
              <span class="picker-add-row-name">{b.name}</span>
              <span class="picker-add-row-meta">{b.catalog.count} products</span>
            </span>
          </button>
        {/each}
      </div>
    {:else}
      <p class="picker-add-empty">Every recommended brand with a catalog is already here.</p>
    {/if}
  {/if}
</div>
