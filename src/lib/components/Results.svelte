<script>
  /**
   * The results state: the searched brand's card, the recommended brands and the footer that asks for more.
   * Cards render from the reactive results, so a catalog or social that lands mid-search shows up
   * on its card; a new search re-keys every card so the staggered entrance plays again.
   */
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import SearchedBrandCard from './SearchedBrandCard.svelte';
  import BrandCard from './BrandCard.svelte';
  import ThreadTurn from './ThreadTurn.svelte';
  import MoreCard from './MoreCard.svelte';
  import { app, getResults } from '$lib/client/state.svelte.js';
  import { extractDomain } from '$lib/client/util.js';
  import { threadOf } from '$lib/shared/search.js';
  import { streamText, createCadence, HEADING_CADENCE } from '$lib/client/actions/stream_text.js';
  import { hideSocialPopover } from '$lib/client/popover.svelte.js';
  import { bindTouchTap } from '$lib/client/actions/touch_tap.js';

  const results = $derived(getResults());
  const brands = $derived(results?.brands || []);
  // The first search's brands, then each follow-up's under its divider. The dividers come from
  // the turns the flow holds (which carry their status); their brands from the list.
  const thread = $derived(threadOf(brands));
  const brandsOf = (id) => thread.turns.find(entry => entry.turn.id === id)?.brands || [];
  const cardKey = (brand, index) => `${app.searchId}:${extractDomain(brand.url || '')}:${index}`;
  // The two lines above the list: the model's for this brand, else the finder's own. They stream
  // in word by word on one clock each time a search lands.
  const heading = $derived(results?.searchedBrand?.listHeading || { title: 'Recommended brands', subtitle: "Here's some great options that would make killer collabs." });
  // Keyed on the lines themselves as well as the search: streaming replaces the text nodes with word
  // spans, so a heading that lands after the mount has to mount again to be seen.
  const headingKey = $derived(`${app.searchId}:${heading.title}:${heading.subtitle}`);
  const cadence = $derived.by(() => { void headingKey; return createCadence(0, HEADING_CADENCE); });

  onMount(() => {
    // On touch, a card's action buttons act on the tap itself.
    const untap = bindTouchTap(document, '.build-bundle-btn, .generate-pitch-btn, .visit-btn, .card-menu-btn');
    // Hide the popover when clicking outside it, or on Escape.
    const onClick = (e) => {
      if (!e.target.closest('.social-popover') && !e.target.closest('.card-menu-btn')) hideSocialPopover();
    };
    const onKey = (e) => { if (e.key === 'Escape') hideSocialPopover(); };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      untap();
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  });
</script>

<section class="results-section" id="resultsSection" class:hidden={app.view !== 'results'}>
  <!-- Searched Brand Card (top) -->
  <div class="results-group" id="searchedBrandGroup">
    <div id="searchedBrandCardContainer">
      {#if results?.searchedBrand}
        {#key app.searchId}
          <SearchedBrandCard brand={results.searchedBrand} />
        {/key}
      {/if}
    </div>
  </div>

  <!-- Brands Section -->
  <div class="results-group">
    {#key headingKey}
      <div class="flex flex-col gap-2">
        <h2 class="results-group-title" use:streamText={cadence}>{heading.title}</h2>
        <h2 class="results-group-title text-content-tertiary" use:streamText={cadence}>{heading.subtitle}</h2>
      </div>
    {/key}
    <div class="results-grid" id="brandsGrid">
      {#each thread.base as brand, index (cardKey(brand, index))}
        <BrandCard {brand} {index} />
      {/each}
      {#each app.turns as turn (turn.id)}
        <ThreadTurn {turn} />
        {#each brandsOf(turn.id) as brand, index (`${turn.id}:${cardKey(brand, index)}`)}
          <BrandCard {brand} {index} />
        {/each}
      {/each}
    </div>
    {#if results}
      <MoreCard />
    {/if}
  </div>

</section>
