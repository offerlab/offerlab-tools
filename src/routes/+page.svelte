<script>
  /**
   * The finder, one page: the landing, loading, results, picker, empty and error views of the
   * search, and the Showcase, all mounted once and shown by `app.view`. The URL carries the state
   * (?q=, ?pitch=, ?pick=, ?view=library) and back/forward re-reads it.
   */
  import { onMount } from 'svelte';
  import FloatingTiles from '$lib/components/FloatingTiles.svelte';
  import ViewHeader from '$lib/components/ViewHeader.svelte';
  import Landing from '$lib/components/Landing.svelte';
  import Loading from '$lib/components/Loading.svelte';
  import Results from '$lib/components/Results.svelte';
  import Picker from '$lib/components/Picker.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import Showcase from '$lib/components/Showcase.svelte';
  import PitchModal from '$lib/components/PitchModal.svelte';
  import { app } from '$lib/client/state.svelte.js';
  import { tiles } from '$lib/client/tiles.svelte.js';
  import { refreshSearchHistory } from '$lib/client/history.svelte.js';
  import { performSearch, hideAllSearchHistoryDropdowns } from '$lib/client/search.svelte.js';
  import { routeInitial, onPopState } from '$lib/client/router.svelte.js';
  import { initPhotoSearch } from '$lib/client/photo.js';
  import { preloadDemoAvatars } from '$lib/client/actions/typing.js';

  const showingResults = $derived(app.view !== 'landing');

  $effect(() => {
    document.body.classList.toggle('showing-results', showingResults);
  });

  onMount(() => {
    preloadDemoAvatars();
    refreshSearchHistory();
    initPhotoSearch({ search: url => { hideAllSearchHistoryDropdowns(); performSearch(url); } });
    routeInitial();
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  });
</script>

<div class="app-container" class:showing-results={showingResults} style="--tiles-exit: {tiles.exit}">
  <main class="main-content">
    <!-- The scroll region. The sheet itself stays put so a footer can sit under it in flow. -->
    <div class="sheet-scroll" id="sheetScroll">
      <FloatingTiles />
      <ViewHeader />
      <Landing />
      <Loading />
      <Results />
      <Picker />
      <EmptyState />
      <Showcase />
    </div>
  </main>
</div>

<PitchModal />
