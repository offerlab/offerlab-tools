<script>
  /**
   * The chinstrap tucked under a card: source on the left, product count on the right. Only while
   * the catalog is loading or once it has products; a brand without one gets no strip. The
   * searched card's `none` variant says the picker leads with a partner instead.
   */
  import Icon from './Icon.svelte';

  const CATALOG_SOURCES = {
    shopify: { label: 'Shopify', icon: 'shopify' },
    woocommerce: { label: 'WooCommerce', icon: 'woocommerce' },
    serp: { label: 'Google Shopping', icon: 'google' }
  };

  let { catalog, radius = 32, variant = 'card' } = $props();

  const n = $derived(catalog ? (catalog.count || (catalog.products || []).length) : 0);
  const meta = $derived(CATALOG_SOURCES[catalog?.status] || CATALOG_SOURCES.serp);
</script>

{#if variant === 'none'}
  <div class="tuck-banner tuck-banner--chinstrap card-chinstrap card-chinstrap--none" style="--tuck-radius: {radius}px">
    <span class="card-chinstrap-source"><Icon name="cross-large" size={12} /> No public catalog</span>
    <span class="card-chinstrap-count">Bundles start from the partner you pick</span>
    <div class="tuck-banner__notch tuck-banner__notch--left"></div>
    <div class="tuck-banner__notch tuck-banner__notch--right"></div>
  </div>
{:else if !catalog}
  <div class="tuck-banner tuck-banner--chinstrap card-chinstrap card-chinstrap--loading" style="--tuck-radius: {radius}px">
    <span class="card-chinstrap-source"><Icon name="spinner" class="icon-spin" size={14} /> Checking catalog</span>
    <span class="card-chinstrap-count"></span>
    <div class="tuck-banner__notch tuck-banner__notch--left"></div>
    <div class="tuck-banner__notch tuck-banner__notch--right"></div>
  </div>
{:else if n > 0}
  <div class="tuck-banner tuck-banner--chinstrap card-chinstrap card-chinstrap--{catalog.status}" style="--tuck-radius: {radius}px">
    <span class="card-chinstrap-source"><Icon name={meta.icon} size={14} /> {meta.label}</span>
    <span class="card-chinstrap-count">{n} {n === 1 ? 'product' : 'products'}</span>
    <div class="tuck-banner__notch tuck-banner__notch--left"></div>
    <div class="tuck-banner__notch tuck-banner__notch--right"></div>
  </div>
{/if}
