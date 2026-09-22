/**
 * The /api/crawl routes, shared by the Pages function (functions/api/crawl/[[path]].js) and the
 * Express dev server. Every route spends or reveals crawl work, so each needs
 * `Authorization: Bearer <CRAWL_SECRET>`; without the secret set the crawl is off.
 *
 *   GET  /api/crawl                    queue counts, searches today, recent rows
 *   POST /api/crawl  { domains, refresh }   queue domains at depth 0
 *   POST /api/crawl/next               run the next step: one search or one expansion
 */
import { enqueueSeeds, claimNext, runStep, crawlStatus, crawlSettings } from './crawl.js';
import { httpApi } from './search.js';

/**
 * @param {object} req
 * @param {string} req.method
 * @param {string} req.path           after /api/crawl, without slashes: '' or 'next'
 * @param {string|null} req.authorization
 * @param {unknown} req.body          parsed JSON, or null
 * @param {object|null} req.db        the D1 binding
 * @param {object} req.env            CRAWL_SECRET, TYPESAFE_API_KEY, CRAWL_API_ORIGIN, caps
 * @param {string} req.origin         this deployment's origin; the search calls its own /api/*
 * @returns {Promise<{status:number, body?:unknown}>}
 */
export async function handleCrawlRequest({ method, path, authorization, body, db, env, origin }) {
  if (!env.CRAWL_SECRET) return { status: 503, body: { error: 'The crawl is off: CRAWL_SECRET is not set' } };
  if (authorization !== `Bearer ${env.CRAWL_SECRET}`) return { status: 401, body: { error: 'Unauthorized' } };
  if (!db) return { status: 503, body: { error: 'No database bound' } };

  const settings = crawlSettings(env);

  if (path === '' && method === 'GET') return { status: 200, body: await crawlStatus(db, settings) };

  if (path === '' && method === 'POST') {
    const domains = Array.isArray(body?.domains) ? body.domains : [];
    if (!domains.length) return { status: 400, body: { error: 'Expected { domains: [...] }' } };
    const queued = await enqueueSeeds(db, domains, { refresh: body.refresh === true });
    return { status: 200, body: { queued } };
  }

  if (path === 'next' && method === 'POST') {
    const row = await claimNext(db, settings);
    if (!row) return { status: 200, body: { idle: true } };
    if (row.capped) return { status: 200, body: { capped: true, dailyLimit: settings.dailyLimit } };
    const api = httpApi(env.CRAWL_API_ORIGIN || origin);
    return { status: 200, body: await runStep(row, { db, api, jevKey: env.TYPESAFE_API_KEY || null, settings }) };
  }

  return { status: 404, body: { error: 'No such crawl route' } };
}
