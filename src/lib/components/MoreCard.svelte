<script>
  /**
   * The last tile in the results grid: one tap for more of the same, one for a swing. Busy while
   * any follow-up runs, whichever control started it.
   */
  import Icon from './Icon.svelte';
  import { app } from '$lib/client/state.svelte.js';
  import { extendResults } from '$lib/client/search.svelte.js';

  const busy = $derived(!!app.extending);
  // The list is extendable once the search of record exists, not while the catalogs are still landing.
  const ready = $derived(!!app.results && !busy);
</script>

<div class="result-card-group more-card-group">
  <div class="result-card more-card">
    <div class="more-card-body">
      <span class="more-card-icon"><Icon name="ai-sparkles-two-filled" size={24} /></span>
      <div class="more-card-title">Want more?</div>
      <p class="more-card-text">Keep going in the same spirit, or take a swing. Or type a note above to steer.</p>
    </div>
    <div class="card-actions more-card-actions">
      {#if busy}
        <button type="button" class="btn btn--md btn--ai" disabled aria-busy="true"><span class="ol-loader" aria-hidden="true"></span><span class="text-shimmer-ink">Finding more</span></button>
      {:else}
        <button type="button" class="btn btn--md btn--ai" disabled={!ready} onclick={() => extendResults({ kind: 'more' })}>More like these</button>
        <button type="button" class="btn btn--md btn--secondary" disabled={!ready} onclick={() => extendResults({ kind: 'surprise' })}>Surprise me</button>
      {/if}
    </div>
  </div>
</div>
