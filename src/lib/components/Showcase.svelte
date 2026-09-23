<script>
  /**
   * The collabs library (`?view=library`): every published demo bundle on shelves that run
   * forever, a bottom omnibox with filters and chips, and the lightbox. Mounted once by the page
   * and kept; it loads the snapshot on its first showing and pauses when the view leaves.
   *
   * The omnibox and its chips render from `showcase`; the board is imperative (showcase-board.js)
   * and driven from here by `apply()`.
   */
  import { onMount, untrack } from 'svelte';
  import { app } from '$lib/client/state.svelte.js';
  import Icon from '$lib/components/Icon.svelte';
  import Lightbox from '$lib/components/Lightbox.svelte';
  import {
    EYEBROW_CHIPS, TYPING_MS, label, load, narrowedBy, readFiltersFromUrl, showcase, visibleBundles, writeFiltersToUrl
  } from '$lib/client/showcase.svelte.js';
  import { G, board, clearBoard, initBoard, isMobile, measure, render, setPan } from '$lib/client/showcase-board.js';
  import { viewportGestures } from '$lib/client/actions/showcase-viewport.js';

  let section;
  let viewport;
  let boardEl;
  let lightbox;
  // What is typed; it becomes the query filter after a pause in typing.
  let queryText = $state('');
  let typing = 0;
  let ready = $state(false);

  const applied = $derived(narrowedBy());
  const filtering = $derived(!!(showcase.filters.category || showcase.filters.brand || showcase.filters.store));
  const emptyTitle = $derived(`Nothing on the shelf for ${applied.map(f => f.label).join(' · ')}`);

  onMount(() => {
    initBoard({ section, viewport, el: boardEl });
    measure();
    // A new size means new cell positions, so the board is dealt again where it stands.
    board.media.addEventListener('change', remeasure);
    ready = true;
    return () => board.media.removeEventListener('change', remeasure);
  });

  // Shows or pauses with the view. The work inside reads and writes the filters, so it runs
  // untracked: only the view (and mount) may trigger it.
  $effect(() => {
    const showing = ready && app.view === 'library';
    const mounted = ready;
    untrack(() => {
      if (!mounted) return;
      if (showing) show();
      else hide();
    });
  });

  async function show() {
    if (!showcase.loaded) await load();
    if (app.view !== 'library') return;
    readFiltersFromUrl();
    queryText = showcase.filters.query;
    apply();
  }

  function hide() {
    lightbox?.close();
    showcase.filtersOpen = false;
  }

  function remeasure() {
    measure();
    if (showcase.loaded) { clearBoard(); render(); }
  }

  function apply() {
    board.visible = visibleBundles();
    writeFiltersToUrl();

    // A phone's shelves stand where they are; only what is on them changes.
    if (isMobile()) return render();

    // Row 0 opens across the middle with a tile centered; after that the pan is kept, so a filter
    // changes what is on the shelves and not where you are.
    if (!board.placed) {
      const view = viewport.getBoundingClientRect();
      board.pan = { x: Math.round((view.width - G.colW) / 2), y: Math.round(view.height / 2 - G.air - G.tile / 2) };
      board.placed = true;
    }
    setPan(board.pan.x, board.pan.y);
    render();
  }

  // A pause in typing deals once; every keystroke would deal a shelf of covers for "c", "co"...
  function onType() {
    clearTimeout(typing);
    typing = setTimeout(() => { showcase.filters.query = queryText.trim(); apply(); }, TYPING_MS);
  }

  function removeFilter(key) {
    showcase.filters[key] = '';
    apply();
  }

  function clearFilters() {
    showcase.filters = { query: '', category: '', brand: '', store: '' };
    queryText = '';
    apply();
  }

  function openFilters() {
    showcase.filtersOpen = true;
  }

  function toggleFilters() {
    showcase.filtersOpen = !showcase.filtersOpen;
  }

  function onDocumentClick(event) {
    if (!showcase.filtersOpen) return;
    if (!event.target.closest('#libraryFilters, #libraryFilterBtn, [data-action="library-more"]')) showcase.filtersOpen = false;
  }

  function onTile(id, tile) {
    lightbox.open(id, tile);
  }
</script>

<svelte:window onresize={remeasure} />
<svelte:document onclick={onDocumentClick} />

<section class="library-section" id="librarySection" class:hidden={app.view !== 'library'} aria-label="Collabs library" bind:this={section}>
  <!-- The viewport takes focus so the arrow keys pan it and a closed lightbox has somewhere to land. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="library-viewport" id="libraryViewport" tabindex="0" aria-label="Bundle shelves. Drag or use the arrow keys to move around." bind:this={viewport} use:viewportGestures={{ onTile }}>
    <div class="library-board" id="libraryBoard" bind:this={boardEl}></div>
    <div class="library-empty" id="libraryEmpty" class:hidden={!showcase.loaded || showcase.count > 0}>
      <div class="library-empty-blur" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
      <div class="library-empty-message">
        <p class="library-empty-title" id="libraryEmptyTitle">{emptyTitle}</p>
        <p class="library-empty-copy">Try a brand, a product or a category, or start over.</p>
        <button type="button" class="btn btn--md btn--primary" data-action="library-clear" onclick={clearFilters}>Clear search</button>
      </div>
    </div>
  </div>

  <div class="library-omni">
    <div class="omni-ai-box-container omni-ai-box-container--library">
      <form class="search-form" id="libraryForm" role="search" onsubmit={event => event.preventDefault()}>
        <div class="search-input-wrapper">
          <input type="search" class="search-input" id="libraryInput" placeholder="Explore bundles" autocomplete="off" spellcheck="false" aria-label="Search the library" bind:value={queryText} oninput={onType}>
          <div class="submit-button-wrapper">
            <button type="button" class="search-button library-filter-btn" id="libraryFilterBtn" class:is-active={filtering} aria-label="Filters" aria-haspopup="true" aria-expanded={showcase.filtersOpen} aria-controls="libraryFilters" onclick={toggleFilters}>
              <Icon name="settings-slider-filter" size={16} />
            </button>
          </div>
        </div>
      </form>
      <!-- What narrowed the shelves, as chips, tucked under the pill's top edge. -->
      <div class="library-eyebrow" id="libraryEyebrow" class:hidden={!applied.length} aria-live="polite">
        <div class="library-eyebrow-chips" id="libraryEyebrowChips">
          <span class="library-eyebrow-count">{showcase.count} of {showcase.total}</span>
          {#each applied.slice(0, EYEBROW_CHIPS) as chip (chip.key)}
            <span class="library-chip">{chip.label}
              <button type="button" class="library-chip-remove" data-remove={chip.key} aria-label="Remove {chip.label}" onclick={() => removeFilter(chip.key)}><Icon name="cross-large" size={10} /></button>
            </span>
          {/each}
          {#if applied.length > EYEBROW_CHIPS}
            <button type="button" class="library-chip library-chip--more" data-action="library-more" onclick={openFilters}>+{applied.length - EYEBROW_CHIPS} more</button>
          {/if}
        </div>
        <button type="button" class="library-chip library-chip--clear" data-action="library-clear" onclick={clearFilters}>Clear <Icon name="close-clear-x-circled-filled" size={14} /></button>
      </div>
      <div class="library-filters" id="libraryFilters" class:hidden={!showcase.filtersOpen}>
        <label class="library-filter-field">
          <span>Category</span>
          <select id="libraryCategory" data-filter="category" bind:value={showcase.filters.category} onchange={apply}>
            <option value="">All categories</option>
            {#each showcase.options.categories as category (category)}
              <option value={category}>{label(category)}</option>
            {/each}
          </select>
        </label>
        <label class="library-filter-field">
          <span>Brand</span>
          <select id="libraryBrand" data-filter="brand" bind:value={showcase.filters.brand} onchange={apply}>
            <option value="">All brands</option>
            {#each showcase.options.brands as brand (brand)}
              <option value={brand}>{brand}</option>
            {/each}
          </select>
        </label>
        <label class="library-filter-field" id="libraryStoreField" hidden={showcase.options.stores.length < 2}>
          <span>Store</span>
          <select id="libraryStore" data-filter="store" bind:value={showcase.filters.store} onchange={apply}>
            <option value="">All stores</option>
            {#each showcase.options.stores as store (store)}
              <option value={store}>{store}</option>
            {/each}
          </select>
        </label>
        <button type="button" class="btn btn--md btn--ghost library-filters-clear" data-action="library-clear" onclick={clearFilters}>Clear</button>
      </div>
    </div>
  </div>

  <Lightbox bind:this={lightbox} />
</section>
