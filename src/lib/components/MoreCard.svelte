<script>
  /**
   * Under the last card, centered on the body: the orb, and one tap for more of the same or for a
   * swing. Busy while any follow-up runs, whichever control started it.
   */
  import AgentOrb from './AgentOrb.svelte';
  import { app } from '$lib/client/state.svelte.js';
  import { extendResults } from '$lib/client/search.svelte.js';

  const busy = $derived(!!app.extending);
  // The list is extendable once the search of record exists, not while the catalogs are still landing.
  const ready = $derived(!!app.results && !busy);
</script>

<div class="results-more" class:is-busy={busy}>
  <AgentOrb class="results-more-orb" state={busy ? 'working' : 'idle'} />
  <div class="results-more-actions">
    {#if busy}
      <button type="button" class="btn btn--md btn--ai" disabled aria-busy="true"><span class="ol-loader" aria-hidden="true"></span><span class="text-shimmer-ink">Finding more</span></button>
    {:else}
      <button type="button" class="btn btn--md btn--ai" disabled={!ready} onclick={() => extendResults({ kind: 'more' })}>More like these</button>
      <button type="button" class="btn btn--md btn--secondary" disabled={!ready} onclick={() => extendResults({ kind: 'surprise' })}>Surprise me</button>
    {/if}
  </div>
</div>
