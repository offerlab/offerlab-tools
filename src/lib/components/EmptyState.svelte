<script>
  import { app } from '$lib/client/state.svelte.js';
  import { goToLanding, retrySearch } from '$lib/client/search.svelte.js';
</script>

<section class="empty-section" id="emptySection" class:hidden={app.view !== 'empty'}>
  <div class="empty-content">
    <div class="empty-icon">🔍</div>
    <h2 class="empty-title">No matches found</h2>
    <p class="empty-message">We couldn't find complementary brands for that URL. Try a different brand or check the URL.</p>
    <button class="try-again-btn" id="tryAgainBtn" onclick={goToLanding}>Try another search</button>
  </div>
</section>

<!-- Error State -->
<section class="error-section" id="errorSection" class:hidden={app.view !== 'error'}>
  <div class="error-content">
    <div class="error-icon">⚠️</div>
    <h2 class="error-title">Something went wrong</h2>
    <p class="error-message" id="errorMessage">{app.errorMessage || 'Please try again in a moment.'}</p>
    <button class="try-again-btn" id="errorRetryBtn" onclick={retrySearch}>Retry</button>
  </div>
</section>
