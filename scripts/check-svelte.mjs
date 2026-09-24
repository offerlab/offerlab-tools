#!/usr/bin/env node
// Compiles .svelte and .svelte.js files with the Svelte 5 compiler (runes mode) and reports
// errors, without a Vite build: `node scripts/check-svelte.mjs src/lib/components/*.svelte`.
import { readFileSync } from 'node:fs';
import { compile, compileModule } from 'svelte/compiler';

let failed = false;
for (const file of process.argv.slice(2)) {
  const source = readFileSync(file, 'utf8');
  try {
    if (file.endsWith('.svelte.js')) compileModule(source, { filename: file, generate: 'client' });
    else compile(source, { filename: file, runes: true, generate: 'client' });
    console.log(`ok   ${file}`);
  } catch (err) {
    failed = true;
    console.log(`FAIL ${file}\n  ${err.message}${err.start ? ` (line ${err.start.line})` : ''}`);
  }
}
process.exit(failed ? 1 : 0);
