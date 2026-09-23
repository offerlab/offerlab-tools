import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * SvelteKit sets build.cssMinify from build.minify, which in Vite 8 means Lightning CSS. Lightning
 * CSS folds a `backdrop-filter` followed by `-webkit-backdrop-filter` into the prefixed one alone
 * (the later declaration wins and it never adds the unprefixed form back), which strips every blur
 * in styles.css for any browser but Safari. esbuild keeps both declarations, so this plugin runs
 * after SvelteKit's config hook and puts it back in charge of CSS minification.
 */
const cssMinifyWithEsbuild = {
  name: 'collab-finder:css-minify-esbuild',
  enforce: 'post',
  config: () => ({ build: { cssMinify: 'esbuild' } })
};

export default defineConfig({
  plugins: [tailwindcss(), sveltekit(), cssMinifyWithEsbuild],
  test: {
    include: ['tests/unit/**/*.test.js'],
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 60000
  }
});
