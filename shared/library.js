/**
 * GET /api/library, shared by the Pages function (functions/api/library.js) and the Express dev
 * server: the Showcase's bundles, live.
 *
 * The committed snapshot (library/snapshot.json) is the base. On top of it go the bundles the
 * store lists now that the snapshot does not know: a bundle published from OfferLab reaches the
 * store's public listing the moment it is put on the Online Store channel, and that listing is
 * what is read here, so a bundle shows in the Showcase as soon as it has a storefront URL. Each
 * new bundle is classified once and kept in D1; the store's listing decides which are still
 * shown, so a bundle taken off the channel leaves again.
 */
import {
  fetchStoreProducts, showcaseRecords, classifyBatch, applyClassification, carryClassification, finished, CLASSIFY_BATCH
} from './library-snapshot.js';

/* -------------------------------------------------------------------------- */
/* D1: one row per bundle classified since the snapshot                        */
/* -------------------------------------------------------------------------- */

function parse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function getLiveBundles(db) {
  const { results } = await db.prepare('SELECT record FROM library_bundles').all();
  return (results || []).map(row => parse(row.record)).filter(Boolean);
}

export async function putLiveBundle(db, bundle, now = Date.now()) {
  await db.prepare(
    `INSERT INTO library_bundles (id, store, handle, hash, record, published_at, classified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET hash = excluded.hash, record = excluded.record, published_at = excluded.published_at, classified_at = excluded.classified_at`
  ).bind(bundle.id, bundle.store, bundle.handle, bundle.hash, JSON.stringify(bundle), bundle.publishedAt || null, now).run();
}

/* -------------------------------------------------------------------------- */
/* The merge                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The snapshot's bundles plus the store's newer ones, newest first among the additions. A store
 * that cannot be read costs nothing but freshness: the snapshot and what D1 already holds go out.
 */
export async function liveLibrary({ snapshot, curation, db, apiKey, fetchImpl = fetch, log = () => {} }) {
  const inSnapshot = new Set(snapshot.bundles.map(bundle => bundle.id));
  const stored = db ? await getLiveBundles(db).catch(err => { log(`stored read failed: ${err.message}`); return []; }) : [];
  const storedById = new Map(stored.map(bundle => [bundle.id, bundle]));

  let additions;
  try {
    additions = [];
    for (const store of snapshot.stores) {
      const products = await fetchStoreProducts(store, { fetchImpl });
      additions.push(...showcaseRecords(store, products, curation).filter(record => !inSnapshot.has(record.id)));
    }
  } catch (err) {
    log(`store read failed, serving what is stored: ${err.message}`);
    additions = null;
  }

  let bundles;
  if (additions === null) {
    bundles = stored.filter(bundle => !inSnapshot.has(bundle.id));
  } else {
    const pending = [];
    bundles = additions.map(record => {
      const before = storedById.get(record.id);
      if (before && before.hash === record.hash && before.category) return carryClassification(record, before);
      pending.push(record);
      return record;
    });
    for (let i = 0; i < pending.length; i += CLASSIFY_BATCH) {
      const batch = pending.slice(i, i + CLASSIFY_BATCH);
      let results = [];
      if (apiKey) {
        results = await classifyBatch(batch, { apiKey, fetchImpl }).catch(err => { log(`classify failed: ${err.message}`); return []; });
      }
      const byHandle = new Map((results || []).map(result => [result.handle, result]));
      for (const record of batch) {
        const result = byHandle.get(record.handle);
        const index = bundles.findIndex(bundle => bundle.id === record.id);
        bundles[index] = applyClassification(record, result);
        // Only a classified bundle is remembered; an unclassified one is tried again next time.
        if (db && result) await putLiveBundle(db, bundles[index]).catch(err => log(`store write failed: ${err.message}`));
      }
    }
    bundles.sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
  }

  return {
    ...snapshot,
    liveAt: new Date().toISOString(),
    bundles: [...bundles.map(finished), ...snapshot.bundles]
  };
}

/** @returns {Promise<{status:number, body:unknown}>} */
export async function handleLibraryRequest({ method, snapshot, curation, db, apiKey, fetchImpl, log }) {
  if (method !== 'GET' && method !== 'HEAD') return { status: 405, body: { error: 'Method not allowed' } };
  if (!snapshot) return { status: 500, body: { error: 'No snapshot' } };
  try {
    return { status: 200, body: await liveLibrary({ snapshot, curation, db, apiKey, fetchImpl, log }) };
  } catch (err) {
    log?.(`failed: ${err.message}`);
    return { status: 200, body: snapshot };
  }
}
