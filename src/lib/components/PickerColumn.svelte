<script>
  /**
   * One brand's catalog column on the rail: its head, a filter, the product tiles, and the gutter
   * handle that resizes it. The catalog picker's flat tile: the artwork is the tile, and the add
   * button is where selection is expressed (plus morphs to check). The whole tile toggles.
   */
  import { picker, sellerEntry, productKey } from '$lib/client/picker-state.svelte.js';
  import { money } from '$lib/client/picker-concepts.js';
  import { getFaviconUrl, catalogThumbUrl } from '$lib/client/util.js';
  import Icon from './Icon.svelte';

  let { entry } = $props();

  const domain = $derived(entry.domain);
  const brand = $derived(entry.brand);
  const catalog = $derived(brand.catalog);
  const isSeller = $derived(domain === sellerEntry()?.domain);
  const filter = $derived((picker.filters[domain] || '').trim().toLowerCase());
  const products = $derived(catalog.products.filter(p => !filter || p.title.toLowerCase().includes(filter)));
  const loadingMore = $derived(catalog.status === 'shopify' && (catalog.truncated || catalog.products.length < catalog.count));
  const removable = $derived(!isSeller && picker.brands.length > 2);
</script>

<div class="picker-column" data-domain={domain}>
  <div class="picker-column-top scrim">
  <div class="picker-column-head">
    <img class="picker-column-favicon" src={getFaviconUrl(domain)} alt="">
    <div class="picker-column-labels">
      <div class="picker-column-name">{brand.name}</div>
      <div class="picker-column-count">{catalog.count} products{loadingMore ? ' · loading the rest' : ''}</div>
    </div>
    <button type="button" class="picker-column-action has-tooltip" data-action="swap-brand" data-domain={domain} aria-label="Switch {brand.name} for another brand" aria-haspopup="true">
      <Icon name="arrow-rotate-right-left" size={16} />
      <span class="tooltip tooltip--end" aria-hidden="true">Switch brand</span>
    </button>
    {#if removable}<button type="button" class="picker-column-action" data-action="remove-brand" data-domain={domain} aria-label="Remove {brand.name}"><Icon name="cross-large" size={16} /></button>{/if}
  </div>
  <div class="picker-column-filter">
    <input type="search" class="picker-filter" data-domain={domain} placeholder="Filter products" bind:value={picker.filters[domain]} aria-label="Filter {brand.name} products">
  </div>
  </div>
  <div class="picker-grid">
    {#each products as p}
      {@const key = productKey(domain, p.id)}
      {@const selected = picker.selection.has(key)}
      <div class="picker-product" class:is-selected={selected} role="button" tabindex="0" aria-pressed={selected} data-action="toggle" data-domain={domain} data-id={String(p.id)} data-key={key} title={p.title}>
        <div class="picker-product-art media-tile media-hairline">
          <img class="media-zoom" src={catalogThumbUrl(p.image, 320)} alt="" loading="lazy">
          <span class="picker-product-add" aria-hidden="true"><Icon name="plus-to-check" /></span>
        </div>
        <div class="picker-product-caption">
          <p class="picker-product-title">{p.title}</p>
          <p class="picker-product-price">{p.price !== null && p.price !== undefined ? money(p.price) : 'Price varies'}</p>
        </div>
      </div>
    {:else}
      <p class="picker-grid-empty">No products match.</p>
    {/each}
  </div>
  <div class="picker-column-resizer-zone">
    <button type="button" class="picker-column-resizer" data-action="resize-column" data-domain={domain}
      role="separator" aria-orientation="vertical" aria-label="Resize the {brand.name} column"><span aria-hidden="true"></span></button>
  </div>
</div>
