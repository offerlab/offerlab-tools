// Builds static/library/snapshot.json: every published bundle on the demo stores, read from their
// public catalogs and classified once. The library reads that file first; /api/library lays the
// bundles published since over it (src/lib/server/library.js). A guest at a booth needs no
// OfferLab account and the deployed finder holds no key (OL-4032).
//   GEMINI_API_KEY=... npm run build:library
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  CATEGORIES, CLASSIFY_BATCH, fetchStoreProducts, showcaseRecords, classifyBatch, applyClassification,
  carryClassification, finished
} from '../src/lib/shared/library-snapshot.js';

const root = new URL('..', import.meta.url).pathname;
const STORES = JSON.parse(readFileSync(join(root, 'static/library/stores.json'), 'utf8'));
const CURATION = JSON.parse(readFileSync(join(root, 'static/library/curation.json'), 'utf8'));
const OUT = join(root, 'static/library/snapshot.json');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY is not set. Refusing to write an unclassified snapshot.');
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { bundles: [] };
const known = new Map(previous.bundles.map(bundle => [bundle.id, bundle]));

const report = { products: 0, kept: 0, reused: 0, classified: 0 };
const records = [];

// One unreachable store fails the run rather than writing a snapshot that quietly lost a store.
for (const store of STORES) {
  const products = await fetchStoreProducts(store);
  report.products += products.length;
  records.push(...showcaseRecords(store, products, CURATION));
}
report.kept = records.length;

const pending = [];
const bundles = records.map(record => {
  const before = known.get(record.id);
  // Reuse keeps the model's answer; the teams are re-read from the tags, which are ours.
  if (before && before.hash === record.hash && before.category) {
    report.reused++;
    return carryClassification(record, before);
  }
  pending.push(record);
  return record;
});

for (let i = 0; i < pending.length; i += CLASSIFY_BATCH) {
  const batch = pending.slice(i, i + CLASSIFY_BATCH);
  const results = await classifyBatch(batch, { apiKey });
  const byHandle = new Map((results || []).map(result => [result.handle, result]));
  for (const record of batch) {
    const index = bundles.findIndex(bundle => bundle.id === record.id);
    bundles[index] = applyClassification(record, byHandle.get(record.handle));
    report.classified++;
  }
  console.log(`classified ${Math.min(i + CLASSIFY_BATCH, pending.length)}/${pending.length}`);
}

bundles.sort((a, b) => a.store.localeCompare(b.store) || a.handle.localeCompare(b.handle));

const snapshot = {
  generatedAt: new Date().toISOString(),
  stores: STORES,
  categories: CATEGORIES,
  bundles: bundles.map(finished)
};
writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');

console.log(`library/snapshot.json: ${bundles.length} bundles from ${STORES.length} store(s)`);
console.log(`  products seen ${report.products}, kept ${report.kept}`);
console.log(`  classified ${report.classified}, reused ${report.reused}`);
