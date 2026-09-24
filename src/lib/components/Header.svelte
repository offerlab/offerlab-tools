<script>
  /**
   * The dark bar: the one global header. Logo, the Create | Showcase switch, and the OfferLab
   * account control. It is fixed, so its height is published as --header-h for anything sizing
   * itself to the viewport (the picker).
   */
  import { onMount } from 'svelte';
  import AccountMenu from './AccountMenu.svelte';
  import { app } from '$lib/client/state.svelte.js';
  import { switchMode } from '$lib/client/router.svelte.js';

  const MODES = ['finder', 'library'];
  const mode = $derived(app.view === 'library' ? 'library' : 'finder');

  let header;
  let indicator;

  /* The app's segmented control: equal tracks, and the selected pill is its own layer slid by
     index, so a percentage translate is exactly one track. The first placement snaps rather
     than slides in from the left. */
  $effect(() => {
    if (!indicator) return;
    const index = MODES.indexOf(mode);
    if (!indicator.dataset.placed) {
      indicator.style.transition = 'none';
      indicator.dataset.placed = 'true';
      requestAnimationFrame(() => requestAnimationFrame(() => { indicator.style.transition = ''; }));
    }
    indicator.style.transform = `translateX(${index * 100}%)`;
  });

  onMount(() => {
    const publish = () => document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
    publish();
    if (window.ResizeObserver) {
      const observer = new ResizeObserver(publish);
      observer.observe(header);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', publish);
    return () => window.removeEventListener('resize', publish);
  });
</script>

<header class="header-nav" id="siteHeader" bind:this={header}>
  <a href="/" class="header-nav-logo" aria-label="OfferLab home" id="siteHeaderLogo" data-sveltekit-reload>
    <img class="header-nav-logo-lockup" src="/assets/logo/offerlab-lockup-shine-white.svg" alt="OfferLab" width="108" height="24">
    <img class="header-nav-logo-mark" src="/assets/logo/offerlab-mark.svg?v=2" alt="OfferLab" width="28" height="28">
  </a>
  <div class="mode-switch" id="modeSwitch" role="group" aria-label="Mode">
    <span class="mode-switch-indicator" id="modeSwitchIndicator" aria-hidden="true" bind:this={indicator}></span>
    <button type="button" class="mode-switch-btn" data-mode="finder" aria-pressed={mode === 'finder'} onclick={() => switchMode('finder')}>Create</button>
    <button type="button" class="mode-switch-btn" data-mode="library" aria-pressed={mode === 'library'} onclick={() => switchMode('library')}>Showcase</button>
  </div>
  <AccountMenu />
</header>
