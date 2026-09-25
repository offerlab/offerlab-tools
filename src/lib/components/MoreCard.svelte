<script>
  /**
   * The results footer, centered on the body under the last card: the orb, a word, and one row
   * of what to do next: more of the same, a swing, or a rating of what is here. Busy while any
   * follow-up runs, whichever control started it.
   */
  import Icon from './Icon.svelte';
  import AgentOrb from './AgentOrb.svelte';
  import { app } from '$lib/client/state.svelte.js';
  import { extendResults } from '$lib/client/search.svelte.js';
  import { saveFeedback } from '$lib/client/history.svelte.js';

  const busy = $derived(!!app.extending);
  // The list is extendable once the search of record exists, not while the catalogs are still landing.
  const ready = $derived(!!app.results && !busy);

  function rate(rating) {
    if (!app.searchId || !app.results) return;
    saveFeedback(app.searchId, app.searchDomain, app.results.brands || [], rating);
    app.feedback = rating;
  }
</script>

<div class="results-more" class:is-busy={busy}>
  <AgentOrb class="results-more-orb" state={busy ? 'working' : 'idle'} />
  <!-- The same two lines as the group header above the grid, centered. -->
  <div class="flex flex-col gap-2 results-more-copy">
    <h2 class="results-group-title">This collab looks sweet!</h2>
    <h2 class="results-group-title text-content-tertiary">{app.feedback ? 'Thanks for the feedback!' : 'How can I help?'}</h2>
  </div>
  <div class="results-more-actions">
    {#if busy}
      <button type="button" class="btn btn--md btn--secondary" disabled aria-busy="true"><span class="ol-loader" aria-hidden="true"></span><span class="text-shimmer-ink">Finding more</span></button>
    {:else}
      <button type="button" class="btn btn--md btn--secondary" disabled={!ready} onclick={() => extendResults({ kind: 'more' })}>More like these</button>
      <button type="button" class="btn btn--md btn--secondary" disabled={!ready} onclick={() => extendResults({ kind: 'surprise' })}>Surprise me</button>
    {/if}
  </div>
  <div class="results-more-rating" style:pointer-events={app.feedback ? 'none' : 'auto'}>
    <button type="button" class="feedback-btn feedback-positive" class:selected={app.feedback === 'positive'} id="feedbackPositive" aria-label="These results were relevant" onclick={() => rate('positive')}><Icon name="thumb-up" class="feedback-icon" /></button>
    <button type="button" class="feedback-btn feedback-negative" class:selected={app.feedback === 'negative'} id="feedbackNegative" aria-label="These results were not relevant" onclick={() => rate('negative')}><Icon name="thumb-down" class="feedback-icon" /></button>
  </div>
</div>
