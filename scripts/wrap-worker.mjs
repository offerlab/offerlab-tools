// Runs after `vite build`: puts src/worker.js (SvelteKit's fetch handler plus the crawl cron) in
// front of the handler adapter-cloudflare wrote to wrangler's `main`. See src/worker.js.
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, '.svelte-kit/cloudflare');
const main = join(out, '_worker.js');
const kit = join(out, 'kit-worker.js');
const entry = join(root, 'src/worker.js');

if (!existsSync(main)) throw new Error(`${main} is missing; run \`vite build\` first`);
// Idempotent: a second run finds the wrapper already in place and the adapter's output moved.
if (!readFileSync(main, 'utf8').includes("from './kit-worker.js'")) renameSync(main, kit);
copyFileSync(entry, main);

// The adapter's output is served as a static asset unless the assets ignore list names it.
const ignore = join(out, '.assetsignore');
const ignored = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
if (!ignored.split('\n').includes('kit-worker.js')) writeFileSync(ignore, `${ignored.trimEnd()}\nkit-worker.js\n`);

console.log('worker: _worker.js wraps kit-worker.js with the crawl cron');
