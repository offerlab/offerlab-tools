<script>
  /**
   * The searched brand's card at the top of the results: cover, favicon, name, description and
   * its catalog strip. The whole card is the link, so the visit control is a span. A site with no
   * og:image gets its first product as the cover once the catalog is in.
   */
  import Icon from './Icon.svelte';
  import CatalogThumbs from './CatalogThumbs.svelte';
  import CatalogChinstrap from './CatalogChinstrap.svelte';
  import { extractDomain, fullUrlOf, getFaviconUrl, catalogThumbUrl } from '$lib/client/util.js';

  let { brand } = $props();

  const domain = $derived(extractDomain(brand?.url || ''));
  const fullUrl = $derived(fullUrlOf(brand?.url || ''));
  const catalogCover = $derived(brand.catalog?.products?.find(p => p.image)?.image || null);
  const cover = $derived(brand.imageUrl || (catalogCover ? catalogThumbUrl(catalogCover, 900) : ''));
  // No cover yet: the column waits, hidden, for the catalog's first product image.
  const imgSrc = $derived(cover || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E");
  const hasProducts = $derived((brand.catalog?.products?.length || 0) > 0);
  let faviconSrc = $state(null);
  const favicon = $derived(faviconSrc || brand.faviconUrl || getFaviconUrl(domain));
</script>

<div class="searched-brand-card-group" data-catalog-domain={domain}>
  <a class="searched-brand-card" href={fullUrl} target="_blank" rel="noopener noreferrer" data-url={fullUrl}>
    <div class="searched-brand-card-image" class:no-image={!cover}>
      <img src={imgSrc} alt={brand.name} loading="eager">
    </div>
    <div class="searched-brand-card-content">
      <div class="searched-brand-card-main">
        <div class="searched-brand-card-header">
          <img src={favicon} alt={brand.name} class="searched-brand-card-favicon" onerror={() => { if (!faviconSrc) faviconSrc = getFaviconUrl(domain); }}>
          <div class="searched-brand-card-info">
            <div class="searched-brand-card-name">{brand.name}</div>
            <div class="searched-brand-card-url">{domain}</div>
          </div>
          <div class="searched-brand-card-link-slot">
            <!-- The platform mark (when known) beside the external-link icon, styled as an elevated button. -->
            <span class="btn btn--md btn--secondary searched-brand-card-link" aria-hidden="true">
              {#if brand.catalog?.status === 'shopify'}<span class="searched-brand-card-link-ghost"><Icon name="shopify" class="searched-brand-card-link-platform" size={18} /></span>{/if}<span class="searched-brand-card-link-ghost searched-brand-card-link-ghost--external"><Icon name="square-arrow-top-right-2" /></span>
            </span>
          </div>
        </div>
        <p class="searched-brand-card-description">{brand.description}</p>
        <div class="card-catalog-slot"><CatalogThumbs catalog={brand.catalog} /></div>
      </div>
    </div>
  </a>
  {#if brand.catalog && !hasProducts}
    <CatalogChinstrap variant="none" radius={36} />
  {/if}
</div>
