<script>
  /**
   * The "Pitch them" drawer. Mounted once at the end of the page and left mounted; pitch.svelte.js
   * holds its state and +page.svelte's popstate handler closes it on back. Markup, classes and
   * ids match index.html so styles.css applies unchanged.
   */
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import FaviconDuo from './FaviconDuo.svelte';
  import PitchSkeleton from './PitchSkeleton.svelte';
  import PitchResults from './PitchResults.svelte';
  import { pitch, closePitchModal, finishClose, triggerPitchGeneration, onToolbarClick } from '$lib/client/pitch.svelte.js';
  import { PITCH_MODELS } from '$lib/client/pitch-api.js';
  import { extractDomain, getFaviconUrl } from '$lib/client/util.js';
  import { socialEntries } from '$lib/client/social.js';

  let modal;

  const searchedDomain = $derived(extractDomain(pitch.searchedBrand?.url || ''));
  const partnerDomain = $derived(extractDomain(pitch.brand?.url || ''));

  // Quick links: the website when there is a URL, then each social the brand is on.
  function brandLinks(brand, fallbackName) {
    const url = brand?.url || '';
    const domain = extractDomain(url);
    const links = [];
    if (url) links.push({ href: url, label: domain || url.replace(/^https?:\/\//, ''), icon: 'globus' });
    for (const entry of socialEntries(brand?.social || {})) {
      links.push({ href: entry.url, label: entry.key === 'facebook' ? entry.label : `@${entry.handle}`, icon: entry.icon });
    }
    return { name: brand?.name || fallbackName, faviconSrc: domain ? getFaviconUrl(domain) : '', links };
  }
  const quickLinkGroups = $derived([brandLinks(pitch.searchedBrand, 'Brand 1'), brandLinks(pitch.brand, 'Brand 2')]);
  const showQuickLinks = $derived(quickLinkGroups.some(group => group.links.length > 0));

  // The drawer's own slide-out ends the close; a child's animation ending must not.
  function onAnimationEnd(event) {
    if (event.target === modal && pitch.closing) finishClose();
  }

  function onOverlayClick(event) {
    if (event.target === event.currentTarget) closePitchModal();
  }

  function hideImage(event) {
    event.currentTarget.style.display = 'none';
  }

  onMount(() => {
    const onKeydown = (event) => {
      if (event.key === 'Escape') closePitchModal();
    };
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });
</script>

<!-- Generate Pitch Modal. A click on the backdrop closes; Escape is its keyboard path, on window. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-overlay" class:hidden={!pitch.open} class:closing={pitch.closing} id="pitchModalOverlay" role="presentation" onclick={onOverlayClick}>
  <div class="modal pitch-modal" class:closing={pitch.closing} id="pitchModal" bind:this={modal} onanimationend={onAnimationEnd}>
    <div class="pitch-modal-toolbar">
      <button type="button" class="pitch-toolbar-btn" id="pitchToolbarBtn"
              class:hidden={pitch.toolbar === 'hidden'} class:is-generating={pitch.toolbar === 'generating'}
              onclick={onToolbarClick}>
        <!-- Generating state: icon-only stop button -->
        <span class="pitch-toolbar-generating">
          <Icon name="stop-filled" class="pitch-toolbar-stop-svg" />
        </span>
        <!-- Regenerate state: full pill button with text -->
        <span class="pitch-toolbar-regenerate">
          <Icon name="arrow-rotate-clockwise" size={16} />
          Regenerate
        </span>
      </button>
      <button type="button" class="modal-close-btn" id="pitchModalClose" aria-label="Close modal" onclick={closePitchModal}>
        <Icon name="cross-large" />
      </button>
    </div>
    <div class="modal-body" id="pitchModalBody">
      <div class="modal-header-text" id="pitchModalSubtitle">
        {#if searchedDomain && partnerDomain}
          <FaviconDuo domain1={searchedDomain} domain2={partnerDomain} />
        {/if}
        <div class="modal-header-labels">
          <h2 class="modal-title">Pitch them</h2>
          <p class="modal-subtitle-text">{pitch.brand1 ?? ''} &times; {pitch.brand2 ?? ''}</p>
        </div>
      </div>

      <div class="pitch-quick-links" id="pitchQuickLinks">
        {#if showQuickLinks}
          <!-- Keyed per brand so a favicon hidden by onerror comes back for the next pair. -->
          {#key pitch.brand}
            <div class="pitch-quick-links-card">
              <div class="pitch-section-header">
                <h3 class="pitch-section-title">Connect</h3>
              </div>
              {#each quickLinkGroups as group, index}
                {#if index === 1 && quickLinkGroups[0].links.length > 0 && group.links.length > 0}
                  <div class="quick-links-divider"></div>
                {/if}
                {#if group.links.length > 0}
                  <div class="quick-links-group">
                    <div class="quick-links-group-header">
                      {#if group.faviconSrc}
                        <img class="quick-links-favicon" src={group.faviconSrc} alt="" onerror={hideImage} />
                      {/if}
                      <span class="quick-links-brand-name">{group.name}</span>
                    </div>
                    <div class="quick-links-list">
                      {#each group.links as link}
                        <a href={link.href} target="_blank" rel="noopener noreferrer" class="quick-link-row">
                          <span class="quick-link-label">{link.label}</span>
                          <span class="quick-link-icon"><Icon name={link.icon} size={20} /></span>
                        </a>
                      {/each}
                    </div>
                  </div>
                {/if}
              {/each}
            </div>
          {/key}
        {/if}
      </div>

      <div class="pitch-bundles" id="pitchBundlesBuilt">
        {#if pitch.drafts.length}
          <div class="pitch-bundles-card">
            <div class="pitch-bundles-header">Bundles built</div>
            {#each pitch.drafts as draft}
              <div class="pitch-bundle" data-stack-id={String(draft.stackId)}>
                <div class="pitch-bundle-name">{draft.name}</div>
                {#if draft.products?.length}
                  <ul class="pitch-bundle-items">
                    {#each draft.products as product}
                      <li class="pitch-bundle-item">{product.title} <span class="pitch-bundle-item-brand">by {product.brand}</span></li>
                    {/each}
                  </ul>
                {/if}
                <div class="pitch-bundle-links">
                  <a href={draft.url} target="_blank" rel="noopener noreferrer" class="pitch-bundle-link">Open in builder</a>
                  <a href={draft.publishedUrl || '#'} target="_blank" rel="noopener noreferrer"
                     class="pitch-bundle-link pitch-bundle-link--pdp" hidden={!draft.publishedUrl}>View the live page</a>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="pitch-modal-content" id="pitchModalContent">
        {#if pitch.stage === 'initial'}
          <div class="pitch-initial">
            <div class="pitch-model-select-group">
              <label class="pitch-model-label" for="pitchModelSelect">Model</label>
              <select class="pitch-model-select" id="pitchModelSelect" bind:value={pitch.model}>
                {#each PITCH_MODELS as m}
                  <option value={m.value}>{m.label}</option>
                {/each}
              </select>
            </div>
            <p class="pitch-description">AI will research both brands, recommend the best outreach channel and contacts, draft personalized messages in your voice, and surface noteworthy details for conversation starters.</p>
            <button type="button" class="pitch-generate-btn" id="pitchGenerateBtn" onclick={() => triggerPitchGeneration()}>
              <Icon name="ai-sparkles-two-filled" size={18} />
              Generate Pitch
            </button>
          </div>
        {:else if pitch.stage === 'loading'}
          <PitchSkeleton />
        {:else if pitch.stage === 'error'}
          <div class="pitch-error">
            <Icon name="triangle-exclamation-filled" class="pitch-error-icon" />
            <p class="pitch-error-message">{pitch.error}</p>
            <button type="button" class="pitch-try-again-btn" id="pitchTryAgainBtn" onclick={() => triggerPitchGeneration()}>Try Again</button>
          </div>
        {:else if pitch.stage === 'results' && pitch.result}
          {#key pitch.result}
            <PitchResults data={pitch.result} {searchedDomain} {partnerDomain} />
          {/key}
        {/if}
      </div>
    </div>
  </div>
</div>
