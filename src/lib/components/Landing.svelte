<script>
  /** The landing state: the title, the tagline and the omnibar. */
  import Omnibar from './Omnibar.svelte';
  import { app } from '$lib/client/state.svelte.js';
</script>

<section class="landing-section" id="landingSection" class:hidden={app.view !== 'landing'}>
  <div class="logo-container">
    <h1 class="text-display-small md:text-display-medium font-medium">
      <span class="fancy-script">Collab</span>&nbsp; finder
    </h1>
    <p class="tagline">Discover amazing brands you can start selling with today.</p>
  </div>

  <!-- Search anchor: reserves space when collapsed, prevents layout shift when dropdown opens -->
  <div class="search-anchor">
    <div class="omni-ai-box-container">
      <Omnibar variant="landing" />
    </div>
  </div>
</section>
