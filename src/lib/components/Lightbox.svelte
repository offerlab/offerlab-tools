<script>
  /**
   * The Showcase's lightbox: a bundle's card that flies up from its tile, turned away, and turns
   * to face you. Rendered inside the section but moved to the body on mount, out of the section's
   * stacking context, which would keep it under the fixed header. The card's content and its
   * flight are imperative: the lift origin is measured off the freshly built card.
   */
  import { onMount } from 'svelte';
  import { icon } from '$lib/client/icons.js';
  import { coverUrl, escape, findBundle, label, logoFor, LIGHTBOX_COVER_WIDTH, TILE_COVER_WIDTH } from '$lib/client/showcase.svelte.js';
  import { board, isMobile } from '$lib/client/showcase-board.js';

  const FLIP_MS = 650;

  let lightbox;
  let card;
  let lastTile = null;
  let closing = 0;

  onMount(() => {
    document.body.appendChild(lightbox);
  });

  export function open(id, tile) {
    const bundle = findBundle(id);
    if (!bundle) return;
    lastTile = tile;
    card.innerHTML = `
    <button type="button" class="icon-button library-lightbox-close" data-action="library-close" aria-label="Close">${icon('cross-large', { size: 16 })}</button>
    <div class="library-lightbox-cover"><img src="${escape(coverUrl(bundle.cover, TILE_COVER_WIDTH))}" alt=""></div>
    <div class="library-lightbox-body">
      <p class="library-lightbox-collab">
        <span class="library-lightbox-stack" aria-hidden="true">${bundle.brands.map(brandMark).join('')}</span>
        <span class="library-lightbox-names">${bundle.brands.map(escape).join(' x ')}</span>
      </p>
      <h2 class="library-lightbox-title" id="libraryLightboxTitle">${escape(bundle.name)}</h2>
      <ul class="library-lightbox-chips"><li>${escape(label(bundle.category))}</li></ul>
      ${bundle.products.length ? `<p class="library-lightbox-products">${escape(bundle.products.join(', '))}</p>` : ''}
      <a class="btn btn--lg btn--elevated library-lightbox-open" href="${escape(bundle.pdpUrl)}" target="_blank" rel="noopener">
        Open the bundle ${icon('arrow-up-right', { size: 16 })}
      </a>
    </div>`;
    // The card flies with the cover the tile already has; the sharp one replaces it once it lands.
    const sharp = new Image();
    sharp.onload = () => { if (lastTile === tile) card.querySelector('.library-lightbox-cover img').src = sharp.src; };
    sharp.src = coverUrl(bundle.cover, LIGHTBOX_COVER_WIDTH);
    clearTimeout(closing);
    lightbox.classList.remove('hidden', 'is-closing');
    // The card starts where the cover stood, turned away, and flies forward as it turns to face you.
    const from = liftOrigin(tile);
    if (from) {
      card.style.transition = 'none';
      card.style.transform = from;
      void card.offsetWidth;
      card.style.transition = '';
      tile.classList.add('is-lifted');
    }
    requestAnimationFrame(() => {
      lightbox.classList.add('is-open');
      card.style.transform = '';
    });
    lightbox.querySelector('.library-lightbox-open').focus();
  }

  export function close() {
    if (lightbox.classList.contains('hidden') || lightbox.classList.contains('is-closing')) return;
    const tile = lastTile;
    const to = liftOrigin(tile);
    lightbox.classList.remove('is-open');
    lightbox.classList.add('is-closing');
    if (to) card.style.transform = to;
    closing = setTimeout(() => {
      lightbox.classList.add('hidden');
      lightbox.classList.remove('is-closing');
      card.style.transform = '';
      tile?.classList.remove('is-lifted');
      // The tile may have been dropped out of the window while the lightbox was open.
      (tile?.isConnected ? tile : board.viewport).focus();
    }, to ? FLIP_MS : 250);
  }

  /** A brand's avatar from the team database, or its initial where the team has none. */
  function brandMark(name) {
    const logo = logoFor(name);
    return logo
      ? `<span class="library-lightbox-avatar"><img src="/library/${escape(logo)}" alt=""></span>`
      : `<span class="library-lightbox-avatar">${escape(name.trim().charAt(0).toUpperCase())}</span>`;
  }

  /** The transform that puts the card's cover over the tile, turned 30° away, or null on a phone. */
  function liftOrigin(tile) {
    if (isMobile() || !tile?.isConnected) return null;
    const t = tile.getBoundingClientRect();
    const cover = card.querySelector('.library-lightbox-cover').getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const scale = t.width / cover.width;
    return `perspective(1400px) translate(${t.left - c.left}px, ${t.top - c.top}px) scale(${scale.toFixed(4)}) rotateY(-42deg)`;
  }

  function onClick(event) {
    if (event.target === lightbox || event.target.closest('[data-action="library-close"]')) close();
  }

  function onKeydown(event) {
    if (lightbox.classList.contains('hidden')) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'Tab') trapFocus(event);
  }

  function trapFocus(event) {
    const focusable = [...lightbox.querySelectorAll('a[href], button')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
</script>

<svelte:document onkeydown={onKeydown} />

<!-- Focus goes to the card's open link, and the Tab trap keeps it inside; the dialog itself is a backdrop. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
<div class="library-lightbox hidden" id="libraryLightbox" role="dialog" aria-modal="true" aria-labelledby="libraryLightboxTitle" bind:this={lightbox} onclick={onClick}>
  <div class="library-lightbox-card" bind:this={card}></div>
</div>
