<script>
  /**
   * Two brand favicons overlaid with offset and rotation. Size comes from CSS: --favicon-duo-size
   * on the parent or the element itself.
   */
  import { getFaviconUrl, faviconFallback } from '$lib/client/util.js';

  let { domain1, domain2 } = $props();
</script>

<div class="favicon-duo">
  <img class="favicon-duo__back" src={getFaviconUrl(domain1)} alt="" onerror={faviconFallback} />
  <img class="favicon-duo__front" src={getFaviconUrl(domain2)} alt="" onerror={faviconFallback} />
</div>
