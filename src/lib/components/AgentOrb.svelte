<script>
  /**
   * The agent orb, OfferLab's AI identity: the app's shader (client/agent_orb.js) on a canvas that
   * fills this element. `state` sets the pace (idle | thinking | working | acting | still), never
   * the look. Reduced motion shows it still. WebGL missing or evicted leaves the element empty,
   * which the host should style as a plain disc.
   */
  import { onMount } from 'svelte';
  import { createOrb } from '$lib/client/agent_orb.js';

  let { state = 'idle', form = 'mesh', class: className = '' } = $props();

  let host;
  let canvas;
  let orb = null;

  function mount(retry = true) {
    try {
      orb = createOrb(canvas, { state, form });
    } catch (error) {
      console.warn('[agent-orb]', error);
      orb = null;
    }
    if (!orb) {
      // getContext answered null: usually momentary pressure on the context pool. One retry a beat later.
      if (retry) setTimeout(() => mount(false), 400);
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) orb.freeze(0);
    else orb.start();
  }

  onMount(() => {
    // Browsers evict the oldest WebGL context past a cap and never refuse a new one; asking for a
    // restore and remounting is what keeps a long-lived orb from going blank.
    const onLost = (event) => event.preventDefault();
    const onRestored = () => { orb?.stop(); orb = null; mount(false); };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    mount();
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      orb?.destroy();
      orb = null;
    };
  });

  $effect(() => {
    orb?.setParams({ state });
  });

  $effect(() => {
    if (orb && form) orb.morphTo(form);
  });
</script>

<span class="agent-orb {className}" bind:this={host} aria-hidden="true">
  <canvas class="agent-orb-canvas" bind:this={canvas}></canvas>
</span>
