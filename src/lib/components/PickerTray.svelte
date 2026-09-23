<script>
  /**
   * The floating selection tray: the last few picks, a count, the brands (or the draft's
   * progress) and the handoff button. Lives on body, so it positions against the viewport.
   */
  import { picker, entryFor, productKey } from '$lib/client/picker-state.svelte.js';
  import { session } from '$lib/client/account.svelte.js';
  import { handleAction } from '$lib/client/picker-dispatch.js';
  import { catalogThumbUrl } from '$lib/client/util.js';
  import { portal } from '$lib/client/actions/portal.js';
  import { delegateActions } from '$lib/client/actions/delegate_actions.js';
  import Icon from './Icon.svelte';

  const TRAY_THUMBS = 3;
  // A thumb's tilt is fixed by its selection sequence, so the pile never rearranges itself.
  const THUMB_TILTS = [{ rotate: 10, shift: 2 }, { rotate: -10, shift: -2 }, { rotate: 0, shift: 0 }];

  const picks = $derived([...picker.selection.values()].sort((a, b) => a.sequence - b.sequence));
  const count = $derived(picks.length);
  // Brands with picks, in the order they were first picked: "Our Place × Graza"
  const split = $derived.by(() => {
    const firstPick = new Map();
    picks.forEach(p => { if (!firstPick.has(p.domain)) firstPick.set(p.domain, p.sequence); });
    return [...firstPick.keys()].map(domain => entryFor(domain)?.brand.name || domain).join(' × ');
  });
  const thumbs = $derived(picks.slice(-TRAY_THUMBS).map(pick => ({
    pick,
    key: productKey(pick.domain, pick.product.id),
    tilt: THUMB_TILTS[pick.sequence % THUMB_TILTS.length]
  })));

  // The brand line doubles as the progress line: while a draft is being created there is nothing
  // the operator needs from it, and it is the one place in the pill with room for a sentence.
  const note = $derived.by(() => {
    const { status, message } = picker.draft;
    if (status === 'working') return `${message}…`;
    if (status === 'error' || status === 'pending') return message;
    if (status === 'done') return `Opened ${message} in OfferLab`;
    return split;
  });

  const primary = $derived.by(() => {
    const { status } = picker.draft;
    if (status === 'working') return 'working';
    if (status === 'done') return 'done';
    if (session.enabled && !session.connected) return 'connect';
    // Connected, but without developer access there is nothing behind this button. Null means the
    // role has not come back yet, which is not the same as no.
    if (session.enabled && session.canCreateDrafts === false) return null;
    return status === 'error' ? 'retry' : 'create';
  });
</script>

<div class="picker-tray" id="pickerTray" class:is-visible={count > 0} aria-hidden={count === 0 ? 'true' : 'false'} use:portal use:delegateActions={handleAction}>
  {#if count > 0}
    <div class="picker-tray-pill">
      <div class="picker-tray-thumbs">{#each thumbs as { pick, key, tilt } (key)}<div class="picker-tray-thumb media-tile media-hairline" data-key={key} style="transform: translateX({tilt.shift}px) rotate({tilt.rotate}deg)" title={pick.product.title}><img src={catalogThumbUrl(pick.product.image, 96)} alt=""></div>{/each}</div>
      <div class="picker-tray-summary">
        <strong>{count} {count === 1 ? 'product' : 'products'}</strong>
        <span class:picker-tray-problem={picker.draft.status === 'error'}>{note}</span>
      </div>
      <div class="picker-tray-actions">
        <button type="button" class="btn btn--md btn--overlay" data-action="clear" aria-label="Clear selection"><Icon name="cross-large" size={14} /><span class="picker-tray-action-label">Clear</span></button>
        {#if primary === 'working'}
          <!-- Still the primary button to look at, with nothing to press: the app's loader in place of a label. -->
          <button type="button" class="btn btn--md btn--primary" aria-busy="true" aria-label="Creating the bundle"><span class="ol-loader" aria-hidden="true"></span></button>
        {:else if primary === 'done'}
          <button type="button" class="btn btn--md btn--primary" data-action="open-draft">Open in OfferLab</button>
        {:else if primary === 'connect'}
          <button type="button" class="btn btn--md btn--primary" data-action="create-bundle">Connect OfferLab</button>
        {:else if primary === 'retry'}
          <button type="button" class="btn btn--md btn--primary" data-action="create-bundle">Try again</button>
        {:else if primary === 'create'}
          <button type="button" class="btn btn--md btn--primary" data-action="create-bundle">Create bundle</button>
        {/if}
      </div>
    </div>
  {/if}
</div>
