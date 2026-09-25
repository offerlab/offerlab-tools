<script>
  /**
   * A follow-up's divider in the results grid: the note (or the "more"/"surprise" label) as the
   * person's line in the thread, and under it what the agent is doing, or what came of it.
   */
  import Icon from './Icon.svelte';
  import { app } from '$lib/client/state.svelte.js';
  import { retryTurn } from '$lib/client/search.svelte.js';

  let { turn } = $props();

  const pending = $derived(turn.status === 'pending');
  const own = $derived(turn.kind === 'note');
</script>

<div class="thread-turn" id="turn-{turn.id}" class:is-pending={pending} role="separator" aria-label={turn.text}>
  <div class="thread-turn-line">
    <span class="thread-turn-note" class:thread-turn-note--ask={!own}>
      {#if own}
        <span class="thread-turn-who">You</span>
      {:else}
        <Icon name="ai-sparkles-two-filled" size={14} />
      {/if}
      <span class="thread-turn-text">{turn.text}</span>
    </span>
  </div>
  {#if pending}
    <p class="thread-turn-status" aria-live="polite"><span class="ol-loader" aria-hidden="true"></span><span class="text-shimmer-ink">{app.extendingText || 'Finding more brands...'}</span></p>
  {:else if turn.status === 'empty'}
    <p class="thread-turn-status">Nothing new came back for that. Try another angle.</p>
  {:else if turn.status === 'failed'}
    <p class="thread-turn-status thread-turn-status--failed">
      <span>Couldn't add more. {turn.error}</span>
      <button type="button" class="btn btn--md btn--secondary" onclick={() => retryTurn(turn.id)}>Try again</button>
    </p>
  {/if}
</div>
