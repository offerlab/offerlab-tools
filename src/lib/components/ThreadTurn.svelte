<script>
  /**
   * A follow-up's divider in the results grid: a short label for the round (the agent's, for a
   * note; the control's name otherwise), and under it what the agent is doing, or what came of it.
   */
  import Icon from './Icon.svelte';
  import { app } from '$lib/client/state.svelte.js';
  import { retryTurn } from '$lib/client/search.svelte.js';

  let { turn } = $props();

  const pending = $derived(turn.status === 'pending');
</script>

<!-- A note's line is the note while the round runs, then the agent's label for what it added. -->
<div class="thread-turn" id="turn-{turn.id}" class:is-pending={pending} role="separator" aria-label={turn.text} title={turn.note && turn.note !== turn.text ? turn.note : undefined}>
  <div class="thread-turn-line">
    <span class="thread-turn-note">
      {#if turn.kind !== 'note'}<Icon name="ai-sparkles-two-filled" size={16} />{/if}
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
