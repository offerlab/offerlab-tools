<script>
  /**
   * The results state: the searched brand's card, the recommended brands and the feedback prompt.
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
  import { saveFeedback } from '$lib/client/history.svelte.js';
  import { hideSocialPopover } from '$lib/client/popover.svelte.js';
  import { bindTouchTap } from '$lib/client/actions/touch_tap.js';

  const results = $derived(getResults());
  const brands = $derived(results?.brands || []);
  // The first search's brands, then each follow-up's under its divider. The dividers come from
  // the turns the flow holds (which carry their status); their brands from the list.
  const thread = $derived(threadOf(brands));
  const brandsOf = (id) => thread.turns.find(entry => entry.turn.id === id)?.brands || [];
  const cardKey = (brand, index) => `${app.searchId}:${extractDomain(brand.url || '')}:${index}`;

  function rate(rating) {
    if (!app.searchId || !app.results) return;
    saveFeedback(app.searchId, app.searchDomain, app.results.brands || [], rating);
    app.feedback = rating;
  }

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
    <div class="flex flex-col gap-2">
      <h2 class="results-group-title">
        Recommended brands
      </h2>
      <h2 class="results-group-title text-content-tertiary">
        Here's some great options that would make killer collabs.
      </h2>
    </div>
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

  <!-- Feedback Section -->
  <div class="feedback-section" id="feedbackSection" style:pointer-events={app.feedback ? 'none' : 'auto'}>
    <p class="feedback-question">How relevant were these results?</p>
    <div class="feedback-buttons">
      <button class="feedback-btn feedback-positive" class:selected={app.feedback === 'positive'} id="feedbackPositive" data-rating="positive" onclick={() => rate('positive')}>
        <Icon name="thumb-up" class="feedback-icon" />
      </button>
      <button class="feedback-btn feedback-negative" class:selected={app.feedback === 'negative'} id="feedbackNegative" data-rating="negative" onclick={() => rate('negative')}>
        <Icon name="thumb-down" class="feedback-icon" />
      </button>
    </div>
    <p class="feedback-thanks" class:hidden={!app.feedback} id="feedbackThanks">Thanks for your feedback!</p>
  </div>
</section>
