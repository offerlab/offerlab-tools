<script>
  /**
   * The build, once it has run past the tray's patience: a blurred sheet over the picker, the
   * picked products floating large, the pairing named the way the Showcase names one, and the
   * agent chip carrying the build's step with a stop. Dismisses itself when the build settles.
   */
  import { picker, entryFor, sellerEntry, productKey } from '$lib/client/picker-state.svelte.js';
  import { handleAction } from '$lib/client/picker-dispatch.js';
  import { catalogThumbUrl, getFaviconUrl, faviconFallback } from '$lib/client/util.js';
  import { portal } from '$lib/client/actions/portal.js';
  import { delegateActions } from '$lib/client/actions/delegate_actions.js';
  import Icon from './Icon.svelte';

  // How long the tray's loader carries the wait on its own before the build takes the screen.
  const PATIENCE_MS = 5000;
  const STACK_MAX = 5;
  // Each tile's place in the pile: offset from center, tilt, and its own drift so no two move alike.
  const SLOTS = [
    { x: 0, y: 0, rotate: -3, drift: 7.5, delay: 0 },
    { x: -150, y: -30, rotate: -10, drift: 8.5, delay: -2.1 },
    { x: 150, y: 26, rotate: 9, drift: 9.2, delay: -4.3 },
    { x: -80, y: 96, rotate: 6, drift: 8, delay: -1.2 },
    { x: 90, y: -96, rotate: -7, drift: 9.8, delay: -3.4 }
  ];

  let shown = $state(false);
  let timer = null;

  const working = $derived(picker.draft.status === 'working');

  $effect(() => {
    if (!working) {
      clearTimeout(timer);
      timer = null;
      shown = false;
      return;
    }
    const wait = Math.max(0, PATIENCE_MS - (Date.now() - picker.draft.startedAt));
    timer = setTimeout(() => { shown = true; }, wait);
    return () => clearTimeout(timer);
  });

  const picks = $derived([...picker.selection.values()].sort((a, b) => a.sequence - b.sequence));
  // The searched brand leads, as it does in the bundle itself.
  const brands = $derived.by(() => {
    const seller = sellerEntry()?.domain;
    const domains = [...new Set(picks.map(p => p.domain))].sort((a, b) => (a === seller ? -1 : b === seller ? 1 : 0));
    return domains.map(domain => ({ domain, name: entryFor(domain)?.brand.name || domain }));
  });
  // The front of the pile is the last thing picked, which is what the eye was just on.
  const tiles = $derived(picks.slice(-STACK_MAX).reverse().map((pick, i) => ({ pick, key: productKey(pick.domain, pick.product.id), slot: SLOTS[i] })));
  const step = $derived(picker.draft.message || 'Bundling');
</script>

{#if shown}
  <div class="bundling" role="status" aria-live="polite" use:portal use:delegateActions={handleAction}>
    <div class="bundling-stage">
      <div class="bundling-pile" aria-hidden="true">
        {#each tiles as { pick, key, slot }, i (key)}
          <div class="bundling-tile-slot" style="--tx: {slot.x}px; --ty: {slot.y}px; --rot: {slot.rotate}deg; --drift: {slot.drift}s; --delay: {slot.delay}s; z-index: {tiles.length - i}">
            <div class="bundling-tile media-tile media-hairline">
              {#if pick.product.image}
                <img src={catalogThumbUrl(pick.product.image, 480)} alt="">
              {:else}
                <img class="bundling-tile-favicon" src={getFaviconUrl(pick.domain)} alt="" onerror={faviconFallback}>
              {/if}
            </div>
          </div>
        {/each}
      </div>
      <div class="bundling-pair">
        {#each brands as brand, i (brand.domain)}
          {#if i > 0}<span class="bundling-pair-x" aria-hidden="true">×</span>{/if}
          <span class="bundling-pair-brand"><img class="bundling-pair-avatar" src={getFaviconUrl(brand.domain)} alt="" onerror={faviconFallback}><span class="bundling-pair-name">{brand.name}</span></span>
        {/each}
      </div>
      <div class="picker-concepts-shell is-chip bundling-chip-shell">
        {#each Array(6) as _}<span class="picker-concepts-glow" aria-hidden="true"></span>{/each}
        <div class="picker-concepts bundling-chip">
          <span class="ol-loader" aria-hidden="true"></span>
          <span class="bundling-chip-label text-shimmer-ink">{step}</span>
          <button type="button" class="stop-button bundling-stop" data-action="stop-bundling" aria-label="Stop bundling"><Icon name="stop-filled" class="stop-icon" /></button>
        </div>
      </div>
    </div>
  </div>
{/if}
