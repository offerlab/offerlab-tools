<script>
  /**
   * An inline SVG from the icon library (icons.js). Library icons are 24px and paint with
   * currentColor; `size` sets width/height and --icon-rendered for the stroke math.
   */
  import { icon } from '$lib/client/icons.js';

  let { name, class: className = '', size = undefined } = $props();
</script>

{@html icon(name, { class: className, size })}
