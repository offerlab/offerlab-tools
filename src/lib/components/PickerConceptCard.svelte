<script>
  /** One bundle concept: a pile of its product thumbs, the name and hook, and what it includes. */
  import { picker, entryFor } from '$lib/client/picker-state.svelte.js';
  import { conceptBundlePrice, money } from '$lib/client/picker-concepts.js';
  import { catalogThumbUrl } from '$lib/client/util.js';

  const CONCEPT_THUMBS = 4;
  // A concept's thumbs overlap into a pile; the tilt alternates by position so the row reads as
  // shuffled rather than fanned in one direction.
  const THUMB_PILE_TILTS = [-6, 4, -3, 5];

  let { concept, index } = $props();

  const products = $derived(concept.picks.map(p => p.product));
  const thumbs = $derived(products.slice(0, CONCEPT_THUMBS));
  const active = $derived(index === picker.activeConcept);
</script>

<div class="picker-concept" class:is-active={active} role="button" tabindex="0" data-action="apply-concept" data-index={index}>
  <div class="picker-concept-main">
    <div class="picker-concept-thumbs">{#each thumbs as p, i}<span class="picker-concept-thumb media-tile media-hairline" style="--tilt: {THUMB_PILE_TILTS[i % THUMB_PILE_TILTS.length]}deg; --i: {index * CONCEPT_THUMBS + i}" title={p.title}><img class="media-zoom" src={catalogThumbUrl(p.image, 200)} alt=""></span>{/each}{#if products.length > CONCEPT_THUMBS}<span class="picker-concept-more">+{products.length - CONCEPT_THUMBS}</span>{/if}</div>
    <div class="picker-concept-name">{concept.name}{#if concept.edited} <span class="picker-concept-edited">edited</span>{/if}</div>
    <p class="picker-concept-hook">{concept.hook}</p>
    <div class="picker-concept-total">{money(conceptBundlePrice(concept))}</div>
  </div>
  <div class="picker-concept-foot">
    <div class="picker-concept-includes">
      <div class="picker-concept-includes-label">Includes</div>
      <ul class="picker-concept-items">{#each concept.picks as pick}<li class="picker-concept-item">{pick.product.title} <span class="picker-concept-item-brand">by {entryFor(pick.domain)?.brand.name || pick.domain}</span></li>{/each}</ul>
    </div>
    <button type="button" class="btn btn--md btn--ai picker-concept-create" data-action="create-concept" data-index={index}>Create bundle</button>
  </div>
</div>
