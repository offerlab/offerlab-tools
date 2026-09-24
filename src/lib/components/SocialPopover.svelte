<script>
  /**
   * The card's "⋯" popover: the brand's social links, and for staff the moderation actions.
   * Positioned by popover.svelte.js relative to the card, so it scrolls with the page.
   */
  import Icon from './Icon.svelte';
  import { app } from '$lib/client/state.svelte.js';
  import { socialEntries } from '$lib/client/social.js';
  import { popover, hideSocialPopover, moderateCard } from '$lib/client/popover.svelte.js';

  let { brand, domain } = $props();

  const socials = $derived(socialEntries(brand.social));

  function onModerate(e, action) {
    e.stopPropagation();
    if (!popover.busy) moderateCard(domain, action);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="social-popover" id="socialPopover" style="top: {popover.top}px; left: {popover.left}px" onclick={(e) => e.stopPropagation()}>
  {#each socials as entry (entry.key)}
    <a href={entry.url} class="social-link" data-platform={entry.key} target="_blank" rel="noopener" title="@{entry.handle}" onclick={hideSocialPopover}>
      <Icon name={entry.icon} class="social-icon" />
      <span>{entry.label}</span>
      <Icon name="arrow-up-right" class="social-link-external" />
    </a>
  {/each}
  {#if app.staff}
    <!-- Staff only. "Wrong products" hides the brand's products everywhere; "Remove from results" drops the brand from this search only. -->
    {#if socials.length > 0}<div class="popover-divider" role="separator"></div>{/if}
    <button type="button" class="social-link moderation-action" data-action="hide-products" disabled={popover.busy} onclick={(e) => onModerate(e, 'hide-products')}>
      <Icon name="eye-slash" class="social-icon" /><span>Wrong products</span>
    </button>
    <button type="button" class="social-link moderation-action" data-action="remove-recommendation" disabled={popover.busy} onclick={(e) => onModerate(e, 'remove-recommendation')}>
      <Icon name="close-x-rounded-remove" class="social-icon" /><span>Remove from results</span>
    </button>
    <p class="moderation-error" hidden={!popover.error}>{popover.error}</p>
  {/if}
</div>
