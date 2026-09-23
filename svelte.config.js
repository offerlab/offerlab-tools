import adapter from '@sveltejs/adapter-cloudflare';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    // Builds .svelte-kit/cloudflare/_worker.js plus the static assets; wrangler.jsonc points at
    // both. platform.env (the D1 binding and the vars) is emulated in `vite dev` from the same file.
    adapter: adapter({
      platformProxy: { persist: true }
    })
  }
};

export default config;
