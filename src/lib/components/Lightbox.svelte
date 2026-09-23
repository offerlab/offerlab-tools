<script>
  /**
   * The Showcase's lightbox: a bundle's card that starts at the tile's size over the tile and turns
   * a full circle as it grows; closing is the plain move, straight back onto the shelf. Rendered
   * inside the section but moved to the body on mount, out of the section's stacking context,
   * which would keep it under the fixed header. The card's content and its flight are imperative:
   * the lift origin is measured off the freshly built card.
   */
  import { onMount } from 'svelte';
  import { icon } from '$lib/client/icons.js';
  import Icon from './Icon.svelte';
  import { coverUrl, escape, findBundle, label, logoFor, LIGHTBOX_COVER_WIDTH, TILE_COVER_WIDTH } from '$lib/client/showcase.svelte.js';
  import { board, isMobile } from '$lib/client/showcase-board.js';

  // Closing is the plainer move: the card scales back onto the shelf, no turn.
  const CLOSE_MS = 380;

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
    // The card starts at the tile's size where the cover stood and flies forward, turning a full
    // circle as it grows; the close control pops in last, once the card has landed.
    // Measured untransformed: the card's resting style is already scaled down.
    card.style.transition = 'none';
    card.style.transform = 'none';
    const from = liftOrigin(tile, { turn: true });
    if (from) {
      card.style.transformOrigin = from.origin;
      card.style.transform = from.transform;
      tile.classList.add('is-lifted');
    } else {
      card.style.transform = '';
    }
    void card.offsetWidth;
    card.style.transition = '';
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
    if (to) {
      card.style.transformOrigin = to.origin;
      card.style.transform = to.transform;
    }
    closing = setTimeout(() => {
      lightbox.classList.add('hidden');
      lightbox.classList.remove('is-closing');
      card.style.transform = '';
      card.style.transformOrigin = '';
      tile?.classList.remove('is-lifted');
      // The tile may have been dropped out of the window while the lightbox was open.
      (tile?.isConnected ? tile : board.viewport).focus();
    }, to ? CLOSE_MS : 250);
  }

  /** A brand's avatar from the team database, or its initial where the team has none. */
  function brandMark(name) {
    const logo = logoFor(name);
    return logo
      ? `<span class="library-lightbox-avatar"><img src="/library/${escape(logo)}" alt=""></span>`
      : `<span class="library-lightbox-avatar">${escape(name.trim().charAt(0).toUpperCase())}</span>`;
  }

  /**
   * The transform that puts the card's cover over the tile at the tile's size, about the cover's
   * center, and the origin that makes it so; turned a full circle away when `turn`. Null on a phone.
   */
  function liftOrigin(tile, { turn = false } = {}) {
    if (isMobile() || !tile?.isConnected) return null;
    const t = tile.getBoundingClientRect();
    const cover = card.querySelector('.library-lightbox-cover').getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const scale = t.width / cover.width;
    const ox = cover.left - c.left + cover.width / 2;
    const oy = cover.top - c.top + cover.height / 2;
    const tx = t.left + t.width / 2 - (c.left + ox);
    const ty = t.top + t.height / 2 - (c.top + oy);
    return {
      origin: `${ox.toFixed(1)}px ${oy.toFixed(1)}px`,
      transform: `perspective(1400px) translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${scale.toFixed(4)})${turn ? ' rotateY(-360deg)' : ''}`
    };
  }

  // Anywhere but the cover and the details is the backdrop, and the backdrop closes.
  function onClick(event) {
    if (event.target.closest('[data-action="library-close"]') || !event.target.closest('.library-lightbox-cover, .library-lightbox-body')) close();
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
  <!-- Beside the card, not in it: a transformed card is the containing block of anything fixed
       inside it, and the control would ride the flip, then jump. -->
  <button type="button" class="icon-button library-lightbox-close" data-action="library-close" aria-label="Close"><Icon name="cross-large" size={16} /></button>
</div>
