<script>
  /**
   * The thumbnail row inside a card: what a brand sells, from its public catalog. Loading shows a
   * shimmer; no products shows nothing. Past the row, the last tile blurs over its image and
   * carries the count it stands in for.
   */
  import { catalogThumbUrl } from '$lib/client/util.js';

  const CATALOG_THUMBS = 5;

  let { catalog } = $props();

  const products = $derived(catalog?.products || []);
  const count = $derived(catalog?.count || products.length);
  const shown = $derived(products.slice(0, CATALOG_THUMBS));
  const overflow = $derived(count > CATALOG_THUMBS ? count - (CATALOG_THUMBS - 1) : 0);
  // A thumbnail whose image failed drops out of the row, as the original's onerror removed it.
  let failed = $state({});
</script>

{#if !catalog}
  <div class="card-catalog card-catalog--loading">
    <div class="card-catalog-thumbs">
      <div class="card-catalog-thumb"></div><div class="card-catalog-thumb"></div><div class="card-catalog-thumb"></div><div class="card-catalog-thumb"></div>
    </div>
  </div>
{:else if products.length > 0}
  <div class="card-catalog card-catalog--{catalog.status}">
    <div class="card-catalog-thumbs">
      {#each shown as product, i (product.id ?? i)}
        {@const more = overflow && i === shown.length - 1}
        {#if !failed[i]}
          <div class="card-catalog-thumb media-tile media-hairline" class:card-catalog-thumb--more={more} title={product.title}>
            <img class="media-zoom" src={catalogThumbUrl(product.image, 240)} alt="" loading="lazy" onerror={() => { failed[i] = true; }}>
            {#if more}<span class="card-catalog-thumb-count">+{overflow}</span>{/if}
          </div>
        {/if}
      {/each}
    </div>
  </div>
{/if}
