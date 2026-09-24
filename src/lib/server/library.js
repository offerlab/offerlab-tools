/**
 * GET /api/library (src/routes/api/library/+server.js): the Showcase's bundles.
 *
 * D1 holds every bundle (library_bundles), seeded from the committed snapshot
 * (static/library/snapshot.json) by the first sync. A read is the table alone, so it answers in
 * the time of one query. A sync (the Worker's cron each minute, and a read with `?sync=1`, which
 * is what the open Showcase polls) brings the table up to the store's public listing: a bundle
 * published from OfferLab reaches that listing the moment it is put on the Online Store channel,
 * so it shows in the Showcase as soon as it has a storefront URL. A new bundle is classified once
 * and kept; one the store stops listing is dated unlisted and left out until it is listed again.
 * Without a database (or a store that cannot be read) the snapshot and the additions still go
 * out, only nothing is remembered.
 */
import {
  fetchStoreProducts, showcaseRecords, classifyBatch, applyClassification, carryClassification, finished, CLASSIFY_BATCH
} from '$lib/shared/library-snapshot.js';

/* -------------------------------------------------------------------------- */
/* D1: one row per bundle                                                      */
/* -------------------------------------------------------------------------- */

function parse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Every stored bundle, listed or not, as { ...record, unlistedAt }. */
export async function getLibraryBundles(db) {
  const { results } = await db.prepare('SELECT record, unlisted_at FROM library_bundles').all();
  return (results || []).flatMap(row => {
    const record = parse(row.record);
    return record ? [{ ...record, unlistedAt: row.unlisted_at }] : [];
  });
}

function upsert(db, bundle, now) {
  const { unlistedAt: _u, classifiedNow: _c, ...record } = finished(bundle);
  return db.prepare(
    `INSERT INTO library_bundles (id, store, handle, hash, record, published_at, classified_at, unlisted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET hash = excluded.hash, record = excluded.record, published_at = excluded.published_at, classified_at = excluded.classified_at, unlisted_at = NULL`
  ).bind(bundle.id, bundle.store, bundle.handle, bundle.hash, JSON.stringify(record), bundle.publishedAt || null, now);
}

export async function putLibraryBundle(db, bundle, now = Date.now()) {
  await upsert(db, bundle, now).run();
}

/** Writes many at once; D1 and the SQLite adapter both take a batch. */
async function putLibraryBundles(db, bundles, now = Date.now()) {
  const statements = bundles.map(bundle => upsert(db, bundle, now));
  if (statements.length) await db.batch(statements);
}

async function markUnlisted(db, ids, now = Date.now()) {
  if (!ids.length) return;
  await db.batch(ids.map(id => db.prepare('UPDATE library_bundles SET unlisted_at = ? WHERE id = ? AND unlisted_at IS NULL').bind(now, id)));
}

/* -------------------------------------------------------------------------- */
/* The sync                                                                    */
/* -------------------------------------------------------------------------- */

/** Classifies the records that need it, in batches; stored answers are carried over. */
async function classified(records, known, { apiKey, fetchImpl, log }) {
  const out = [];
  const pending = [];
  for (const record of records) {
    const before = known.get(record.id);
    if (before && before.hash === record.hash && before.category) out.push(carryClassification(record, before));
    else pending.push(record);
  }
  for (let i = 0; i < pending.length; i += CLASSIFY_BATCH) {
    const batch = pending.slice(i, i + CLASSIFY_BATCH);
    let results = [];
    if (apiKey) {
      results = await classifyBatch(batch, { apiKey, fetchImpl }).catch(err => { log(`classify failed: ${err.message}`); return []; });
    }
    const byHandle = new Map((results || []).map(result => [result.handle, result]));
    for (const record of batch) {
      const result = byHandle.get(record.handle);
      // Only a classified bundle is remembered; an unclassified one is tried again next time.
      out.push({ ...applyClassification(record, result), classifiedNow: !!result });
    }
  }
  return out;
}

const newestFirst = (a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''));

/**
 * The Showcase's bundles, newest first. With a database: the table, seeded from the snapshot,
 * synced with the store's listing. Without one: the snapshot plus whatever the store lists on
 * top of it.
 */
export async function liveLibrary({ snapshot, curation, db, apiKey, fetchImpl = fetch, log = () => {} }) {
  let stored = [];
  if (db) {
    stored = await getLibraryBundles(db).catch(err => { log(`stored read failed: ${err.message}`); return null; });
    if (stored === null) {
      db = null;
      stored = [];
    }
  }
  const storedById = new Map(stored.map(bundle => [bundle.id, bundle]));

  // The snapshot seeds the table once; after that the table is the record.
  if (db) {
    const missing = snapshot.bundles.filter(bundle => !storedById.has(bundle.id));
    if (missing.length) {
      await putLibraryBundles(db, missing).catch(err => log(`seed failed: ${err.message}`));
      for (const bundle of missing) storedById.set(bundle.id, { ...bundle, unlistedAt: null });
      log(`seeded ${missing.length} bundles from the snapshot`);
    }
  } else {
    for (const bundle of snapshot.bundles) if (!storedById.has(bundle.id)) storedById.set(bundle.id, { ...bundle, unlistedAt: null });
  }

  let listed = null;
  try {
    listed = [];
    for (const store of snapshot.stores) {
      const products = await fetchStoreProducts(store, { fetchImpl });
      listed.push(...showcaseRecords(store, products, curation));
    }
  } catch (err) {
    // Not an empty listing: an unreadable store must not unlist everything.
    log(`store read failed, serving what is stored: ${err.message}`);
    listed = null;
  }

  let bundles;
  if (listed === null) {
    bundles = [...storedById.values()].filter(bundle => !bundle.unlistedAt);
  } else {
    bundles = await classified(listed, storedById, { apiKey, fetchImpl, log });
    if (db) {
      // Written: a bundle classified on this read, and a carried one that was dated unlisted and
      // is listed again. An unclassified one is not remembered, so it is tried again next time.
      const changed = bundles.filter(bundle => {
        const before = storedById.get(bundle.id);
        const carried = !bundle.classifiedNow && before?.category && before.hash === bundle.hash;
        return bundle.classifiedNow || (carried && before.unlistedAt);
      });
      await putLibraryBundles(db, changed).catch(err => log(`store write failed: ${err.message}`));
      const listedIds = new Set(bundles.map(bundle => bundle.id));
      await markUnlisted(db, [...storedById.keys()].filter(id => !listedIds.has(id) && !storedById.get(id).unlistedAt))
        .catch(err => log(`unlist failed: ${err.message}`));
    }
  }

  bundles.sort(newestFirst);
  return {
    ...snapshot,
    liveAt: new Date().toISOString(),
    bundles: bundles.map(bundle => {
      const { unlistedAt: _u, classifiedNow: _c, ...record } = finished(bundle);
      return record;
    })
  };
}

/**
 * The table as it stands, listed bundles only, newest first. Before the first sync (or without a
 * database) it is the snapshot, in the same order.
 */
export async function readLibrary({ snapshot, db, log = () => {} }) {
  let stored = [];
  if (db) stored = await getLibraryBundles(db).catch(err => { log(`stored read failed: ${err.message}`); return []; });
  const bundles = stored.length ? stored.filter(bundle => !bundle.unlistedAt) : [...snapshot.bundles];
  bundles.sort(newestFirst);
  return {
    ...snapshot,
    readAt: new Date().toISOString(),
    bundles: bundles.map(bundle => {
      const { unlistedAt: _u, ...record } = bundle;
      return record;
    })
  };
}

/** A tag that changes when the set of bundles or any bundle's copy does; the ETag and the poll compare it. */
export function libraryTag(library) {
  let h = 5381;
  for (const bundle of library.bundles) {
    for (const ch of `${bundle.id}:${bundle.hash || ''}|`) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
  }
  return `"${library.bundles.length}-${(h >>> 0).toString(36)}"`;
}

/** @returns {Promise<{status:number, body:unknown}>} */
export async function handleLibraryRequest({ method, snapshot, curation, db, apiKey, fetchImpl, log, sync = false }) {
  if (method !== 'GET' && method !== 'HEAD') return { status: 405, body: { error: 'Method not allowed' } };
  if (!snapshot) return { status: 500, body: { error: 'No snapshot' } };
  try {
    // Without a database there is nothing to read back, so a read is the live merge.
    const body = sync || !db
      ? await liveLibrary({ snapshot, curation, db, apiKey, fetchImpl, log })
      : await readLibrary({ snapshot, db, log });
    return { status: 200, body };
  } catch (err) {
    log?.(`failed: ${err.message}`);
    return { status: 200, body: snapshot };
  }
}
