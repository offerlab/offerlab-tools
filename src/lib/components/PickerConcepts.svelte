<script>
  /**
   * The concepts card: the fanned product stack, the headline copy, the state's action, and the
   * bundle concepts once Gemini has answered. Minimised, it is a chip.
   */
  import { picker, view } from '$lib/client/picker-state.svelte.js';
  import { fallbackCopy, stackImages } from '$lib/client/picker-concepts.js';
  import { CONCEPT_COUNT } from '$lib/client/picker-prompt.js';
  import { catalogThumbUrl } from '$lib/client/util.js';
  import { conceptsMotion } from '$lib/client/actions/concepts_motion.js';
  import Icon from './Icon.svelte';
  import PickerConceptCard from './PickerConceptCard.svelte';

  // Five slots fanning out from the front card: a mid pair just behind it, tilted outward, and a
  // smaller far pair behind those. Painted back to front, so DOM order is far, mid, front.
  // images[1..2] take the mid pair, images[3..4] the far pair; with fewer images the far slots go
  // empty. The geometry lives in CSS as .picker-stack-card--s0..s3, so a narrow layout can retune
  // it; the outermost pair is what that layout drops, so it is nameable.
  const STACK_SLOTS = [
    { image: 3, far: true },
    { image: 4, far: true },
    { image: 1, far: false },
    { image: 2, far: false }
  ];

  const status = $derived(picker.conceptsStatus);
  const copy = $derived(picker.copy || fallbackCopy());
  const images = $derived(stackImages());
  const head = $derived.by(() => {
    if (status === 'ready') {
      return {
        title: `${picker.concepts.length} ${picker.concepts.length === 1 ? 'way' : 'ways'} to pair these`,
        subtitle: picker.conceptsSummary || 'Four directions, one shared shopper.'
      };
    }
    if (status === 'loading') return { title: 'Rummaging through the shelves', subtitle: '' };
    if (status === 'error') return { title: "That one didn't come together", subtitle: picker.conceptsError || 'Something went wrong.' };
    return { title: copy.headline, subtitle: copy.subtitle };
  });

  // The fan is an entrance for a new set of images, which is the only change that replays it.
  $effect(() => {
    void images.join('|');
    view.fanOutStack();
  });
</script>

<div class="picker-concepts" id="pickerConcepts"
  class:picker-concepts--idle={status === 'idle'}
  class:picker-concepts--loading={status === 'loading'}
  class:picker-concepts--ready={status === 'ready'}
  class:picker-concepts--error={status === 'error'}
  class:is-minimized={picker.conceptsMinimized}
  use:conceptsMotion>
  {#if picker.conceptsMinimized}
    <button type="button" class="picker-concepts-chip" data-action="toggle-minimize" aria-expanded="false" aria-label="Expand bundle ideas"><span class="picker-concepts-chip-label">Bundle ideas</span><span class="picker-concepts-chip-icon" aria-hidden="true"><Icon name="expand-45" size={14} /></span></button>
  {:else}
    <div class="picker-concepts-head">
      {#if images.length > 0}
        <div class="picker-stack" aria-hidden="true">
          {#each STACK_SLOTS as slot, slotIndex}
            {#if images[slot.image]}
              <span class="picker-stack-card media-tile media-hairline picker-stack-card--s{slotIndex}" class:picker-stack-card--far={slot.far}><img class="media-zoom" src={catalogThumbUrl(images[slot.image], 240)} alt=""></span>
            {/if}
          {/each}
          <span class="picker-stack-card media-tile media-hairline picker-stack-card--front"><img class="media-zoom" src={catalogThumbUrl(images[0], 240)} alt=""></span>
        </div>
      {/if}
      <div class="picker-concepts-copy">
        <h3 class="picker-concepts-title" class:text-shimmer-ink={status === 'loading'}>{head.title}</h3>
        {#if head.subtitle}<p class="picker-concepts-subtitle">{head.subtitle}</p>{/if}
      </div>
      <!-- The head's controls read as one elevated pill: whatever the current state offers, a
           hairline, then minimize. The buttons inside are ghosts so the pill is the only raised thing. -->
      <div class="picker-concepts-actions">
        {#if status === 'ready'}
          <button type="button" class="btn btn--md btn--ghost" data-action="suggest" aria-label="Regenerate bundle ideas"><Icon name="arrow-rotate-clockwise" size={14} /><span class="picker-concepts-action-label">Regenerate</span></button>
        {:else if status === 'loading'}
          <button type="button" class="stop-button" data-action="cancel" aria-label="Stop generating"><Icon name="stop-filled" class="stop-icon" /></button>
        {:else if status === 'error'}
          <button type="button" class="btn btn--md btn--ai" data-action="suggest" aria-label="Try again"><Icon name="ai-sparkles-two-filled" size={16} /><span class="picker-concepts-action-label">Try again</span></button>
        {:else}
          <button type="button" class="btn btn--md btn--ai" data-action="suggest" aria-label="Suggest bundles"><Icon name="ai-sparkles-two-filled" size={16} /><span class="picker-concepts-action-label">Suggest bundles</span></button>
        {/if}
        <span class="picker-concepts-actions-divider" aria-hidden="true"></span>
        <button type="button" class="btn btn--md btn--ghost btn--icon" data-action="toggle-minimize" aria-expanded="true" aria-controls="pickerConceptsBody" aria-label="Minimize bundle ideas"><Icon name="minimize-45" size={16} /></button>
      </div>
    </div>
    {#if status === 'ready'}
      <div class="picker-concepts-body" id="pickerConceptsBody"><div class="picker-concepts-grid">{#each picker.concepts as concept, index}<PickerConceptCard {concept} {index} />{/each}</div></div>
    {:else if status === 'loading'}
      <div class="picker-concepts-body" id="pickerConceptsBody"><div class="picker-concepts-grid">{#each { length: CONCEPT_COUNT } as _, i (i)}<div class="picker-concept picker-concept--skeleton"></div>{/each}</div></div>
    {/if}
  {/if}
</div>
