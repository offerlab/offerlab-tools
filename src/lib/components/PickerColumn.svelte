<script>
  /**
   * One brand's catalog column on the rail: its head, a filter, the product tiles, and the gutter
   * handle that resizes it. The catalog picker's flat tile: the artwork is the tile, and the add
   * button is where selection is expressed (plus morphs to check). The whole tile toggles.
   * A brand with no public catalog is on stand-in products: they can be edited, and the grid
   * opens with a tile that adds one.
   */
  import { picker, sellerEntry, productKey } from '$lib/client/picker-state.svelte.js';
  import { money } from '$lib/client/picker-concepts.js';
  import { sellable } from '$lib/client/picker-prompt.js';
  import { getFaviconUrl, catalogThumbUrl } from '$lib/client/util.js';
  import { isStorefrontCatalog } from '$lib/shared/catalog.js';
  import Icon from './Icon.svelte';

  let { entry } = $props();

  const domain = $derived(entry.domain);
  const brand = $derived(entry.brand);
  const catalog = $derived(brand.catalog);
  const isSeller = $derived(domain === sellerEntry()?.domain);
  const filter = $derived((picker.filters[domain] || '').trim().toLowerCase());
  const products = $derived(catalog.products.filter(p => !filter || p.title.toLowerCase().includes(filter)));
  const loadingMore = $derived(isStorefrontCatalog(catalog) && (catalog.truncated || catalog.products.length < catalog.count));
  const removable = $derived(!isSeller && picker.brands.length > 2);
  const standIns = $derived(catalog.status === 'standin');
  const countLabel = $derived(standIns
    ? (catalog.loading ? 'No public catalog · suggesting stand-ins' : `No public catalog · ${catalog.count} stand-in${catalog.count === 1 ? '' : 's'}`)
    : `${catalog.count} products${loadingMore ? ' · loading the rest' : ''}`);
</script>

<div class="picker-column" data-domain={domain}>
  <div class="picker-column-top scrim">
  <div class="picker-column-head">
    <img class="picker-column-favicon" src={getFaviconUrl(domain)} alt="">
    <div class="picker-column-labels">
      <div class="picker-column-name">{brand.name}</div>
      <div class="picker-column-count">{countLabel}</div>
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
    {#if standIns}
      <button type="button" class="picker-product picker-product--new" data-action="new-product" data-domain={domain}>
        <span class="picker-product-art picker-product-new-art"><Icon name="plus-large" size={20} /></span>
        <span class="picker-product-caption">
          <span class="picker-product-title">Add a product</span>
          <span class="picker-product-price">By hand or from a link</span>
        </span>
      </button>
    {/if}
    {#each products as p}
      {@const key = productKey(domain, p.id)}
      {@const selected = picker.selection.has(key)}
      <!-- A product with no price cannot go live in OfferLab, so it cannot be picked: shown, so the
           catalog reads whole, but quiet. (A free add-on is the usual case.) -->
      {@const priced = sellable(p)}
      <div class="picker-product" class:is-selected={selected} class:is-unpriced={!priced} role="button" tabindex={priced ? 0 : -1} aria-pressed={selected} aria-disabled={priced ? undefined : 'true'} data-action={priced ? 'toggle' : undefined} data-domain={domain} data-id={String(p.id)} data-key={key} title={p.title}>
        <div class="picker-product-art media-tile media-hairline">
          {#if p.image}
            <img class="media-zoom" src={catalogThumbUrl(p.image, 320)} alt="" loading="lazy">
          {:else}
            <span class="picker-product-noart"><img src={getFaviconUrl(domain)} alt=""></span>
          {/if}
          {#if p.standIn}
            <button type="button" class="picker-product-edit" data-action="edit-product" data-domain={domain} data-id={String(p.id)} aria-label="Edit {p.title}">Edit</button>
          {/if}
          {#if priced}<span class="picker-product-add" aria-hidden="true"><Icon name="plus-to-check" /></span>{/if}
        </div>
        <div class="picker-product-caption">
          <p class="picker-product-title">{p.title}</p>
          <p class="picker-product-price">{priced ? money(p.price) : 'No price'}</p>
        </div>
      </div>
    {:else}
      {#if !standIns}
        <p class="picker-grid-empty">No products match.</p>
      {:else if catalog.loading}
        <p class="picker-grid-empty"><Icon name="spinner" class="icon-spin" size={14} /> Finding pictures and suggesting products</p>
      {:else if filter}
        <p class="picker-grid-empty">No products match.</p>
      {/if}
    {/each}
  </div>
  <div class="picker-column-resizer-zone">
    <button type="button" class="picker-column-resizer" data-action="resize-column" data-domain={domain}
      role="separator" aria-orientation="vertical" aria-label="Resize the {brand.name} column"><span aria-hidden="true"></span></button>
  </div>
</div>
