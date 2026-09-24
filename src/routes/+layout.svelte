<script>
  // The two stylesheets are global on purpose: styles.css is the design system the designer
  // maintains, and every component keeps its markup classes so those rules apply unchanged.
  import '$lib/styles/tailwind.css';
  import '$lib/styles/styles.css';
  import Header from '$lib/components/Header.svelte';

  let { children } = $props();
</script>

<Header />
{@render children()}
