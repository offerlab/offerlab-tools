<script>
  /**
   * The bundle picker section: the concepts card, the rail of brand columns, and the layers it
   * owns (add popover, selection tray, URL dialog, stand-in product dialog). Mounted once and kept; `app.view` shows it.
   */
  import { onMount, tick } from 'svelte';
  import { app } from '$lib/client/state.svelte.js';
  import { picker, runtime, view } from '$lib/client/picker-state.svelte.js';
  import { hideAddPopover, hideUrlDialog } from '$lib/client/picker-add.js';
  import { hideProductDialog } from '$lib/client/picker-standins.js';
  import { handleAction } from '$lib/client/picker-dispatch.js';
  import { delegateActions } from '$lib/client/actions/delegate_actions.js';
  import { columnRail } from '$lib/client/actions/column_rail.js';
  import Icon from './Icon.svelte';
  import PickerConcepts from './PickerConcepts.svelte';
  import PickerColumn from './PickerColumn.svelte';
  import PickerAddPopover from './PickerAddPopover.svelte';
  import PickerTray from './PickerTray.svelte';
  import PickerUrlDialog from './PickerUrlDialog.svelte';
  import PickerProductDialog from './PickerProductDialog.svelte';

  let section = $state(null);
  const hasTray = $derived(picker.selection.size > 0);
  // Anything that changes the track's width: a column added, a catalog filled in, a filter typed.
  const railKey = $derived(picker.brands
    .map(e => `${e.domain}:${e.brand.catalog?.products?.length || 0}:${picker.filters[e.domain] || ''}`)
    .join('|'));

  $effect(() => {
    void railKey;
    tick().then(() => view.updateRail());
  });

  onMount(() => {
    runtime.section = section;
    const onDocumentClick = (e) => {
      if (!e.target.closest('#pickerAddPopover') && !e.target.closest('[data-action="add-brand"]')) hideAddPopover();
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape') { hideAddPopover(); hideUrlDialog(); hideProductDialog(); }
    };
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onKeydown);
    return () => {
      document.removeEventListener('click', onDocumentClick);
      document.removeEventListener('keydown', onKeydown);
      runtime.section = null;
    };
  });
</script>

<section class="picker-section" id="pickerSection" class:hidden={app.view !== 'picker'} class:has-tray={hasTray} bind:this={section} use:delegateActions={handleAction}>
  <div class="picker-concepts-layout">
    <div class="picker-concepts-shell" id="pickerConceptsShell">
      <span class="picker-concepts-glow" aria-hidden="true"></span>
      <span class="picker-concepts-glow" aria-hidden="true"></span>
      <span class="picker-concepts-glow" aria-hidden="true"></span>
      <span class="picker-concepts-glow" aria-hidden="true"></span>
      <span class="picker-concepts-glow" aria-hidden="true"></span>
      <span class="picker-concepts-glow" aria-hidden="true"></span>
      <PickerConcepts />
    </div>
  </div>
  <div class="picker-rail" id="pickerRail" class:is-bleeding={picker.brands.length > 1}>
    <div class="picker-rail-controls">
      <button type="button" class="picker-rail-btn picker-rail-btn--prev" data-action="rail-prev" aria-label="Previous brand"><Icon name="chevron-left" class="stroke-width-2" size={14} /></button>
      <button type="button" class="picker-rail-btn picker-rail-btn--next" data-action="rail-next" aria-label="Next brand"><Icon name="chevron-right" class="stroke-width-2" size={14} /></button>
    </div>
    <div class="picker-columns" id="pickerColumns" tabindex="0" aria-label="Brand catalogs" style:--brand-count={Math.max(picker.brands.length, 1)} use:columnRail>
      {#each picker.brands as entry (entry.domain)}
        <PickerColumn {entry} />
      {/each}
      <div class="picker-add-column" role="button" tabindex="0" data-action="add-brand" aria-label="Add a brand" aria-haspopup="true">
        <span class="picker-add-btn" aria-hidden="true"><Icon name="plus-large" size={20} /></span>
        <span class="picker-add-label">Add brand</span>
      </div>
    </div>
  </div>
  <PickerAddPopover />
  <PickerTray />
  <PickerUrlDialog />
  <PickerProductDialog />
</section>
