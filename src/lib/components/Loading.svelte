<script>
  /** The loading state: the searched brand's favicon and the shimmering step message. */
  import { app } from '$lib/client/state.svelte.js';
  import { getFaviconUrl, faviconFallback } from '$lib/client/util.js';
</script>

<section class="loading-section" id="loadingSection" class:hidden={app.view !== 'loading'}>
  <div class="loading-content">
    <div class="loading-favicon-tile" id="loadingFaviconContainer">
      {#key app.loading.domain}
        <img id="loadingFavicon" src={app.loading.domain ? getFaviconUrl(app.loading.domain) : ''} alt={app.loading.domain} onerror={faviconFallback}>
      {/key}
    </div>
    <div class="loading-text-group">
      <p class="loading-text loading-text-shimmer" id="loadingText">{app.loading.text || 'Researching your brand...'}</p>
      <p class="loading-subtext" id="loadingUrl">{app.loading.domain}</p>
    </div>
  </div>
</section>
