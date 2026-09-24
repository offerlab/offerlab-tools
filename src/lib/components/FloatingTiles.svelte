<script>
  /** The landing page's floating brand tiles, with the cursor tilt and the exit animation. */
  import { app } from '$lib/client/state.svelte.js';
  import { tiles } from '$lib/client/tiles.svelte.js';
  import { tileTilt } from '$lib/client/actions/tile_tilt.js';

  const TILES = [
    // Top-left corner
    { n: 1, size: 'lg', file: 'magicspoon', alt: 'Magic Spoon' },
    { n: 2, size: 'md', file: 'jolie', alt: 'Jolie' },
    // Top-right corner
    { n: 3, size: 'md', file: 'monos', alt: 'Monos' },
    { n: 4, size: 'lg', file: 'flamingo_estate', alt: 'Flamingo Estate' },
    // Bottom-left corner
    { n: 5, size: 'md', file: 'wildone', alt: 'Wild One' },
    { n: 6, size: 'lg', file: 'fanttik', alt: 'Fanttik' },
    // Bottom-right corner
    { n: 7, size: 'lg', file: 'ezbomb', alt: 'EZBomb' },
    { n: 8, size: 'md', file: 'nkoclub', alt: 'NKO Club' }
  ];

  const active = $derived(app.view === 'landing' && !tiles.exiting);
</script>

<div class="floating-tiles" id="floatingTiles" class:whip-out={tiles.exiting} class:whip-out--fast={tiles.fast} use:tileTilt={{ active }}>
  {#each TILES as tile (tile.n)}
    <div class="tile tile-{tile.n} tile-{tile.size}">
      <img src="/brand-tile-media/brand-tile-{tile.file}.webp" alt={tile.alt}>
    </div>
  {/each}
</div>
