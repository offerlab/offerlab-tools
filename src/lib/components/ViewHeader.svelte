<script>
  /**
   * The contextual bar for the search views. Sticks to the top of the sheet, inside it, so the
   * dark bar above stays the one global header. The back button is hidden while a search runs.
   *
   * On a phone the back control and the pill both move into the footer in flow (`#omniFooter`),
   * back first, so the sheet has one sticky bar rather than two and no fixed element fights the
   * browser chrome. The same nodes move between the two homes; the footer carries the view-header
   * class so the pill keeps every rule it has in the bar.
   */
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import Omnibar from './Omnibar.svelte';
  import { app } from '$lib/client/state.svelte.js';
  import { goToLanding } from '$lib/client/search.svelte.js';
  import { isPickerOpen, closePicker } from '$lib/client/picker.svelte.js';

  const visible = $derived(['loading', 'results', 'picker', 'empty', 'error'].includes(app.view));
  const loading = $derived(app.view === 'loading');

  let viewHeader, omniFooter, back, search;
  let phone = $state(false);

  function onBack() {
    if (isPickerOpen()) closePicker();
    else goToLanding();
  }

  function placeOmnibar() {
    const home = phone ? omniFooter : viewHeader;
    for (const part of [back, search]) {
      if (part && part.parentElement !== home) home.appendChild(part);
    }
  }

  onMount(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const sync = () => { phone = media.matches; placeOmnibar(); };
    sync();
    media.addEventListener('change', sync);
    // The bar's height, for what pins under it (the picker's rail), the way the header publishes its own.
    const publish = () => { if (viewHeader.offsetHeight) document.documentElement.style.setProperty('--view-header-h', `${viewHeader.offsetHeight}px`); };
    publish();
    const observer = window.ResizeObserver ? new ResizeObserver(publish) : null;
    observer?.observe(viewHeader);
    return () => { media.removeEventListener('change', sync); observer?.disconnect(); };
  });
</script>

<div class="view-header" class:hidden={!visible} class:view-header--loading={loading} id="viewHeader" bind:this={viewHeader}>
  <div class="flex justify-start header-nav-back-wrapper" bind:this={back}>
    <button type="button" class="icon-button icon-button--medium" id="headerBackBtn" aria-label="Back to search" onclick={onBack}>
      <Icon name="arrow-left" />
    </button>
  </div>
  <div class="header-nav-search" bind:this={search}>
    <div class="search-anchor header-nav-search-anchor">
      <div class="omni-ai-box-container omni-ai-box-container--header">
        <Omnibar variant="results" />
      </div>
    </div>
  </div>
</div>

<!-- The footer shows and loads with the bar; the bar's state is its only source of truth. -->
<div class="view-header omni-footer" class:hidden={!phone || !visible} class:view-header--loading={loading} id="omniFooter" bind:this={omniFooter}></div>
