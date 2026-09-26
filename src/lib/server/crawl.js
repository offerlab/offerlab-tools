/**
 * The server-side crawl: searches domains without a browser and grows the graph from them.
 *
 * A domain moves through the queue in two steps, each its own request so each stays inside the
 * Workers subrequest limit: `searching` runs the finder's search (or reuses a stored one), then
 * `expanding` asks Jev which recommended brands are worth a search of their own and queues those
 * one level deeper. Code owns every cap: depth, how many candidates one search may queue, and
 * searches per day. Schema: migrations/0002_crawl_queue.sql.
 */
import * as store from './db.js';
import { discoverComplementaryBrands, searchRecord, brandDomain } from '$lib/shared/search.js';
import { askJev, candidateState, judge } from '$lib/shared/jev.js';

export const CRAWL_DEFAULTS = {
  maxDepth: 1,            // seeds are expanded; what they queue is searched but not expanded
  expandPerSearch: 5,     // candidates one search may queue
  dailyLimit: 150,        // searches started in any 24 hours
  maxAttempts: 2,         // per step, then the row fails
  minPartners: 5,         // a search with fewer is not worth expanding
  staleAfterMs: 10 * 60 * 1000
};

const DAY_MS = 24 * 60 * 60 * 1000;
const SEED_PRIORITY = 1000;
const ACTIVE = ['queued', 'searching', 'expand', 'expanding'];

/** Caps from the environment (CRAWL_MAX_DEPTH, CRAWL_EXPAND_PER_SEARCH, CRAWL_DAILY_LIMIT). */
export function crawlSettings(env = {}) {
  const int = (value, fallback) => (Number.isFinite(parseInt(value, 10)) ? parseInt(value, 10) : fallback);
  return {
    ...CRAWL_DEFAULTS,
    maxDepth: int(env.CRAWL_MAX_DEPTH, CRAWL_DEFAULTS.maxDepth),
    expandPerSearch: int(env.CRAWL_EXPAND_PER_SEARCH, CRAWL_DEFAULTS.expandPerSearch),
    dailyLimit: int(env.CRAWL_DAILY_LIMIT, CRAWL_DEFAULTS.dailyLimit)
  };
}

/**
 * Queues domains someone asked for at depth 0. A domain already in flight is left alone; a
 * finished one is queued again, and reuses its stored search unless `refresh` is set.
 */
export async function enqueueSeeds(db, domains, { refresh = false } = {}, now = Date.now()) {
  const keys = [...new Set(domains.map(store.canonicalDomain).filter(Boolean))];
  const verdict = JSON.stringify({ reason: 'seed', refresh });
  const statements = keys.map(key => db.prepare(
    `INSERT INTO crawl_queue (domain, depth, source_domain, status, priority, verdict, attempts, created_at, updated_at)
     VALUES (?, 0, NULL, 'queued', ?, ?, 0, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET depth = 0, source_domain = NULL, status = 'queued', priority = excluded.priority,
       verdict = excluded.verdict, attempts = 0, updated_at = excluded.updated_at
     WHERE crawl_queue.status NOT IN (${ACTIVE.map(() => '?').join(', ')})`
  ).bind(key, SEED_PRIORITY, verdict, now, now, ...ACTIVE));
  if (statements.length) await db.batch(statements);
  return keys;
}

/**
 * Claims the next step, or null when there is none. Expansions go first: they are cheap and
 * unlock more work. A search is only claimed while the daily cap has room. A step whose worker
 * went quiet past `staleAfterMs` is claimed again.
 */
export async function claimNext(db, settings, now = Date.now()) {
  const stale = now - settings.staleAfterMs;
  const expansion = await claim(db, 'expand', 'expanding', stale, now);
  if (expansion) return expansion;

  // The daily count reads a row per search in the last day, so it waits until there is a search
  // to claim: an idle queue costs the cron's tick one row.
  if (!(await db.prepare(NEXT('queued', 'searching')).bind(stale).first())) return null;
  const searched = await db.prepare('SELECT COUNT(*) AS n FROM crawl_queue WHERE searched_at > ?').bind(now - DAY_MS).first();
  if ((searched?.n || 0) >= settings.dailyLimit) return { capped: true };
  return claim(db, 'queued', 'searching', stale, now);
}

// The next row that is `ready`, or whose `stalled` step went quiet before the bound time. Each
// side is its own crawl_queue_next lookup already in claim order, so the pick reads a row or two;
// one WHERE with an OR read every row in either status and sorted them.
const NEXT = (ready, stalled) => `
  SELECT domain, depth, priority, created_at FROM (
    SELECT * FROM (SELECT domain, depth, priority, created_at FROM crawl_queue WHERE status = '${ready}' ORDER BY depth, priority DESC, created_at LIMIT 1)
    UNION ALL
    SELECT * FROM (SELECT domain, depth, priority, created_at FROM crawl_queue WHERE status = '${stalled}' AND started_at < ? ORDER BY depth, priority DESC, created_at LIMIT 1)
  ) ORDER BY depth, priority DESC, created_at LIMIT 1`;

// Claiming moves the row into the `stalled` status: a search or an expansion under way.
async function claim(db, ready, stalled, stale, now) {
  const searchedAt = stalled === 'searching' ? now : null;
  return db.prepare(
    `UPDATE crawl_queue SET status = ?, attempts = attempts + 1, started_at = ?, updated_at = ?,
       searched_at = COALESCE(?, searched_at)
     WHERE domain = (SELECT domain FROM (${NEXT(ready, stalled)}))
     RETURNING *`
  ).bind(stalled, now, now, searchedAt, stale).first();
}

async function finish(db, domain, status, outcome, now = Date.now()) {
  const reset = ['expand', 'queued'].includes(status) ? ', attempts = 0' : '';
  await db.prepare(`UPDATE crawl_queue SET status = ?, outcome = ?, updated_at = ?${reset} WHERE domain = ?`)
    .bind(status, JSON.stringify(outcome), now, domain).run();
}

/**
 * Runs one claimed step. `ctx`: { db, api, jevKey, settings }. Answers what happened, for the
 * scheduler's log and the status route.
 */
export async function runStep(row, ctx) {
  const step = row.status === 'expanding' ? expand : search;
  try {
    return await step(row, ctx);
  } catch (err) {
    const retry = row.attempts < ctx.settings.maxAttempts;
    const status = retry ? (row.status === 'expanding' ? 'expand' : 'queued') : 'failed';
    await ctx.db.prepare('UPDATE crawl_queue SET status = ?, outcome = ?, updated_at = ? WHERE domain = ?')
      .bind(status, JSON.stringify({ error: err.message }), Date.now(), row.domain).run();
    return { domain: row.domain, step: row.status, status, error: err.message };
  }
}

async function search(row, { db, api, settings }) {
  const refresh = parseJson(row.verdict)?.refresh === true;
  let stored = refresh ? null : await store.getSearch(db, row.domain, { products: 0 });
  const reused = stored?.type === 'results';

  if (!reused) {
    const [feedback, knownPartners, frequentBrands] = await Promise.all([store.listFeedback(db), store.listKnownPartners(db, row.domain), store.listFrequentBrands(db)]);
    const results = await discoverComplementaryBrands(row.domain, { api, feedback, knownPartners, frequentBrands });
    await store.putSearch(db, row.domain, searchRecord(results, `crawl-${Date.now()}`, { keepCatalogs: true, source: 'crawl' }));
    stored = await store.getSearch(db, row.domain, { products: 0 });
  }

  // Verification: a search only counts, and only expands, when it found enough partners.
  const partners = stored?.brands?.length || 0;
  const outcome = {
    reused,
    partners,
    withCatalog: (stored?.brands || []).filter(b => b.catalog?.count > 0).length,
    serpApiOutOfCredits: Boolean(stored?.serpApiOutOfCredits)
  };
  const status = partners < settings.minPartners ? 'failed' : (row.depth < settings.maxDepth ? 'expand' : 'done');
  if (status === 'failed') outcome.error = `found ${partners} partners, fewer than ${settings.minPartners}`;
  await finish(db, row.domain, status, outcome);
  return { domain: row.domain, step: 'search', status, ...outcome };
}

async function expand(row, { db, jevKey, settings }) {
  if (!jevKey) {
    const outcome = { expanded: false, error: 'TYPESAFE_API_KEY is not set' };
    await finish(db, row.domain, 'done', outcome);
    return { domain: row.domain, step: 'expand', status: 'done', ...outcome };
  }

  const stored = await store.getSearch(db, row.domain, { products: 8 });
  const candidates = await newCandidates(db, row.domain, stored?.brands || []);
  const judged = await Promise.all(candidates.map(async candidate => {
    if (!(candidate.catalog?.count > 0)) return { candidate, crawl: false, score: 0, reason: 'no catalog', answers: null };
    const verdict = judge(await askJev(jevKey, candidateState(stored.searchedBrand, candidate)));
    return { candidate, ...verdict };
  }));

  const passed = judged.filter(v => v.crawl).sort((a, b) => b.score - a.score);
  const queued = passed.slice(0, settings.expandPerSearch);
  const now = Date.now();
  const statements = judged.map(v => {
    const isQueued = queued.includes(v);
    const reason = isQueued ? v.reason : (v.crawl ? `over the cap of ${settings.expandPerSearch} per search` : v.reason);
    return db.prepare(
      `INSERT INTO crawl_queue (domain, depth, source_domain, status, priority, verdict, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET depth = excluded.depth, source_domain = excluded.source_domain,
         status = excluded.status, priority = excluded.priority, verdict = excluded.verdict, updated_at = excluded.updated_at
       WHERE crawl_queue.status = 'skipped' AND excluded.status = 'queued'`
    ).bind(v.candidate.domain, row.depth + 1, row.domain, isQueued ? 'queued' : 'skipped', v.score,
      JSON.stringify({ reason, score: v.score, answers: v.answers }), now, now);
  });
  if (statements.length) await db.batch(statements);

  const outcome = { expanded: true, judged: judged.length, queued: queued.map(v => v.candidate.domain) };
  await finish(db, row.domain, 'done', outcome);
  return { domain: row.domain, step: 'expand', status: 'done', ...outcome };
}

// Recommendations not yet searched and not already queued, each keyed by its canonical domain.
async function newCandidates(db, searchedDomain, brands) {
  const byDomain = new Map();
  for (const brand of brands) {
    const domain = store.canonicalDomain(brandDomain(brand.url || ''));
    if (domain && domain !== searchedDomain && !byDomain.has(domain)) byDomain.set(domain, { ...brand, domain });
  }
  const domains = [...byDomain.keys()];
  if (!domains.length) return [];
  const marks = domains.map(() => '?').join(', ');
  const [searched, queued] = await Promise.all([
    db.prepare(`SELECT domain FROM searches WHERE status = 'results' AND domain IN (${marks})`).bind(...domains).all(),
    db.prepare(`SELECT domain FROM crawl_queue WHERE status != 'skipped' AND domain IN (${marks})`).bind(...domains).all()
  ]);
  const known = new Set([...searched.results, ...queued.results].map(r => r.domain));
  return [...byDomain.values()].filter(brand => !known.has(brand.domain));
}

/** Counts by status, searches in the last day, and the most recently touched rows. */
export async function crawlStatus(db, settings, { limit = 25 } = {}, now = Date.now()) {
  const [counts, searched, recent] = await Promise.all([
    db.prepare('SELECT status, COUNT(*) AS n FROM crawl_queue GROUP BY status').all(),
    db.prepare('SELECT COUNT(*) AS n FROM crawl_queue WHERE searched_at > ?').bind(now - DAY_MS).first(),
    db.prepare('SELECT * FROM crawl_queue ORDER BY updated_at DESC LIMIT ?').bind(limit).all()
  ]);
  return {
    counts: Object.fromEntries(counts.results.map(r => [r.status, r.n])),
    searchesToday: searched?.n || 0,
    settings,
    recent: recent.results.map(r => ({ ...r, verdict: parseJson(r.verdict), outcome: parseJson(r.outcome) }))
  };
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
