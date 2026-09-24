<script>
  /**
   * A recommended brand: favicon, name, its catalog strip, why it fits, and the actions. The card
   * itself opens the picker when the brand can be built with, else the brand's site. The "⋯" menu
   * shows for a brand with social links, or always for staff, who moderate from it.
   */
  import Icon from './Icon.svelte';
  import CatalogThumbs from './CatalogThumbs.svelte';
  import CatalogChinstrap from './CatalogChinstrap.svelte';
  import SocialPopover from './SocialPopover.svelte';
  import { app } from '$lib/client/state.svelte.js';
  import { extractDomain, fullUrlOf, getFaviconUrl, faviconFallback } from '$lib/client/util.js';
  import { hasAnySocialLink } from '$lib/client/social.js';
  import { notSetUp } from '$lib/client/search.svelte.js';
  import { popover, showSocialPopover } from '$lib/client/popover.svelte.js';
  import { openPicker, canBuildWith } from '$lib/client/picker.svelte.js';
  import { openPitchModal } from '$lib/client/pitch.svelte.js';

  let { brand, index = 0 } = $props();

  const domain = $derived(extractDomain(brand?.url || ''));
  const fullUrl = $derived(fullUrlOf(brand?.url || ''));
  const buildable = $derived(canBuildWith(brand));
  const showMenu = $derived(hasAnySocialLink(brand.social) || app.staff);
  const bullets = $derived(Array.isArray(brand.reasons) ? brand.reasons.filter(Boolean) : []);
  const popoverOpen = $derived(popover.domain === domain);

  function visit() {
    window.open(fullUrl, '_blank', 'noopener,noreferrer');
  }

  function onCardClick(e) {
    if (e.target.closest('.card-menu-btn') || e.target.closest('.card-actions') || e.target.closest('.social-popover')) return;
    if (buildable && openPicker(brand)) return;
    if (fullUrl && fullUrl !== '#') visit();
  }

  function onMenu(e) {
    e.stopPropagation();
    showSocialPopover(e.currentTarget, domain);
  }

  function onBuild(e) {
    e.stopPropagation();
    openPicker(brand);
  }

  function onPitch(e) {
    e.stopPropagation();
    openPitchModal(brand);
  }

  function onVisit(e) {
    e.stopPropagation();
    visit();
  }
</script>

<div class="result-card-group" style="animation-delay: {index * 0.05}s" data-catalog-domain={domain}>
  <!-- The whole card is a target, as it always was; its buttons carry the keyboard path. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="result-card" class:popover-open={popoverOpen} data-url={fullUrl} data-domain={domain} data-buildable={buildable ? 'true' : undefined} data-set-up={notSetUp[domain] ? 'false' : undefined} onclick={onCardClick}>
    <div class="card-header-wrapper">
      <div class="card-header">
        <img src={getFaviconUrl(domain)} alt={brand.name} class="card-favicon" onerror={faviconFallback}>
        <div class="card-info">
          <div class="card-name">{brand.name}</div>
          <div class="card-url">{domain}{#if notSetUp[domain]}<span class="card-not-set-up" title="No team in the demo environment yet. Creating a bundle will set one up first, which takes a moment.">Not set up</span>{/if}</div>
        </div>
        <button class="card-menu-btn" class:hidden={!showMenu} aria-label="More options" onclick={onMenu}>
          <Icon name="dot-grid-1x3-horizontal" class="card-menu-icon" />
        </button>
      </div>
      <div class="card-catalog-slot"><CatalogThumbs catalog={brand.catalog} /></div>
    </div>
    <div class="card-body">
      {#if bullets.length}
        <div class="card-reason-bubble"><ul class="card-reason">{#each bullets as text}<li class="card-reason-item">{text}</li>{/each}</ul></div>
      {:else if brand.reason}
        <!-- A cached result may still carry the old paragraph. -->
        <div class="card-reason-bubble"><p class="card-reason card-reason--prose">{brand.reason}</p></div>
      {/if}
      <div class="card-actions">
        <button type="button" class="btn btn--md btn--primary build-bundle-btn" class:hidden={!buildable} onclick={onBuild}>Create bundle</button>
        <div class="generate-pitch-wrapper">
          <button type="button" class="btn btn--md btn--secondary generate-pitch-btn" onclick={onPitch}>Pitch them</button>
        </div>
        <button type="button" class="btn btn--md btn--secondary btn--icon visit-btn has-tooltip" data-url={fullUrl} aria-label="Visit {brand.name}" onclick={onVisit}>
          <Icon name="square-arrow-top-right-2" />
          <span class="tooltip" aria-hidden="true">Visit {brand.name}</span>
        </button>
      </div>
    </div>
    {#if popoverOpen}
      <SocialPopover {brand} {domain} />
    {/if}
  </div>
  <CatalogChinstrap catalog={brand.catalog} />
</div>
